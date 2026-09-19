import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
    cpSync(resolve(import.meta.dirname, "../templates/.crewmux/prompts"), join(root, ".crewmux/prompts"), { recursive: true });
    mkdirSync(join(root, ".crewmux/agents"), { recursive: true });
    writeFileSync(join(root, ".crewmux/config.yaml"), "version: 1\nproject: e2e\ndelivery: { pasteDelayMs: 50 }\n");
    writeFileSync(join(root, ".crewmux/policy.yaml"), "paths: { deny: ['*.env'] }\n");
    writeFileSync(join(root, ".crewmux/agents/fake.yaml"), `id: fake\nkind: custom\ncommand: ${process.execPath}\nargs: [${JSON.stringify(FAKE)}]\n`);
    writeFileSync(join(root, ".crewmux/roles.yaml"), "roles:\n  planner: { agent: fake, prompt: planner.md }\n  coder: { agent: fake, prompt: coder.md }\n");
    await tmux.newSession(SESSION, "harness", root, ["sleep", "600"]);
    await tmux.runAll(chromeCommands({ cli: CLI, cwd: root })); // must be accepted by real tmux
    // Sidebar stand-in: a pane that would swallow input if messages were sent to the window instead of the agent pane.
    harness = new Harness(loadConfig(root), { tmuxSession: SESSION, watchIntervalMs: 200, panelArgv: ["cat"] });
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

  it("the C-b n binding's command really opens a role when tmux runs it", { timeout: 30000 }, async () => {
    const bind = chromeCommands({ cli: CLI, cwd: root }).find((c) => c[0] === "bind-key" && c[1] === "n")!;
    const template = bind.at(-1)!.replace("%1", "tester");
    const file = join(root, "open.tmux");
    writeFileSync(file, `${template}\n`);
    await tmux.tmux("source-file", file);
    await waitFor("tester reopened", () => harness.sessions.byRole("tester")?.status === "running", 20000);
  });

  it("every event was persisted to SQLite", async () => {
    const store = new EventStore(openDb(join(root, ".crewmux/state/harness.db")));
    const types = store.replay(harness.runId).map((e) => e.type);
    expect(types).toEqual(events.map((e) => e.type));
    expect(store.latestRunId()).toBe(harness.runId);
  });
});
