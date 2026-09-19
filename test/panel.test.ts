import { describe, expect, it } from "vitest";
import { initialState, reduce, renderPanel, visibleWidth, type PanelState } from "../src/ui/panel.js";
import { chromeCommands } from "../src/terminal/chrome.js";
import type { HarnessEvent } from "../src/protocol/index.js";

const TS = new Date("2026-09-18T14:31:00").getTime();
const ev = (e: Record<string, unknown>) => ({ id: "e", ts: TS, runId: "r_1", ...e }) as HarnessEvent;
const session = (role: string, status: string) => ev({ type: "session.status", session: { id: `s_${role}`, runId: "r_1", role, agentId: role, kind: "claude", cwd: "/", window: "@1", pane: "%1", status } });
const msg = (id: string, from: string, to: string, type: string, content: string) => ev({ type: "message", envelope: { id, from, to, type, content, artifacts: [] } });

const build = (): PanelState =>
  [
    session("planner", "running"),
    session("coder", "running"),
    msg("m1", "planner", "coder", "request", "implement single-flight refresh in auth/session.ts please"),
    ev({ type: "message.delivery", messageId: "m1", to: "coder", ok: true }),
    msg("m2", "coder", "user", "question", "merge ได้เลยไหม?"),
  ].reduce(reduce, initialState([
    { role: "planner", vendor: "claude", color: "#e3a857" },
    { role: "coder", vendor: "codex", color: "#5cb4cc" },
    { role: "reviewer", vendor: "claude", color: "#ab8fdc" },
  ]));

describe("sidebar panel", () => {
  it("reduces events into roles + feed with delivery status", () => {
    const s = build();
    expect(s.roles.map((r) => `${r.role}:${r.status}`)).toEqual(["planner:running", "coder:running", "reviewer:not started"]);
    expect(s.feed.map((f) => [f.id, f.delivered])).toEqual([["m1", true], ["m2", undefined]]);
  });

  it("side mode: fits exactly width × height, shows agents, question, messages, footer", () => {
    const lines = renderPanel(build(), { width: 32, height: 24, mode: "side", viewer: "planner", ansi: false });
    expect(lines).toHaveLength(24);
    for (const l of lines) expect(visibleWidth(l)).toBeLessThanOrEqual(32);
    const text = lines.join("\n");
    expect(text).toContain("● planner  claude  ◀");
    expect(text).toContain("○ reviewer claude not started");
    expect(text).toContain("ASKING YOU (1)");
    expect(text).toContain("merge ได้เลยไหม?");
    expect(text).toMatch(/14:31 planner→coder req ✓/);
    expect(text).toMatch(/implement single-flight refre.*…/);
    expect(lines.at(-1)).toContain("q here: leave");
  });

  it("popup mode wraps full message content instead of truncating", () => {
    const text = renderPanel(build(), { width: 30, height: 40, mode: "popup", ansi: false }).join("\n");
    expect(text).toContain("refresh in auth/session.ts");
    expect(text).not.toContain("…");
    expect(text).toContain("q / Esc close");
  });

  it("small height keeps the newest messages and the footer", () => {
    const lines = renderPanel(build(), { width: 32, height: 16, mode: "side", ansi: false });
    expect(lines).toHaveLength(16);
    expect(lines.at(-2)).toContain("M-1..9");
  });

  it("role column fits the longest role name", () => {
    const s = initialState([{ role: "clean-code", vendor: "claude", color: "#fff" }, { role: "qa", vendor: "codex", color: "#fff" }]);
    const text = renderPanel(s, { width: 32, height: 10, mode: "side", ansi: false }).join("\n");
    expect(text).toContain("○ clean-code claude");
    expect(text).toContain("○ qa         codex");
  });

  it("a role opened at runtime (not in the startup roles) appears in the list", () => {
    const s = [session("tester", "running")].reduce(reduce, initialState([{ role: "planner", vendor: "claude", color: "#e3a857" }]));
    expect(s.roles.map((r) => `${r.role}:${r.status}`)).toEqual(["planner:not started", "tester:running"]);
  });

  it("shows context size per agent (% with a window, else k tokens) and a ⟳ after compaction", () => {
    let s = [session("planner", "running"), session("coder", "running")].reduce(reduce, initialState([
      { role: "planner", vendor: "claude", color: "#e3a857" },
      { role: "coder", vendor: "codex", color: "#5cb4cc" },
    ]));
    s = reduce(s, ev({ type: "session.usage", role: "coder", tokens: 190000, window: 258400 }));
    s = reduce(s, ev({ type: "session.usage", role: "planner", tokens: 312150 }));
    s = reduce(s, ev({ type: "session.compact", role: "planner", by: "user" }));
    const text = renderPanel(s, { width: 32, height: 20, mode: "side", ansi: false }).join("\n");
    expect(text).toMatch(/coder\s+codex\s+74%/);
    expect(text).toMatch(/planner\s+claude\s+312k⟳/);
  });

  it("Thai combining marks do not count as columns", () => {
    expect(visibleWidth("ได้")).toBe(2);
  });
});

describe("tmux chrome", () => {
  const cmds = chromeCommands({ cli: "/usr/bin/node /x/cli.js", cwd: "/repo" });
  it("sets everything globally — safe because each project has its own tmux server", () => {
    for (const c of cmds.filter((c) => c[0] === "set-option" || c[0] === "set-hook")) expect(c[1]).toBe("-g");
  });
  it("binds Alt-1..9, C-b m popup, C-b n open, C-b X close, C-b a jump-to-asker", () => {
    const binds = cmds.filter((c) => c[0] === "bind-key").map((c) => c.slice(1, 3).join(" "));
    expect(binds).toEqual([...Array.from({ length: 9 }, (_, i) => `-n M-${i + 1}`), "m display-popup", "C-m display-popup", "n command-prompt", "C-n command-prompt", "X confirm-before", "R confirm-before", "C confirm-before", "a if-shell", "C-a if-shell"]);
  });
  it("refuses a project path that would break the shell quoting", () => {
    expect(() => chromeCommands({ cli: "node x", cwd: "/it's/here" })).toThrow(/must not contain/);
    expect(() => chromeCommands({ cli: "node x", cwd: "/a/$HOME" })).toThrow(/must not contain/);
  });
  it("open/close bindings run in the background (never block the client)", () => {
    for (const key of ["n", "X"]) {
      const cmd = cmds.find((c) => c[0] === "bind-key" && c[1] === key)!.at(-1)!;
      expect(cmd.startsWith("run-shell -b '")).toBe(true);
      expect(cmd).toContain('display-message -c "#{client_name}"');
    }
  });

  it("escapes commas inside tmux conditionals", () => {
    const fmt = cmds.find((c) => c[2] === "window-status-format")![3]!;
    expect(fmt).toContain("#[bg=#e07a7a#,fg=#1a0b0b]");
  });
});
