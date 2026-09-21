#!/usr/bin/env node
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { AGENT_DIR, findAgentDir, loadConfig, type LoadedConfig } from "./config/load.js";
import { Harness } from "./runtime/harness.js";
import { effectiveCli } from "./agents/presets.js";
import * as tmux from "./terminal/tmux.js";
import { chromeCommands } from "./terminal/chrome.js";
import { runPanel } from "./ui/panel-runner.js";
import { controlSocketPath, sendControl, startControlServer, stopControlServer } from "./runtime/control.js";
import { ProjectBoards } from "./runtime/project-boards.js";
import { BOARD_PAGE, exportFileName, snapshotHtml } from "./runtime/board-export.js";
import { BoardName, TEAM_BOARD, type Board } from "./protocol/index.js";

const TEMPLATE = resolve(dirname(fileURLToPath(import.meta.url)), "..", "templates", AGENT_DIR);

const USAGE = `crewmux — run Claude Code, Codex and other agent CLIs side by side in tmux, talking through one MCP bridge

  crewmux                             in any project: create .crewmux/ if missing, then start and attach
  crewmux up [role...] [--no-attach] [--fresh]
                                         start the harness + agents (default: roles with autostart) and attach;
                                         each role continues its last conversation unless --fresh
  crewmux down                        stop everything for this project
  crewmux open <role> [--fresh]       add a role while running (re-reads roles.yaml)   · tmux: Ctrl-b n
  crewmux close <role>                remove a role while running (resumable later)     · tmux: Ctrl-b X
  crewmux compact <role>|--all [--focus "…"]  compact conversations to save tokens  · tmux: Ctrl-b C
  crewmux restart <role> [--fresh]    reopen a role with its latest config             · tmux: Ctrl-b R
  crewmux status                      roles and whether they are running
  crewmux board [name] [--no-open]    print the board URL (default: team) and open a browser · tmux: Ctrl-b B
  crewmux board export <name> [--out <file>]
                                         save a board as one self-contained HTML snapshot
                                         (default .crewmux/boards/<name>-<yyyymmdd-hhmm>.html)
  crewmux doctor                      check config, tmux and agent binaries
  crewmux init [--force]              only create .crewmux/ in the current directory
  crewmux help                        this text
`;

/** How to re-invoke this CLI from inside tmux (works for both dist/cli.js and tsx src/cli.ts). */
const selfArgv = () => [process.execPath, ...process.execArgv, fileURLToPath(import.meta.url)];

/** Session name = tmux server socket name: one private tmux server per project. */
const sessionName = (cfg: LoadedConfig) => {
  const name = `crewmux-${cfg.project.project}`;
  process.env[tmux.SOCKET_ENV] = name;
  return name;
};

function onPath(bin: string): boolean {
  if (bin.includes("/")) return existsSync(bin);
  return (process.env.PATH ?? "").split(delimiter).some((d) => d && existsSync(join(d, bin)));
}

function defaultRoles(cfg: LoadedConfig, requested: string[]): string[] {
  const roles = requested.length ? requested : Object.entries(cfg.roles).filter(([, b]) => b.autostart).map(([r]) => r);
  for (const r of roles) if (!cfg.roles[r]) throw new Error(`unknown role "${r}" (known: ${Object.keys(cfg.roles).join(", ")})`);
  return roles;
}

function init(force: boolean): void {
  const target = join(process.cwd(), AGENT_DIR);
  if (existsSync(target) && !force) throw new Error(`${AGENT_DIR}/ already exists (use --force to overwrite template files)`);
  cpSync(TEMPLATE, target, { recursive: true, force });
  // npm never ships files named .gitignore, so the template carries it as _gitignore.
  const shipped = join(target, "_gitignore");
  if (existsSync(shipped)) renameSync(shipped, join(target, ".gitignore"));
  const project = basename(process.cwd()).replace(/[^A-Za-z0-9_-]/g, "-");
  const cfgFile = join(target, "config.yaml");
  writeFileSync(cfgFile, readFileSync(cfgFile, "utf8").replace(/^project: .*$/m, `project: ${project}`));
  console.log(`created ${AGENT_DIR}/ for project "${project}" (roles: .crewmux/roles.yaml)`);
}

