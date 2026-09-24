import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { HarnessMcpServer } from "../src/bridge/mcp-server.js";
import { ToolError, type BoardAccess, type CallerIdentity } from "../src/bridge/tools.js";
import { EventBus } from "../src/core/event-bus.js";
import { PathPolicy } from "../src/core/policy-engine.js";
import { SessionRegistry } from "../src/core/session-registry.js";
import { PolicyConfig } from "../src/config/schema.js";
import type { Board, HarnessEvent } from "../src/protocol/index.js";

let server: HarnessMcpServer;
let compactCalls: { by: string; target: string; focus: string }[];
let usageOf: Map<string, { tokens: number; window?: number }>;
let contextNotes: Map<string, string>;
let sessions: SessionRegistry;
let events: HarnessEvent[];
let agentDir: string;
let worktree: string;
let stored: Map<string, Board>;
const VIEW_TOKEN = "view-token-for-tests";
const NOW = 1_758_000_000_000;

const addSession = (id: string, role: string, agentId: string) =>
  sessions.add({ id, runId: "r_1", role, agentId, kind: "custom", cwd: worktree, window: `@${id}`, pane: `%${id}`, status: "running" });
const identity = (sessionId: string, role: string, agentId: string): CallerIdentity => ({ runId: "r_1", sessionId, role, agentId, cwd: worktree });

