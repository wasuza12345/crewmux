import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { claudeTranscriptExists, findCodexSession, resolveResume, sessionMarker } from "../src/runtime/resume.js";
import { launcherFor } from "../src/agents/launchers/index.js";
import { AgentDefinition } from "../src/config/schema.js";
const D = (kind: string) => AgentDefinition.parse({ id: kind, kind, ...(kind === "custom" ? { command: "x" } : {}) });
import { EventBus } from "../src/core/event-bus.js";
import { SessionRegistry } from "../src/core/session-registry.js";
import { EventStore } from "../src/persistence/events.js";
import { openDb } from "../src/persistence/sqlite.js";

const CWD = "/home/me/projects/web";
let claudeHome: string;
let codexHome: string;

const writeCodexRollout = (id: string, cwd: string, harnessSession: string) => {
  const t = new Date();
  const dir = join(codexHome, "sessions", String(t.getFullYear()), String(t.getMonth() + 1).padStart(2, "0"), String(t.getDate()).padStart(2, "0"));
  mkdirSync(dir, { recursive: true });
  const meta = { type: "session_meta", payload: { id, cwd } };
  const turn = { type: "turn_context", payload: { developer_instructions: `You are ... (${sessionMarker(harnessSession)})` } };
  writeFileSync(join(dir, `rollout-2026-09-18T10-00-00-${id}.jsonl`), `${JSON.stringify(meta)}\n${JSON.stringify(turn)}\n`);
};

beforeEach(() => {
  claudeHome = mkdtempSync(join(tmpdir(), "claude-home-"));
  codexHome = mkdtempSync(join(tmpdir(), "codex-home-"));
  process.env.CLAUDE_CONFIG_DIR = claudeHome;
  process.env.CODEX_HOME = codexHome;
});

describe("finding vendor conversations", () => {
  it("claude: resumes only if the transcript file exists", () => {
    mkdirSync(join(claudeHome, "projects", "-home-me-projects-web"), { recursive: true });
    writeFileSync(join(claudeHome, "projects", "-home-me-projects-web", "uuid-1.jsonl"), "{}\n");
    expect(claudeTranscriptExists("uuid-1")).toBe(true);
    expect(resolveResume({ harnessSessionId: "s_a", kind: "claude", cwd: CWD, providerSessionId: "uuid-1" }, D("claude"), CWD)).toBe("uuid-1");
    // never typed anything → no transcript → start fresh instead of a failing --resume
    expect(resolveResume({ harnessSessionId: "s_a", kind: "claude", cwd: CWD, providerSessionId: "uuid-2" }, D("claude"), CWD)).toBeUndefined();
  });

  it("codex: matches a rollout by cwd + harness marker, ignoring other sessions", () => {
    writeCodexRollout("id-other-cwd", "/elsewhere", "s_a");
    writeCodexRollout("id-other-session", CWD, "s_zzz");
    writeCodexRollout("id-mine", CWD, "s_a");
    expect(findCodexSession("s_a", CWD)).toBe("id-mine");
    expect(resolveResume({ harnessSessionId: "s_a", kind: "codex", cwd: CWD }, D("codex"), CWD)).toBe("id-mine");
    // recorded id is preferred when its rollout still exists
    expect(resolveResume({ harnessSessionId: "s_x", kind: "codex", cwd: CWD, providerSessionId: "id-other-session" }, D("codex"), CWD)).toBe("id-other-session");
  });

  it("no resume across a different cwd, a different vendor, or for custom agents", () => {
    writeCodexRollout("id-mine", CWD, "s_a");
    expect(resolveResume({ harnessSessionId: "s_a", kind: "codex", cwd: CWD }, D("codex"), "/other")).toBeUndefined();
    expect(resolveResume({ harnessSessionId: "s_a", kind: "codex", cwd: CWD }, D("claude"), CWD)).toBeUndefined();
    expect(resolveResume({ harnessSessionId: "s_a", kind: "custom", cwd: CWD }, D("custom"), CWD)).toBeUndefined();
    expect(resolveResume(undefined, D("codex"), CWD)).toBeUndefined();
  });
});

describe("launch args when resuming", () => {
  const ctx = { sessionId: "s_1", role: "coder", systemPrompt: "p", mcpUrl: "http://127.0.0.1:1/mcp", token: "t" };
  it("claude: --resume replaces --session-id", () => {
    const args = launcherFor("claude").build(AgentDefinition.parse({ id: "c", kind: "claude" }), { ...ctx, providerSessionId: "u1", resumeId: "u1" }).args;
    expect(args[args.indexOf("--resume") + 1]).toBe("u1");
    expect(args).not.toContain("--session-id");
  });
  it("codex: `codex resume <options> <id>`", () => {
    const args = launcherFor("codex").build(AgentDefinition.parse({ id: "x", kind: "codex", args: ["--search"] }), { ...ctx, resumeId: "r1" }).args;
    expect(args[0]).toBe("resume");
    expect(args.at(-1)).toBe("r1");
    expect(args).toContain("--search");
  });
});

describe("remembering sessions across runs", () => {
  it("lastSession returns the newest record for a role, including a Codex id found later", () => {
    const db = openDb(":memory:");
    const store = new EventStore(db);
    const bus = new EventBus();
    bus.addSink((e) => store.append(e));
    const reg = new SessionRegistry(bus);
    const base = { runId: "r_1", agentId: "codex", kind: "codex", cwd: CWD, window: "@1", pane: "%1" };
    reg.add({ ...base, id: "s_old", role: "coder", status: "running" });
    reg.setStatus("s_old", "exited");
    reg.add({ ...base, id: "s_new", runId: "r_2", role: "coder", status: "running" });
    reg.setProviderSession("s_new", "codex-123");
    reg.add({ ...base, id: "s_p", role: "planner", status: "running" });
    expect(store.lastSession("coder")).toMatchObject({ id: "s_new", providerSessionId: "codex-123" });
    expect(store.lastSession("nobody")).toBeUndefined();
  });
});