function doctor(): boolean {
  let ok = true;
  const check = (pass: boolean, label: string) => {
    console.log(`${pass ? "✓" : "✗"} ${label}`);
    ok &&= pass;
  };
  let cfg: LoadedConfig;
  try {
    cfg = loadConfig();
    check(true, `config ${cfg.dir}`);
  } catch (err) {
    check(false, `config: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
  check(onPath("tmux"), "tmux on PATH");
  const used = new Set(Object.values(cfg.roles).map((b) => b.agent));
  for (const id of used) {
    const def = cfg.agents.get(id)!;
    const bin = effectiveCli(def).command ?? def.kind;
    check(onPath(bin), `agent "${id}" (${def.kind}) → ${bin}`);
  }
  return ok;
}

/**
 * Best-effort: hand the URL to a browser without waiting for it or printing its noise.
 * $BROWSER wins (the usual convention), then WSL → Windows, macOS, and xdg-open. Returns what was used.
 */
function openInBrowser(url: string): string | undefined {
  const wsl = Boolean(process.env.WSL_DISTRO_NAME);
  const candidates: string[][] = [
    ...(process.env.BROWSER ? [process.env.BROWSER.split(" ").filter(Boolean)] : []),
    ...(wsl ? [["wslview"], ["cmd.exe", "/c", "start", ""]] : []),
    ...(process.platform === "darwin" ? [["open"]] : []),
    ["xdg-open"],
  ];
  for (const [bin, ...pre] of candidates) {
    if (!bin || !onPath(bin)) continue;
    try {
      spawn(bin, [...pre, url], { detached: true, stdio: "ignore" }).on("error", (err) => console.error(`could not start ${bin}: ${err.message}`)).unref();
      return bin;
    } catch (err) {
      console.error(`could not start ${bin}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return undefined;
}

/**
 * `board export <name> [--out <file>]`: one self-contained HTML file with the board's data embedded.
 * Authored and plan boards are read from disk (works without a running harness); `team` exists only
 * inside a running harness, so it is fetched over the control socket.
 */
async function exportBoard(raw: string[]): Promise<void> {
  const oi = raw.indexOf("--out");
  const out = oi >= 0 ? raw[oi + 1] : undefined;
  if (oi >= 0 && (!out || out.startsWith("--"))) throw new Error("usage: crewmux board export <name> [--out <file>]");
  const name = raw.find((a, i) => !a.startsWith("--") && (oi < 0 || i !== oi + 1));
  if (!name) throw new Error("usage: crewmux board export <name> [--out <file>]");
  const cfg = loadConfig();
  let board: Board | undefined;
  if (name === TEAM_BOARD) {
    board = (await sendControl(cfg.dir, { action: "board-data", name })) as Board;
  } else {
    if (!BoardName.safeParse(name).success) throw new Error(`"${name}" is not a board name (lowercase letters, digits and "-")`);
    const boards = new ProjectBoards({ root: cfg.root, agentDir: cfg.dir, ...(cfg.project.boards.plan ? { planPath: cfg.project.boards.plan } : {}) });
    board = boards.get(name);
  }
  if (!board) throw new Error(`no board named "${name}" — agents write boards with update_board; "plan" needs plan.md`);
  const now = new Date();
  const file = out ? resolve(out) : join(cfg.dir, "boards", exportFileName(name, now));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, snapshotHtml(readFileSync(BOARD_PAGE, "utf8"), board, now.getTime()));
  console.log(`exported board ${name}: ${file}`);
}

async function up(roles: string[], attach: boolean, fresh = false): Promise<void> {
  const cfg = loadConfig();
  const name = sessionName(cfg);
  const cli = selfArgv().map(tmux.shellQuote).join(" ");
  if (!(await tmux.hasSession(name))) {
    defaultRoles(cfg, roles); // fail fast on typos before creating anything
    rmSync(controlSocketPath(cfg.dir), { force: true }); // stale socket from a crashed run would fake readiness
    // The tmux server may predate this shell, so pass through what serve needs explicitly.
    const env: Record<string, string> = {
      [tmux.SOCKET_ENV]: name,
      ...(process.env.CREWMUX_DEBUG ? { CREWMUX_DEBUG: process.env.CREWMUX_DEBUG } : {}),
      ...(fresh ? { CREWMUX_FRESH: "1" } : {}),
    };
    await tmux.newSession(name, "harness", cfg.root, [...selfArgv(), "serve", ...roles], env);
    // If the harness dies, keep its window (and the error) on screen instead of the whole session vanishing.
    await tmux.tmux("set-option", "-w", "-t", `${name}:harness`, "remain-on-exit", "on");
    if (!(await waitForHarness(cfg, name))) {
      console.error(`✗ the harness did not start. Last lines of ${logFile(cfg)}:\n${tail(logFile(cfg), 20)}`);
      await tmux.killSession(name);
      await tmux.killServer();
      process.exitCode = 1;
      return;
    }
    console.log(`started tmux session ${name}`);
  } else {
    if (roles.length) console.log(`session ${name} already running — use \`crewmux open <role>\` to add roles`);
    // A harness started by an older build has no control socket: keys like Ctrl-b n/X can't reach it.
    if (!existsSync(controlSocketPath(cfg.dir))) {
      console.log(`⚠ this session was started by an older crewmux — run \`crewmux down && crewmux\` once to enable open/close (conversations resume)`);
    }
  }
  // (Re)apply the frame and key bindings every time, so an upgraded install takes effect on attach.
  await tmux.runAll(chromeCommands({ cli, cwd: cfg.root }));
  // Land on the first agent, not on the harness log.
  await tmux.tmux("select-window", "-t", `${name}:1`).catch(() => undefined);
  if (attach) await tmux.attach(name);
}

const logFile = (cfg: LoadedConfig) => join(cfg.dir, "state", "harness.log");
const LOG_MAX_BYTES = 5 * 1024 * 1024;

/** Keep one previous log (.1) and start fresh when the current one is too big. */
function rotateLog(file: string): void {
  try {
    if (existsSync(file) && statSync(file).size > LOG_MAX_BYTES) renameSync(file, `${file}.1`);
  } catch {
    // rotation is best effort
  }
}

function tail(file: string, lines: number): string {
  return existsSync(file) ? readFileSync(file, "utf8").trimEnd().split("\n").slice(-lines).join("\n") : "(no log file)";
}

/** Ready = control socket exists. False if the session died first or it took too long. */
async function waitForHarness(cfg: LoadedConfig, name: string, timeoutMs = 10_000): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (existsSync(controlSocketPath(cfg.dir))) return true;
    const dead = await tmux.tmux("display-message", "-p", "-t", `${name}:harness`, "#{pane_dead}").catch(() => "1");
    if (dead === "1") return false;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

async function serve(roles: string[]): Promise<void> {
  const cfg = loadConfig();
  mkdirSync(join(cfg.dir, "state"), { recursive: true });
  rotateLog(logFile(cfg));
  // Once tmux closes this window, writes to the terminal fail (EIO/EPIPE). Handle that here, or the
  // error would be reported by the logger below, which would fail again… (that loop once wrote 10 GB).
  let terminalGone = false;
  process.stdout.on("error", () => { terminalGone = true; });
  const log = (line: string) => {
    try {
      appendFileSync(logFile(cfg), `${line}\n`);
    } catch {
      // the log file is a convenience; never let it take the harness down
    }
    if (!terminalGone) {
      try {
        process.stdout.write(`${line}\n`);
      } catch {
        terminalGone = true;
      }
    }
  };
  // Unexpected errors are logged, not fatal — but never re-entrantly, and never for a closed terminal.
  let reporting = false;
  const report = (kind: string, err: unknown) => {
    const e = err instanceof Error ? err : new Error(String(err));
    const code = (e as NodeJS.ErrnoException).code;
    if (reporting || code === "EIO" || code === "EPIPE") return;
    reporting = true;
    log(`! ${kind}: ${e.stack ?? e.message}`);
    reporting = false;
  };
  process.on("uncaughtException", (err) => report("uncaught", err));
  process.on("unhandledRejection", (err) => report("unhandled", err));
  // This window is a log, not a shell: swallow keystrokes so Ctrl-C / stray keys can't stop the harness.
  // `q` is the one key that does something: leave (detach) — an exit that doesn't depend on Ctrl-b.
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.on("data", (b: Buffer) => {
      if (b.toString() === "q") void tmux.tmux("detach-client", "-s", sessionName(cfg)).catch(() => undefined);
    });
  }
  const harness = new Harness(cfg, {
    tmuxSession: sessionName(cfg),
    log,
    debug: process.env.CREWMUX_DEBUG === "1",
    panelArgv: [...selfArgv(), "panel"],
  });
  try {
    await harness.start();
  } catch (err) {
    log(`✗ harness failed to start: ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }
  for (const role of defaultRoles(cfg, roles)) {
    try {
      await harness.launch(role, { fresh: process.env.CREWMUX_FRESH === "1" });
    } catch (err) {
      log(`✗ could not start ${role}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const control = await startControlServer(harness, cfg.dir);
  log("harness running — Alt-1..9 switch agent · Ctrl-b n add · Ctrl-b X remove · Ctrl-b m messages · Ctrl-b a answer · Ctrl-b d detach");
  log("this window is the log — press q to leave (agents keep running) · stop everything with `crewmux down`");
  const shutdown = () => {
    setTimeout(() => process.exit(0), 3000).unref(); // never outlive the session, whatever hangs
    void stopControlServer(control, cfg.dir).then(() => harness.stop()).finally(() => process.exit(0));
  };
  for (const sig of ["SIGTERM", "SIGHUP"] as const) process.once(sig, shutdown); // not SIGINT: the tty is raw anyway
}

async function main(argv: string[]): Promise<void> {
  const flags = new Set(argv.filter((a) => a.startsWith("--")));
  const [cmd, ...args] = argv.filter((a) => !a.startsWith("--")); // so `crewmux --no-attach` still means "default"
  switch (cmd) {
    case undefined: {
      // The one-command path: set the project up on first use, then open it.
      if (!findAgentDir()) {
        init(false);
        if (!doctor()) {
          process.exitCode = 1;
          return;
        }
      }
      return up([], !flags.has("--no-attach"), flags.has("--fresh"));
    }
    case "init": return init(flags.has("--force"));
    case "doctor": if (!doctor()) process.exitCode = 1; return;
    case "up": return up(args, !flags.has("--no-attach"), flags.has("--fresh"));
    case "down": {
      const name = sessionName(loadConfig());
      await tmux.killSession(name);
      await tmux.killServer(); // the server is private to this project
      console.log(`stopped ${name}`);
      return;
    }
    case "serve": return serve(args);
    case "compact": {
      // `compact <role> | --all [--focus "what to keep"]`
      const raw = argv.slice(1);
      const fi = raw.indexOf("--focus");
      const focus = fi >= 0 ? (raw[fi + 1] ?? "") : "";
      const positional = raw.filter((a, i) => !a.startsWith("--") && (fi < 0 || i !== fi + 1));
      const dir = loadConfig().dir;
      const roles = raw.includes("--all")
        ? ((await sendControl(dir, { action: "status" })) as { role: string; status: string }[]).filter((r) => r.status === "running").map((r) => r.role)
        : positional.slice(0, 1);
      if (!roles.length) throw new Error("usage: crewmux compact <role> | --all [--focus \"what to keep\"]");
      for (const role of roles) {
        try {
          await sendControl(dir, { action: "compact", role, focus });
          console.log(`compact queued for ${role} (runs after its current turn)`);
        } catch (err) {
          console.log(`✗ ${role}: ${err instanceof Error ? err.message : String(err)}`);
          process.exitCode = 1;
        }
      }
      return;
    }
    case "restart": {
      const role = args[0];
      if (!role) throw new Error(`usage: crewmux restart <role>`);
      await sendControl(loadConfig().dir, { action: "restart", role, fresh: flags.has("--fresh") });
      console.log(`restarted ${role}`);
      return;
    }
    case "open":
    case "close": {
      const role = args[0];
      if (!role) throw new Error(`usage: crewmux ${cmd} <role>`);
      const cfg = loadConfig();
      const req = cmd === "open" ? { action: "open" as const, role, fresh: flags.has("--fresh") } : { action: "close" as const, role };
      await sendControl(cfg.dir, req);
      console.log(cmd === "open" ? `opened ${role}` : `closed ${role} — \`crewmux open ${role}\` brings it back (claude/codex continue the same conversation)`);
      return;
    }
    case "board": {
      if (args[0] === "export") return exportBoard(argv.slice(2));
      const { url } = (await sendControl(loadConfig().dir, { action: "board", ...(args[0] ? { name: args[0] } : {}) })) as { url: string };
      const opener = flags.has("--no-open") ? undefined : openInBrowser(url);
      console.log(opener ? `board: ${url} (opened with ${basename(opener)})` : `board: ${url}`);
      return;
    }
    case "status": {
      const rows = (await sendControl(loadConfig().dir, { action: "status" })) as { role: string; agent: string; status: string }[];
      const roleW = Math.max(...rows.map((r) => r.role.length)) + 2;
      const agentW = Math.max(...rows.map((r) => r.agent.length)) + 2;
      for (const r of rows) console.log(`${r.status === "running" ? "●" : "○"} ${r.role.padEnd(roleW)}${r.agent.padEnd(agentW)}${r.status}`);
      return;
    }
    case "panel": {
      const agentDir = process.env.CREWMUX_HOME ?? loadConfig().dir;
      return runPanel({
        agentDir,
        mode: flags.has("--popup") ? "popup" : "side",
        ...(process.env.CREWMUX_VIEWER ? { viewer: process.env.CREWMUX_VIEWER } : {}),
        ...(process.env.CREWMUX_RUN_ID ? { runId: process.env.CREWMUX_RUN_ID } : {}),
      });
    }
    default:
      console.log(USAGE);
      if (cmd !== "help" && cmd !== "--help") process.exitCode = 1;
  }
}

main(process.argv.slice(2)).catch((err: unknown) => {
  console.error(`crewmux: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
