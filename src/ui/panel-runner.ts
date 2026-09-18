import { existsSync } from "node:fs";
import { execa } from "execa";
import { dirname, join } from "node:path";
import { loadConfig, roleColor } from "../config/load.js";
import { EventStore } from "../persistence/events.js";
import { openDbReadonly } from "../persistence/sqlite.js";
import { initialState, reduce, renderPanel, type PanelState } from "./panel.js";

export interface PanelRunOptions {
  agentDir: string; // absolute .crewmux path
  mode: "side" | "popup";
  viewer?: string;
  runId?: string; // default: latest run in the db
  pollMs?: number;
}

/** Tails .crewmux/state/harness.db read-only and redraws the panel. Runs until killed (popup: until q/Esc). */
export async function runPanel(opts: PanelRunOptions): Promise<void> {
  const cfg = loadConfig(dirname(opts.agentDir));
  const dbFile = join(opts.agentDir, "state", "harness.db");
  const out = process.stdout;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  while (!existsSync(dbFile)) await sleep(200);
  const store = new EventStore(openDbReadonly(dbFile));
  let runId = opts.runId ?? store.latestRunId();
  while (!runId) { await sleep(200); runId = store.latestRunId(); }

  let state: PanelState = initialState(Object.entries(cfg.roles).map(([role, b]) => ({
    role, vendor: cfg.agents.get(b.agent)?.kind ?? "?", color: roleColor(cfg, role),
  })));
  let seq = 0;
  let dirty = true;

  const draw = () => {
    const lines = renderPanel(state, { width: out.columns || 32, height: out.rows || 24, mode: opts.mode, ...(opts.viewer ? { viewer: opts.viewer } : {}) });
    out.write(`\x1b[H\x1b[2J${lines.join("\r\n")}`);
    dirty = false;
  };

  out.write("\x1b[?25l"); // hide cursor
  const restore = () => out.write("\x1b[?25h\x1b[0m");
  process.on("exit", restore);
  out.on("resize", () => { dirty = true; });

  if (process.stdin.isTTY) {
    // Side panel: swallow keys (a stray Ctrl-C must not kill the sidebar). Popup: q / Esc / Ctrl-C close it.
    process.stdin.setRawMode(true);
    process.stdin.on("data", (b: Buffer) => {
      const k = b.toString();
      if (opts.mode === "popup" && (k === "q" || k === "\x1b" || k === "\x03")) process.exit(0);
      // Sidebar: q leaves the session (detach) — works even where Ctrl-b is taken by the terminal (VS Code).
      if (opts.mode === "side" && k === "q") void execa("tmux", ["detach-client"], { reject: false });
    });
  }

  for (;;) {
    for (const row of store.since(runId, seq)) {
      state = reduce(state, row.event);
      seq = row.seq;
      dirty = true;
    }
    if (dirty) draw();
    await sleep(opts.pollMs ?? 300);
  }
}