const connect = async (token: string) => {
  const client = new Client({ name: "test-agent", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
};
const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => {
  const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
  return { isError: r.isError ?? false, text: r.content[0]!.text };
};
const messages = () => events.flatMap((e) => (e.type === "message" ? [e.envelope] : []));

beforeEach(async () => {
  const root = mkdtempSync(join(tmpdir(), "harness-"));
  agentDir = join(root, ".crewmux");
  worktree = join(root, "wt");
  mkdirSync(worktree, { recursive: true });
  events = [];
  const bus = new EventBus();
  bus.subscribe((e) => events.push(e));
  sessions = new SessionRegistry(bus);
  addSession("s_planner", "planner", "claude");
  addSession("s_coder", "coder", "codex");
  compactCalls = [];
  usageOf = new Map([["coder", { tokens: 180000, window: 258400 }]]);
  contextNotes = new Map();
  stored = new Map();
  // In-memory stand-in for the runtime's board storage (the interface bridge is given).
  const boards: BoardAccess = {
    viewToken: VIEW_TOKEN,
    page: () => "<!doctype html><title>board</title>",
    get: (name) => (name === "team" ? { name: "team", updatedAt: NOW, title: "Team", kpis: [], columns: [{ id: "c", title: "c", cards: [] }], edges: [] } : stored.get(name)),
    list: () => [...stored.values()].map((b) => ({ name: b.name, title: b.title, source: "agent" as const, updatedAt: b.updatedAt })),
    put: (b) => void stored.set(b.name, b),
  };
  server = new HarnessMcpServer({
    boards, now: () => NOW,
    bus, sessions, policy: new PathPolicy(PolicyConfig.parse({ paths: { deny: ["*.env"] } })), agentDir,
    usage: (role) => usageOf.get(role),
    contextNote: (role) => contextNotes.get(role),
    compact: async (by, target, focus) => {
      if (target === "nobody") throw new ToolError(`no running agent with role "nobody"`);
      compactCalls.push({ by, target, focus });
    },
  });
  await server.start();
});
afterEach(() => server.stop());

describe("harness MCP bridge", () => {
  it("rejects requests without a valid session token", async () => {
    const res = await fetch(server.url, { method: "POST", headers: { "content-type": "application/json", Authorization: "Bearer nope" }, body: "{}" });
    expect(res.status).toBe(401);
  });

  it("exposes the 8 harness tools", async () => {
    const client = await connect(server.issueToken(identity("s_planner", "planner", "claude")));
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(["ask_user", "compact", "guide", "list_agents", "report_artifact", "send_message", "submit_review", "update_board"]);
    await client.close();
  });

  it("list_agents shows self and live peers only", async () => {
    addSession("s_gone", "reviewer", "claude");
    sessions.setStatus("s_gone", "exited");
    const client = await connect(server.issueToken(identity("s_planner", "planner", "claude")));
    const r = JSON.parse((await call(client, "list_agents")).text);
    expect(r.you).toEqual({ role: "planner", agentId: "claude" });
    expect(r.peers.map((p: { role: string }) => p.role)).toEqual(["coder"]);
    await client.close();
  });

  it("send_message: sender comes from the token; artifact attach round-trip", async () => {
    const client = await connect(server.issueToken(identity("s_planner", "planner", "claude")));
    writeFileSync(join(worktree, "analysis.md"), "race in session.ts:128");
    const art = JSON.parse((await call(client, "report_artifact", { kind: "analysis", path: "analysis.md" })).text);
    const created = events.find((e) => e.type === "artifact.created");
    expect(created?.type === "artifact.created" && readFileSync(join(agentDir, "state", "artifacts", created.artifact.path), "utf8")).toBe("race in session.ts:128");

    const sent = await call(client, "send_message", { to: "coder", content: "use single-flight", artifacts: [art.artifactId] });
    expect(JSON.parse(sent.text).status).toBe("queued");
    expect(messages()[0]).toMatchObject({ from: "planner", to: "coder", type: "request", artifacts: [art.artifactId] });
    await client.close();
  });

  it("blocks path escapes, symlink escapes and policy-denied files", async () => {
    const client = await connect(server.issueToken(identity("s_coder", "coder", "codex")));
    writeFileSync(join(worktree, "..", "outside.txt"), "secret");
    symlinkSync(join(worktree, "..", "outside.txt"), join(worktree, "link.txt"));
    mkdirSync(join(worktree, "config"));
    writeFileSync(join(worktree, "config", "prod.env"), "KEY=x");

    expect((await call(client, "report_artifact", { kind: "file", path: "../outside.txt" })).text).toMatch(/escapes/);
    expect((await call(client, "report_artifact", { kind: "file", path: "link.txt" })).text).toMatch(/escapes/);
    expect((await call(client, "report_artifact", { kind: "file", path: "/etc/passwd" })).text).toMatch(/relative/);
    expect((await call(client, "report_artifact", { kind: "file", path: "config/prod.env" })).text).toMatch(/denied by policy/);
    expect(events.some((e) => e.type === "artifact.created")).toBe(false);
    await client.close();
  });

  it("rejects unknown/exited recipients and self-messages", async () => {
    addSession("s_gone", "reviewer", "claude");
    sessions.setStatus("s_gone", "exited");
    const client = await connect(server.issueToken(identity("s_planner", "planner", "claude")));
    expect((await call(client, "send_message", { to: "mallory", content: "x" })).text).toMatch(/no running agent with role "mallory" \(running: planner, coder\)/);
    expect((await call(client, "send_message", { to: "reviewer", content: "x" })).text).toMatch(/no running agent/);
    expect((await call(client, "send_message", { to: "planner", content: "x" })).text).toMatch(/yourself/);
    expect(messages()).toEqual([]);
    await client.close();
  });

  it("submit_review and ask_user produce typed envelopes", async () => {
    const client = await connect(server.issueToken(identity("s_planner", "planner", "claude")));
    await call(client, "submit_review", { to: "coder", verdict: "request_changes", notes: "[MAJOR] missing test" });
    await call(client, "ask_user", { question: "ship it?" });
    expect(messages()).toMatchObject([
      { from: "planner", to: "coder", type: "review_result", verdict: "request_changes" },
      { from: "planner", to: "user", type: "question", content: "ship it?" },
    ]);
    await client.close();
  });

  it("guide: lists topics, and returns the matching manual sections for a question", async () => {
    const client = await connect(server.issueToken(identity("s_planner", "planner", "claude")));
    const all = JSON.parse((await call(client, "guide")).text);
    expect(all.topics.length).toBeGreaterThan(10);
    const r = JSON.parse((await call(client, "guide", { topic: "bypass permissions" })).text);
    expect(r.found).toBeGreaterThan(0);
    expect(r.sections.map((s: { text: string }) => s.text).join("\n")).toContain("--dangerously-skip-permissions");
    const boards = JSON.parse((await call(client, "guide", { topic: "board update_board" })).text);
    expect(boards.sections.map((s: { text: string }) => s.text).join("\n")).toContain('"style": "dashed"');
    await client.close();
  });

  it("guide: finds the layout recipe of every board kind (what the preamble points agents to)", async () => {
    const client = await connect(server.issueToken(identity("s_planner", "planner", "claude")));
    const expected: Record<string, RegExp> = {
      plan: /plan\.md/, release: /Checks · Tests · Docs · Ship/, review: /BLOCKER · MAJOR · MINOR/,
      debug: /Symptom · Hypotheses · Evidence · Fix/, handoff: /Done · In progress · Next · Open questions · Files/,
    };
    for (const [kind, layout] of Object.entries(expected)) {
      const r = JSON.parse((await call(client, "guide", { topic: `board ${kind}` })).text);
      const recipe = (r.sections as { title: string; text: string }[]).find((s) => s.title.startsWith(`Board recipe: ${kind}`));
      expect(recipe, `${kind}: got ${r.sections.map((s: { title: string }) => s.title).join(" | ")}`).toBeDefined();
      expect(recipe!.text, kind).toMatch(layout);
    }
    await client.close();
  });

  it("update_board: kind is stored; a release board must say GO or NO-GO", async () => {
    const client = await connect(server.issueToken(identity("s_planner", "planner", "claude")));
    const noBanner = await call(client, "update_board", { name: "release-1", board: { ...plan, kind: "release", banner: undefined } });
    expect(noBanner.isError).toBe(true);
    expect(noBanner.text).toMatch(/must start with "GO" or "NO-GO"/);
    const vague = await call(client, "update_board", { name: "release-1", board: { ...plan, kind: "release", banner: { text: "GOOD so far", status: "active" } } });
    expect(vague.isError).toBe(true);
    const badKind = await call(client, "update_board", { name: "release-1", board: { ...plan, kind: "party" } });
    expect(badKind.isError).toBe(true);
    expect(stored.size).toBe(0);
    for (const text of ["NO-GO — e2e red", "GO"]) {
      const ok = await call(client, "update_board", { name: "release-1", board: { ...plan, kind: "release", banner: { text, status: "done" } } });
      expect(ok.isError, text).toBe(false);
    }
    expect(stored.get("release-1")).toMatchObject({ kind: "release", banner: { text: "GO" } });
    await client.close();
  });

  it("list_agents reports each agent's context size when known", async () => {
    const client = await connect(server.issueToken(identity("s_planner", "planner", "claude")));
    const r = JSON.parse((await call(client, "list_agents")).text);
    expect(r.yourContext).toBe("unknown");
    expect(r.peers[0].context).toBe("180000 tokens (70% of 258400)");
    await client.close();
  });

  it("list_agents says unknown — never the pre-compaction number — and reports a compaction that did not take", async () => {
    usageOf.delete("coder"); // what the harness does once a role is compacted: the old size is meaningless
    contextNotes.set("coder", "the compaction requested at 14:31 did not take effect (context still 860603 tokens)");
    const client = await connect(server.issueToken(identity("s_planner", "planner", "claude")));
    const r = JSON.parse((await call(client, "list_agents")).text);
    expect(r.peers[0].context).not.toContain("180000");
    expect(r.peers[0].context).toBe("unknown · the compaction requested at 14:31 did not take effect (context still 860603 tokens)");
    await client.close();
  });

  it("compact: defaults to yourself, can target another role; the requester comes from the token", async () => {
    const client = await connect(server.issueToken(identity("s_planner", "planner", "claude")));
    await call(client, "compact", { focus: "keep the API decision" });
    await call(client, "compact", { target: "coder" });
    expect(compactCalls).toEqual([
      { by: "planner", target: "planner", focus: "keep the API decision" },
      { by: "planner", target: "coder", focus: "" },
    ]);
    const bad = await call(client, "compact", { target: "nobody" });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/no running agent/);
    await client.close();
  });

  it("revoked tokens stop working", async () => {
    const token = server.issueToken(identity("s_planner", "planner", "claude"));
    server.revokeToken(token);
    await expect(connect(token)).rejects.toThrow();
  });

  const plan = {
    title: "Release plan",
    banner: { text: "blocked on review", status: "blocked" },
    kpis: [{ label: "tests", value: "13/13", status: "done" }],
    columns: [{ id: "build", title: "Build", cards: [
      { id: "a", title: "schema", status: "done", tier: "runtime" },
      { id: "b", title: "template", status: "active", tags: ["ui"] },
    ] }],
    edges: [{ from: "a", to: "b", style: "dashed" }],
    outOfScope: ["deploy"],
  };

  it("update_board: saves the board; updatedBy comes from the token, updatedAt from the harness clock", async () => {
    const client = await connect(server.issueToken(identity("s_planner", "planner", "claude")));
    // an agent trying to set the author/time itself is ignored — those fields are not part of the input
    const r = await call(client, "update_board", { name: "plan", board: { ...plan, updatedBy: "coder", updatedAt: 1 } });
    expect(r.isError).toBe(false);
    expect(JSON.parse(r.text)).toMatchObject({ name: "plan", status: "saved" });
    expect(stored.get("plan")).toMatchObject({ name: "plan", updatedBy: "planner", updatedAt: NOW, title: "Release plan" });
    expect(stored.get("plan")?.columns[0]?.cards[1]).toEqual({ id: "b", title: "template", status: "active", tags: ["ui"] });
    expect(events.some((e) => e.type === "board.updated" && e.name === "plan" && e.by === "planner")).toBe(true);
    await client.close();
  });

  it("update_board: rejects bad shapes with a message the agent can act on, and the reserved team board", async () => {
    const client = await connect(server.issueToken(identity("s_planner", "planner", "claude")));
    const badStatus = await call(client, "update_board", { name: "plan", board: { ...plan, columns: [{ id: "x", title: "X", cards: [{ id: "c", title: "t", status: "finished" }] }], edges: [] } });
    expect(badStatus.isError).toBe(true);
    expect(badStatus.text).toMatch(/status/);
    const badEdge = await call(client, "update_board", { name: "plan", board: { ...plan, edges: [{ from: "a", to: "ghost" }] } });
    expect(badEdge.isError).toBe(true);
    expect(badEdge.text).toMatch(/no card with id "ghost"/);
    const badName = await call(client, "update_board", { name: "../etc", board: plan });
    expect(badName.isError).toBe(true);
    expect(badName.text).toMatch(/lowercase/);
    const team = await call(client, "update_board", { name: "team", board: plan });
    expect(team.isError).toBe(true);
    expect(team.text).toMatch(/generated by the harness/);
    expect(stored.size).toBe(0);
    expect(events.some((e) => e.type === "board.updated")).toBe(false);
    await client.close();
  });

  describe("board pages over HTTP", () => {
    const origin = () => new URL(server.url).origin;
    const get = (path: string) => fetch(`${origin()}${path}`);

    it("listens on 127.0.0.1 only", () => {
      expect(new URL(server.url).hostname).toBe("127.0.0.1");
    });

    it("serves page, board data and list with the view token", async () => {
      stored.set("plan", { name: "plan", updatedAt: NOW, title: "Release plan", kpis: [], columns: [{ id: "c", title: "c", cards: [] }], edges: [] });
      const page = await get(`/board/team?t=${VIEW_TOKEN}`);
      expect(page.status).toBe(200);
      expect(page.headers.get("content-type")).toMatch(/text\/html/);
      expect(page.headers.get("referrer-policy")).toBe("no-referrer");
      expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
      const team = await get(`/board/team.json?t=${VIEW_TOKEN}`);
      expect(team.status).toBe(200);
      expect((await team.json()).name).toBe("team");
      const data = await (await get(`/board/plan.json?t=${VIEW_TOKEN}`)).json();
      expect(data.title).toBe("Release plan");
      const list = await get(`/board.json?t=${VIEW_TOKEN}`);
      expect((await list.json()).boards.map((b: { name: string }) => b.name)).toEqual(["plan"]);
      expect((await get(`/board?t=${VIEW_TOKEN}`)).status).toBe(200);
    });

    it("401 without or with a wrong token — the MCP bearer does not count", async () => {
      for (const path of ["/board/team", "/board/team.json", "/board", "/board.json", "/board/team.json?t=nope", `/board/team.json?t=${VIEW_TOKEN}x`]) {
        expect((await get(path)).status, path).toBe(401);
      }
      const mcpToken = server.issueToken(identity("s_planner", "planner", "claude"));
      expect((await get(`/board/team.json?t=${mcpToken}`)).status).toBe(401);
      const withBearer = await fetch(`${origin()}/board/team.json`, { headers: { Authorization: `Bearer ${mcpToken}` } });
      expect(withBearer.status).toBe(401);
    });

    it("404 for unknown or malformed board names; read-only", async () => {
      expect((await get(`/board/nope.json?t=${VIEW_TOKEN}`)).status).toBe(404);
      expect((await get(`/board/..%2Fprivate.json?t=${VIEW_TOKEN}`)).status).toBe(404);
      expect((await get(`/board/UPPER.json?t=${VIEW_TOKEN}`)).status).toBe(404);
      expect((await fetch(`${origin()}/board/team.json?t=${VIEW_TOKEN}`, { method: "POST", body: "{}" })).status).toBe(405);
    });
  });
});
