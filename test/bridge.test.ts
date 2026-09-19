import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { HarnessMcpServer } from "../src/bridge/mcp-server.js";
import { ToolError, type CallerIdentity } from "../src/bridge/tools.js";
import { EventBus } from "../src/core/event-bus.js";
import { PathPolicy } from "../src/core/policy-engine.js";
import { SessionRegistry } from "../src/core/session-registry.js";
import { PolicyConfig } from "../src/config/schema.js";
import type { HarnessEvent } from "../src/protocol/index.js";

let server: HarnessMcpServer;
let compactCalls: { by: string; target: string; focus: string }[];
let sessions: SessionRegistry;
let events: HarnessEvent[];
let agentDir: string;
let worktree: string;

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
  server = new HarnessMcpServer({
    bus, sessions, policy: new PathPolicy(PolicyConfig.parse({ paths: { deny: ["*.env"] } })), agentDir,
    usage: (role) => (role === "coder" ? { tokens: 180000, window: 258400 } : undefined),
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

  it("exposes the 7 harness tools", async () => {
    const client = await connect(server.issueToken(identity("s_planner", "planner", "claude")));
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(["ask_user", "compact", "guide", "list_agents", "report_artifact", "send_message", "submit_review"]);
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
    await client.close();
  });

  it("list_agents reports each agent's context size when known", async () => {
    const client = await connect(server.issueToken(identity("s_planner", "planner", "claude")));
    const r = JSON.parse((await call(client, "list_agents")).text);
    expect(r.yourContext).toBe("unknown");
    expect(r.peers[0].context).toBe("180000 tokens (70% of 258400)");
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
});
