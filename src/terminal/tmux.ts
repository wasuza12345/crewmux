import { rmSync } from "node:fs";
import { join } from "node:path";
import { execa, type Options } from "execa";

/**
 * Thin, typed wrappers over the tmux CLI. The harness never uses the user's tmux server:
 * each project gets its own (`tmux -L crewmux-<project>`, chosen by the CLI via CREWMUX_TMUX_SOCKET),
 * so key bindings and options stay inside it. Targets are window ids (@N), pane ids (%N) or session names.
 */

export const SOCKET_ENV = "CREWMUX_TMUX_SOCKET";
export const socketName = (): string => process.env[SOCKET_ENV] ?? "crewmux";

const run = (args: string[], opts: Options = {}) => execa("tmux", ["-L", socketName(), ...args], opts);
export const tmux = async (...args: string[]): Promise<string> => String((await run(args)).stdout).trim();

/** POSIX single-quote escaping for building the shell command tmux runs. */
export const shellQuote = (s: string): string => (/^[A-Za-z0-9_\-./:=@%+,]+$/.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`);
const shellCmd = (argv: string[]) => argv.map(shellQuote).join(" ");
const envArgs = (env: Record<string, string>) => Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);

export async function hasSession(name: string): Promise<boolean> {
  return (await run(["has-session", "-t", `=${name}`], { reject: false })).exitCode === 0;
}

export async function newSession(name: string, windowName: string, cwd: string, argv: string[], env: Record<string, string> = {}): Promise<void> {
  await tmux("new-session", "-d", "-s", name, "-n", windowName, "-c", cwd, ...envArgs(env), shellCmd(argv));
}

export async function killSession(name: string): Promise<void> {
  await run(["kill-session", "-t", `=${name}`], { reject: false });
}

/** Stop this project's private tmux server and remove its socket file (tmux can leave it behind). */
export async function killServer(): Promise<void> {
  await run(["kill-server"], { reject: false });
  const dir = process.env.TMUX_TMPDIR ?? "/tmp";
  rmSync(join(dir, `tmux-${process.getuid?.() ?? 0}`, socketName()), { force: true });
}

/** Starts `argv` in a new background window; returns its stable window id ("@7") and pane id ("%12"). */
export async function newWindow(session: string, name: string, cwd: string, argv: string[], env: Record<string, string>): Promise<{ window: string; pane: string }> {
  const out = await tmux("new-window", "-d", "-P", "-F", "#{window_id} #{pane_id}", "-t", `=${session}:`, "-n", name, "-c", cwd, ...envArgs(env), shellCmd(argv));
  const [window, pane] = out.split(" ");
  return { window: window!, pane: pane! };
}

/** Splits a new pane to the LEFT of `target` with a fixed width; returns its pane id (e.g. "%12"). */
export async function splitLeft(target: string, cwd: string, argv: string[], env: Record<string, string>, columns: number): Promise<string> {
  return tmux("split-window", "-d", "-h", "-b", "-l", String(columns), "-P", "-F", "#{pane_id}", "-t", target, "-c", cwd, ...envArgs(env), shellCmd(argv));
}

export async function killWindow(windowId: string): Promise<void> {
  await run(["kill-window", "-t", windowId], { reject: false });
}

/** Pane ids currently alive anywhere in a session. */
export async function listPanes(session: string): Promise<Set<string>> {
  const r = await run(["list-panes", "-s", "-t", `=${session}`, "-F", "#{pane_id}"], { reject: false });
  return new Set(r.exitCode === 0 ? String(r.stdout).split("\n").filter(Boolean) : []);
}

/** User options (@name) on a window, pane or session. */
export async function setOption(scope: "window" | "pane" | "session", target: string, name: `@${string}`, value: string): Promise<void> {
  const flag = scope === "window" ? ["-w"] : scope === "pane" ? ["-p"] : [];
  await tmux("set-option", ...flag, "-t", target, name, value);
}

export async function getOption(scope: "window" | "pane" | "session", target: string, name: `@${string}`): Promise<string> {
  const flag = scope === "window" ? ["-w"] : scope === "pane" ? ["-p"] : [];
  const r = await run(["show-options", ...flag, "-v", "-t", target, name], { reject: false });
  return r.exitCode === 0 ? String(r.stdout).trim() : "";
}

/** Per-window hook, e.g. keep the sidebar at a fixed width whenever the window is resized. */
export async function setWindowHook(windowId: string, hook: string, command: string): Promise<void> {
  await tmux("set-hook", "-w", "-t", windowId, hook, command);
}

export async function paneWidth(paneId: string): Promise<number> {
  return Number(await tmux("display-message", "-p", "-t", paneId, "#{pane_width}"));
}

export async function isWindowActive(windowId: string): Promise<boolean> {
  return (await tmux("display-message", "-p", "-t", windowId, "#{window_active}")) === "1";
}

export async function paneCount(windowId: string): Promise<number> {
  return (await tmux("list-panes", "-t", windowId, "-F", "#{pane_id}")).split("\n").filter(Boolean).length;
}

/**
 * Types text into a pane as if the user pasted it, then presses Enter.
 * -p = bracketed paste when the app asked for it (Claude Code, Codex), so newlines don't submit early.
 */
export async function pasteAndSubmit(target: string, text: string, delayMs: number): Promise<void> {
  const buffer = `harness-${target.replace(/\W/g, "")}`;
  await run(["load-buffer", "-b", buffer, "-"], { input: text });
  await tmux("paste-buffer", "-p", "-d", "-b", buffer, "-t", target);
  await new Promise((r) => setTimeout(r, delayMs));
  await tmux("send-keys", "-t", target, "Enter");
}

export async function capturePane(target: string): Promise<string> {
  return tmux("capture-pane", "-p", "-J", "-S", "-200", "-t", target);
}

/** Run a batch of raw tmux commands (from chrome.ts) in order. */
export async function runAll(commands: string[][]): Promise<void> {
  for (const c of commands) await tmux(...c);
}

/**
 * Attach to the harness server. From inside another tmux this nests (TMUX unset for the child);
 * the harness bindings use Alt-keys and the harness prefix works after the outer one passes it through.
 */
export async function attach(session: string): Promise<void> {
  await run(["attach-session", "-t", `=${session}`], { stdio: "inherit", env: { ...process.env, TMUX: "" } });
}
