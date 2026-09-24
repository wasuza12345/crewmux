import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/load.js";
import { EventStore } from "../src/persistence/events.js";
import { openDb } from "../src/persistence/sqlite.js";
import { Harness } from "../src/runtime/harness.js";
import { chromeCommands } from "../src/terminal/chrome.js";
import { sendControl, startControlServer, stopControlServer } from "../src/runtime/control.js";
import type { Server } from "node:http";
import * as tmux from "../src/terminal/tmux.js";
import type { HarnessEvent } from "../src/protocol/index.js";

const hasTmux = (() => { try { execFileSync("tmux", ["-V"]); return true; } catch { return false; } })();
const FAKE = resolve(import.meta.dirname, "fixtures/fake-agent.mjs");
const PROBE = resolve(import.meta.dirname, "fixtures/paste-probe.mjs");
const SESSION = "crewmux-e2e";
const REPO = resolve(import.meta.dirname, "..");
const CLI = `${REPO}/node_modules/.bin/tsx ${REPO}/src/cli.ts`; // what the tmux key bindings run
process.env.CREWMUX_TMUX_SOCKET = `agent-test-${process.pid}`; // private tmux server — never the user's

const waitFor = async (what: string, fn: () => Promise<boolean> | boolean, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
};

describe.skipIf(!hasTmux)("e2e: native CLIs in tmux, talking through the harness", () => {
  let harness: Harness;
  let root: string;
  let control: Server;
  const events: HarnessEvent[] = [];

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "harness-e2e-"));
    // Browser stand-in for `crewmux board` (C-b B): records the URL instead of opening anything.
    // Set before the tmux server starts so run-shell inherits it, like a user's $BROWSER.
    writeFileSync(join(root, "browser.sh"), `#!/bin/sh\necho "$1" >> "${root}/opened.txt"\n`);
    chmodSync(join(root, "browser.sh"), 0o755);
    process.env.BROWSER = join(root, "browser.sh");
    cpSync(resolve(import.meta.dirname, "../templates/.crewmux/prompts"), join(root, ".crewmux/prompts"), { recursive: true });
    mkdirSync(join(root, ".crewmux/agents"), { recursive: true });
    writeFileSync(join(root, ".crewmux/config.yaml"), "version: 1\nproject: e2e\ndelivery: { pasteDelayMs: 50 }\ncompact: { minIntervalMinutes: 10 }\n");
    writeFileSync(join(root, ".crewmux/policy.yaml"), "paths: { deny: ['*.env'] }\n");
    // The fake agent declares compaction and a usage file in YAML, like any custom CLI would.
    writeFileSync(join(root, ".crewmux/agents/fake.yaml"), [
      "id: fake", "kind: custom", `command: ${FAKE}`, // executable (shebang), so CLI flags follow it like a real CLI's
      "cli:", "  session: { new: ['--sid', '{id}'], resume: ['--sid', '{id}'] }",
      "  compact: { command: '/compact', focusMode: message }", // like Claude: a bare slash command, focus sent as a message
      `  usage: { file: '${root}/usage-{id}.txt', pattern: 'tokens=(\\d+)', window: 100000 }`, "",
    ].join("\n"));
    // Records the bytes its pane receives, with bracketed paste on — the only way to tell a paste from typed keys.
    writeFileSync(join(root, ".crewmux/agents/probe.yaml"), [
      "id: probe", "kind: custom", `command: ${PROBE}`,
      "cli:", "  compact: { command: '/compact', focusMode: message }", "",
    ].join("\n"));
    writeFileSync(join(root, ".crewmux/roles.yaml"), "roles:\n  planner: { agent: fake, prompt: planner.md }\n  coder: { agent: fake, prompt: coder.md }\n");
    await tmux.newSession(SESSION, "harness", root, ["sleep", "600"]);
    await tmux.runAll(chromeCommands({ cli: CLI, cwd: root })); // must be accepted by real tmux
    // Sidebar stand-in: a pane that would swallow input if messages were sent to the window instead of the agent pane.
    harness = new Harness(loadConfig(root), { tmuxSession: SESSION, watchIntervalMs: 200, usageIntervalMs: 200, panelArgv: ["cat"] });
    harness.bus.subscribe((e) => events.push(e));
    await harness.start();
    control = await startControlServer(harness, join(root, ".crewmux"));
  });

  afterAll(async () => {
    await stopControlServer(control, join(root, ".crewmux"));
    await harness?.stop();
    await tmux.killServer();
  });

  it("launches each role in its own window: agent pane + sidebar pane, tab options set", async () => {
    const planner = await harness.launch("planner");
    const coder = await harness.launch("coder");
    expect(planner.window).not.toBe(coder.window);
    expect(await tmux.paneCount(planner.window)).toBe(2);
    expect(await tmux.getOption("window", planner.window, "@dot")).toBe("●");
    expect(await tmux.getOption("window", coder.window, "@vendor")).toBe("custom");
    expect(await tmux.getOption("pane", planner.pane, "@label")).toBe("planner · custom");
    const sidebar = (await tmux.tmux("list-panes", "-t", planner.window, "-F", "#{pane_id}")).split("\n").find((p) => p !== planner.pane)!;
    await tmux.tmux("resize-window", "-t", planner.window, "-x", "160", "-y", "40");
    await waitFor("sidebar pinned at 32 cols", async () => (await tmux.paneWidth(sidebar)) === 32);
    await waitFor("both agents ready", async () =>
      (await tmux.capturePane(planner.pane)).includes("ready role=planner prompt-has-preamble=true") &&
      (await tmux.capturePane(coder.pane)).includes("ready role=coder prompt-has-preamble=true"));
  });

  it("planner → coder: pasted into the coder's AGENT pane (not the sidebar), unread badge +1", async () => {
    const planner = harness.sessions.byRole("planner")!;
    const coder = harness.sessions.byRole("coder")!;
    await tmux.pasteAndSubmit(planner.pane, "/send coder please implement single-flight refresh", 50);

    await waitFor("delivery event", () => events.some((e) => e.type === "message.delivery" && e.ok && e.to === "coder"));
    await waitFor("text in coder pane", async () => (await tmux.capturePane(coder.pane)).includes("got: please implement single-flight refresh"));
    expect(await tmux.capturePane(coder.pane)).toMatch(/got: \[harness\] message msg_\w+ from "planner" · type=request/);
    await waitFor("unread badge", async () => (await tmux.getOption("window", coder.window, "@unread")) === "1");
    // the rendered tab shows it (status line formats are evaluated by tmux itself)
    const tab = await tmux.tmux("display-message", "-p", "-t", coder.window, "#{E:window-status-format}");
    expect(tab).toContain("✉1");
    const title = await tmux.tmux("display-message", "-p", "-t", coder.window, "#{E:set-titles-string}");
    expect(title).toBe("crewmux · e2e · coder");
    // looking at the window clears it (after-select-window hook)
    await tmux.tmux("select-window", "-t", coder.window);
    await waitFor("badge cleared", async () => (await tmux.getOption("window", coder.window, "@unread")) === "0");
  });

  it("ask_user sets the question counter and where C-b a jumps", { timeout: 15000 }, async () => {
    const coder = harness.sessions.byRole("coder")!;
    await tmux.pasteAndSubmit(coder.pane, "/ask merge now?", 50);
    await waitFor("asked", async () => (await tmux.capturePane(coder.pane)).includes("asked"));
    await waitFor("question flagged", async () => (await tmux.getOption("session", SESSION, "@asks")) === "1");
    expect(await tmux.getOption("session", SESSION, "@ask_role")).toBe("coder");
    // the C-b a binding's commands, run by real tmux: jump to the asker, then clear the flag
    const bind = chromeCommands({ cli: CLI, cwd: root }).find((c) => c[0] === "bind-key" && c[1] === "a")!;
    const jump = bind[5]!.replaceAll("#{@ask_role}", "coder");
    writeFileSync(join(root, "jump.tmux"), `${jump}\n`);
    await tmux.tmux("source-file", join(root, "jump.tmux"));
    await waitFor("jumped + cleared", async () => (await tmux.getOption("session", SESSION, "@asks")) === "0" && (await tmux.getOption("session", SESSION, "@ask_role")) === "");
  });

  it("unknown role is rejected back to the sender", async () => {
    const planner = harness.sessions.byRole("planner")!;
    await tmux.pasteAndSubmit(planner.pane, "/send nobody hi", 50);
    await waitFor("error in planner pane", async () => (await tmux.capturePane(planner.pane)).includes('sent ERROR no running agent with role "nobody"'));
  });

  it("an agent CLI that exits: marked exited, token revoked, its window (with sidebar) closed", async () => {
    const coder = harness.sessions.byRole("coder")!;
    await tmux.pasteAndSubmit(coder.pane, "/quit", 50);
    await waitFor("coder exited", () => harness.sessions.get(coder.id)?.status === "exited");
    await waitFor("window closed", async () => (await tmux.listPanes(SESSION)).size === 3); // harness + planner(2)
    const planner = harness.sessions.byRole("planner")!;
    await tmux.pasteAndSubmit(planner.pane, "/send coder are you there", 50);
    await waitFor("rejected", async () => (await tmux.capturePane(planner.pane)).includes('sent ERROR no running agent with role "coder"'));
  });

  it("add at runtime: a role written to roles.yaml AFTER start opens via the control socket", async () => {
    writeFileSync(join(root, ".crewmux/roles.yaml"), "roles:\n  planner: { agent: fake, prompt: planner.md }\n  coder: { agent: fake, prompt: coder.md }\n  tester: { agent: fake, autostart: false }\n");
    await sendControl(join(root, ".crewmux"), { action: "open", role: "tester" });
    const tester = harness.sessions.byRole("tester")!;
    expect(tester.status).toBe("running");
    await waitFor("tester ready", async () => (await tmux.capturePane(tester.pane)).includes("ready role=tester"));
    const status = (await sendControl(join(root, ".crewmux"), { action: "status" })) as { role: string; status: string }[];
    expect(status.find((r) => r.role === "tester")?.status).toBe("running");
    // status reflects roles.yaml as it is now, not as it was at start
    writeFileSync(join(root, ".crewmux/roles.yaml"), "roles:\n  planner: { agent: fake, prompt: planner.md }\n  coder: { agent: fake, prompt: coder.md }\n  tester: { agent: fake, autostart: false }\n  newbie: { agent: fake, autostart: false }\n");
    const again = (await sendControl(join(root, ".crewmux"), { action: "status" })) as { role: string; status: string }[];
    expect(again.find((r) => r.role === "newbie")?.status).toBe("stopped");
  });

  it("remove at runtime: close kills the window and revokes access; unknown role errors clearly", async () => {
    const tester = harness.sessions.byRole("tester")!;
    await sendControl(join(root, ".crewmux"), { action: "close", role: "tester" });
    expect(harness.sessions.get(tester.id)?.status).toBe("exited");
    expect((await tmux.listPanes(SESSION)).has(tester.pane)).toBe(false);
    const indexes = (await tmux.tmux("list-windows", "-t", SESSION, "-F", "#{window_index}")).split("\n");
    expect(indexes).toEqual(indexes.map((_, i) => String(i))); // no gaps: Alt-<n> still lines up
    await expect(sendControl(join(root, ".crewmux"), { action: "close", role: "tester" })).rejects.toThrow(/not running/);
    await expect(sendControl(join(root, ".crewmux"), { action: "open", role: "ghost" })).rejects.toThrow(/unknown role "ghost"/);
  });

  it("restart: one harness-side step — new session, same role, config re-read", async () => {
    const before = harness.sessions.byRole("planner")!;
    await sendControl(join(root, ".crewmux"), { action: "restart", role: "planner" });
    const after = harness.sessions.byRole("planner")!;
    expect(after.id).not.toBe(before.id);
    expect(harness.sessions.get(before.id)?.status).toBe("exited");
    await waitFor("planner ready again", async () => (await tmux.capturePane(after.pane)).includes("ready role=planner"));
  });

  it("usage: read from the file the CLI spec points at, published as events", async () => {
    const planner = harness.sessions.byRole("planner")!;
    writeFileSync(join(root, `usage-${planner.providerSessionId}.txt`), "tokens=1000\ntokens=72000\n");
    await waitFor("usage event", () => events.some((e) => e.type === "session.usage" && e.role === "planner" && e.tokens === 72000 && e.window === 100000));
    expect(harness.usageOf("planner")).toMatchObject({ tokens: 72000, window: 100000 });
  });

  it("compact: the command runs on its own line, the focus arrives as a message before it; AI requests are rate-limited, the user's are not", async () => {
    const planner = harness.sessions.byRole("planner")!;
    const usageFile = join(root, `usage-${planner.providerSessionId}.txt`);
    await harness.compact("planner", { by: "coder", focus: "keep the API decision" });
    await waitFor("focus + compact typed", async () => {
      const pane = await tmux.capturePane(planner.pane);
      return pane.includes("got: Before compacting: keep this in the summary — keep the API decision") && pane.includes("got: /compact");
    });
    // The size read before the compaction says nothing about the conversation that is left.
    expect(harness.usageOf("planner")).toBeUndefined();
    expect(events.some((e) => e.type === "session.usage" && e.role === "planner" && e.tokens === undefined)).toBe(true);
    // An agent must not spend a second compaction on a size it cannot see yet...
    await expect(harness.compact("planner", { by: "coder" })).rejects.toThrow(/just compacted/);
    // ...and the refused request sent nothing, so it must not move the min-interval clock either.
    writeFileSync(usageFile, "tokens=9000\n");
    await waitFor("smaller size read", () => harness.usageOf("planner") !== undefined);
    await expect(harness.compact("planner", { by: "coder" })).rejects.toThrow(/compacted recently/);
    await harness.compact("planner", { focus: "user override" }); // the human is never rate-limited
    await waitFor("second compact typed", async () => (await tmux.capturePane(planner.pane)).includes("got: Before compacting: keep this in the summary — user override"));
    expect(events.filter((e) => e.type === "session.compact").map((e) => e.type === "session.compact" && e.by)).toEqual(["coder", "user"]);
  });

  it("a compaction that never shrinks the context is reported instead of believed", async () => {
    // Its own project (and harness) so the short verification window stays out of the other tests.
    const root2 = mkdtempSync(join(tmpdir(), "harness-verify-"));
    mkdirSync(join(root2, ".crewmux/agents"), { recursive: true });
    writeFileSync(join(root2, ".crewmux/config.yaml"), "version: 1\nproject: verify\ndelivery: { pasteDelayMs: 50 }\ncompact: { minIntervalMinutes: 0, verifySeconds: 1 }\n");
    writeFileSync(join(root2, ".crewmux/agents/fake.yaml"), [
      "id: fake", "kind: custom", `command: ${FAKE}`,
      "cli:", "  session: { new: ['--sid', '{id}'], resume: ['--sid', '{id}'] }",
      "  compact: { command: '/compact' }",
      `  usage: { file: '${root2}/usage-{id}.txt', pattern: 'tokens=(\\d+)', window: 100000 }`, "",
    ].join("\n"));
    writeFileSync(join(root2, ".crewmux/policy.yaml"), "paths: { deny: [] }\n");
    writeFileSync(join(root2, ".crewmux/roles.yaml"), "roles:\n  writer: { agent: fake }\n");
    const second = new Harness(loadConfig(root2), { tmuxSession: SESSION, watchIntervalMs: 200, usageIntervalMs: 200 });
    const seen: HarnessEvent[] = [];
    second.bus.subscribe((e) => seen.push(e));
    await second.start();
    try {
      const writer = await second.launch("writer");
      const usageFile = join(root2, `usage-${writer.providerSessionId}.txt`);
      writeFileSync(usageFile, "tokens=81000\n");
      await waitFor("size before", () => second.usageOf("writer")?.tokens === 81000);
      await second.compact("writer", { by: "planner" });
      writeFileSync(usageFile, "tokens=82000\n"); // the CLI answered the command instead of compacting
      await waitFor("failure published", () => seen.some((e) => e.type === "session.compact.failed" && e.role === "writer" && e.tokens === 82000));
      expect(second.teamBoard().columns.find((c) => c.title === "writer")!.cards[0]!.body).toMatch(/did not take effect/);
      await second.compact("writer", { by: "planner" }); // an attempt that did nothing must not block the retry
    } finally {
      await second.stop();
    }
  });

  it("compact is typed as keys, never pasted: a CLI in bracketed-paste mode gets a bare /compact line", async () => {
    writeFileSync(join(root, ".crewmux/roles.yaml"), [
      "roles:", "  planner: { agent: fake, prompt: planner.md }", "  coder: { agent: fake, prompt: coder.md }",
      "  tester: { agent: fake, autostart: false }", "  newbie: { agent: fake, autostart: false }",
      "  probe: { agent: probe, autostart: false }", "",
    ].join("\n"));
    const probe = await harness.launch("probe", { reload: true });
    await waitFor("probe ready", async () => (await tmux.capturePane(probe.pane)).includes("ready probe"));
    const log = join(root, "probe-probe.log");
    await harness.compact("probe", { focus: "keep the migration plan" });
    await waitFor("compact received", () => existsSync(log) && readFileSync(log, "utf8").includes("/compact"));

    const got = readFileSync(log, "utf8");
    const pasted = got.indexOf("\u001b[200~"); // bracketed paste: how ordinary messages arrive
    expect(pasted).toBeGreaterThanOrEqual(0);
    expect(got.slice(pasted)).toContain("keep the migration plan");
    const command = got.indexOf("/compact");
    expect(command).toBeGreaterThan(pasted); // the instructions first, the command after them
    expect(got.slice(command)).toBe("/compact\r"); // typed, unwrapped, alone on its line — a pasted one is never run
    await harness.close("probe");
  });

  it("the C-b n binding's command really opens a role when tmux runs it", { timeout: 30000 }, async () => {
    const bind = chromeCommands({ cli: CLI, cwd: root }).find((c) => c[0] === "bind-key" && c[1] === "n")!;
    const template = bind.at(-1)!.replace("%1", "tester");
    const file = join(root, "open.tmux");
    writeFileSync(file, `${template}\n`);
    await tmux.tmux("source-file", file);
    await waitFor("tester reopened", () => harness.sessions.byRole("tester")?.status === "running", 20000);
  });

  it("the C-b B binding exists on real tmux and, when tmux runs it, opens a board URL that serves page + team data", { timeout: 30000 }, async () => {
    expect(await tmux.tmux("list-keys", "-T", "prefix", "B")).toContain(" board 2>&1");
    const bind = chromeCommands({ cli: CLI, cwd: root }).find((c) => c[0] === "bind-key" && c[1] === "B")!;
    const file = join(root, "board.tmux");
    writeFileSync(file, `${bind.at(-1)!}\n`);
    await tmux.tmux("source-file", file);
    const opened = join(root, "opened.txt");
    await waitFor("browser opened with the board URL", () => existsSync(opened) && readFileSync(opened, "utf8").includes("/board/team?t="), 20000);
    const url = new URL(readFileSync(opened, "utf8").trim().split("\n").at(-1)!);
    expect(url.hostname).toBe("127.0.0.1");

    const page = await fetch(url);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("<title>Board</title>");
    const data = await (await fetch(`${url.origin}/board/team.json${url.search}`)).json();
    expect(data.name).toBe("team");
    expect(data.columns.map((c: { title: string }) => c.title)).toEqual(expect.arrayContaining(["planner", "coder", "tester"]));
    expect((await fetch(`${url.origin}/board/team.json`)).status).toBe(401);
    // the token file the sidebar reads is private to the user
    expect(statSync(join(root, ".crewmux/state/board-view.json")).mode & 0o777).toBe(0o600);
  });

  it("plan board: generated from plan.md in the project, follows edits to the file live", { timeout: 15000 }, async () => {
    const url = new URL(harness.boardUrl("plan"));
    const json = `${url.origin}/board/plan.json${url.search}`;
    expect((await fetch(json)).status).toBe(404); // no plan file yet
    writeFileSync(join(root, "plan.md"), "# E2E plan\n\n## Build\n- [x] schema 🟢\n- [~] page\n\n## Out of scope\n- deploy\n");
    const first = await (await fetch(json)).json();
    expect(first).toMatchObject({ name: "plan", kind: "plan", title: "E2E plan", updatedBy: "plan.md", outOfScope: ["deploy"] });
    expect(first.columns[0].cards.map((c: { title: string; status: string }) => `${c.title}:${c.status}`)).toEqual(["schema:done", "page:active"]);
    const list = await (await fetch(`${url.origin}/board.json${url.search}`)).json();
    expect(list.boards.map((b: { name: string; source: string }) => `${b.name}:${b.source}`)).toEqual(["team:generated", "plan:file"]);
    // the list page shows kind, updatedAt and updatedBy for every board
    expect(list.boards[1]).toMatchObject({ kind: "plan", updatedBy: "plan.md", updatedAt: expect.any(Number) });
    expect(list.boards[0]).toMatchObject({ updatedBy: "harness", updatedAt: expect.any(Number) });

    await new Promise((r) => setTimeout(r, 20)); // a distinct mtime even on coarse clocks
    writeFileSync(join(root, "plan.md"), "# E2E plan\n\n## Build\n- [x] schema 🟢\n- [x] page\n- [!] blocked on review\n");
    await waitFor("edit reflected", async () => {
      const b = await (await fetch(json)).json();
      return b.columns[0].cards.length === 3 && b.banner?.status === "blocked";
    });
  });

  it("board export (the real CLI): one self-contained file with the data embedded and no view token", { timeout: 30000 }, async () => {
    // async: the control server the CLI talks to runs in this very process
    const run = async (...args: string[]) =>
      (await promisify(execFile)(`${REPO}/node_modules/.bin/tsx`, [`${REPO}/src/cli.ts`, "board", "export", ...args], { cwd: root, encoding: "utf8", timeout: 20000 })).stdout;
    const token = JSON.parse(readFileSync(join(root, ".crewmux/state/board-view.json"), "utf8")).token as string;
    // team lives in the running harness → fetched over the control socket; --out picks the file
    const teamOut = join(root, "exports/team.html");
    expect(await run("team", "--out", teamOut)).toContain(teamOut);
    const team = readFileSync(teamOut, "utf8");
    expect(team).toContain('id="board-snapshot"');
    expect(team).toContain('"name":"team"');
    expect(team).not.toContain(token);
    // plan comes from plan.md on disk; default path .crewmux/boards/plan-<yyyymmdd-hhmm>.html
    const printed = await run("plan");
    const file = /exported board plan: (.+\.html)$/m.exec(printed)![1]!;
    expect(file).toMatch(/\.crewmux\/boards\/plan-\d{8}-\d{4}\.html$/);
    const plan = readFileSync(file, "utf8");
    expect(plan).toContain('"title":"E2E plan"');
    expect(plan).not.toContain(token);
    await expect(run("nope")).rejects.toThrow(/no board named "nope"/);
  });

  it("every event was persisted to SQLite", async () => {
    const store = new EventStore(openDb(join(root, ".crewmux/state/harness.db")));
    const types = store.replay(harness.runId).map((e) => e.type);
    expect(types).toEqual(events.map((e) => e.type));
    expect(store.latestRunId()).toBe(harness.runId);
  });
});
