import { describe, expect, it } from "vitest";
import { launcherFor } from "../src/agents/launchers/index.js";
import { HARNESS_ENV, type LaunchContext } from "../src/agents/launcher.js";
import { AgentDefinition } from "../src/config/schema.js";

const TOKEN = "tok_SECRET_123"; // gitleaks:allow — fake token; the tests assert it never reaches argv
const ctx: LaunchContext = { sessionId: "s_1", role: "planner", systemPrompt: 'be "careful"\nline2', mcpUrl: "http://127.0.0.1:4000/mcp", token: TOKEN };
const def = (raw: object) => AgentDefinition.parse(raw);
const argAfter = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

describe("launchers build the vendor's own CLI command", () => {
  it("claude: mcp config, allowed tools, system prompt, preset session id; token only via env", () => {
    const spec = launcherFor("claude").build(def({ id: "claude", kind: "claude", model: "opus" }), { ...ctx, providerSessionId: "uuid-1" });
    expect(spec.command).toBe("claude");
    const mcp = JSON.parse(argAfter(spec.args, "--mcp-config")!);
    expect(mcp.mcpServers.harness).toEqual({ type: "http", url: ctx.mcpUrl, headers: { Authorization: "Bearer ${HARNESS_MCP_TOKEN}" } });
    expect(argAfter(spec.args, "--allowedTools")).toBe("mcp__harness");
    expect(argAfter(spec.args, "--append-system-prompt")).toBe(ctx.systemPrompt);
    expect(argAfter(spec.args, "--session-id")).toBe("uuid-1");
    expect(argAfter(spec.args, "--model")).toBe("opus");
    expect(spec.args.join(" ")).not.toContain(TOKEN);
    expect(spec.env[HARNESS_ENV.token]).toBe(TOKEN);
  });

  it("codex: -c overrides (valid TOML strings), role model beats agent model; token only via env", () => {
    const spec = launcherFor("codex").build(def({ id: "codex", kind: "codex", model: "a" }), { ...ctx, model: "b" });
    expect(spec.command).toBe("codex");
    expect(spec.args).toContain('mcp_servers.harness.url="http://127.0.0.1:4000/mcp"');
    expect(spec.args).toContain('mcp_servers.harness.bearer_token_env_var="HARNESS_MCP_TOKEN"');
    expect(spec.args).toContain('mcp_servers.harness.default_tools_approval_mode="approve"');
    expect(spec.args).toContain("features.multi_agent=false");
    expect(spec.args).toContain('developer_instructions="be \\"careful\\"\\nline2"');
    expect(argAfter(spec.args, "-m")).toBe("b");
    expect(spec.args.join(" ")).not.toContain(TOKEN);
    expect(spec.env[HARNESS_ENV.token]).toBe(TOKEN);
  });

  it("custom: runs the configured command with everything in env", () => {
    const spec = launcherFor("custom").build(def({ id: "g", kind: "custom", command: "gemini", args: ["--yolo"] }), ctx);
    expect(spec).toEqual({
      command: "gemini",
      args: ["--yolo"],
      env: { HARNESS_MCP_URL: ctx.mcpUrl, HARNESS_MCP_TOKEN: TOKEN, HARNESS_ROLE: "planner", HARNESS_SESSION_ID: "s_1", HARNESS_SYSTEM_PROMPT: ctx.systemPrompt },
    });
  });

  it("custom without command is a config error", () => {
    expect(() => def({ id: "g", kind: "custom" })).toThrow(/requires command/);
  });

  it("user args are appended last so they can override", () => {
    const spec = launcherFor("claude").build(def({ id: "c", kind: "claude", args: ["--permission-mode", "acceptEdits"] }), ctx);
    expect(spec.args.slice(-2)).toEqual(["--permission-mode", "acceptEdits"]);
  });
});

describe("harness preamble", () => {
  it("points every agent at the AI configuration guide and the commands", async () => {
    const { harnessPreamble, AGENT_GUIDE } = await import("../src/runtime/prompt.js");
    const { existsSync } = await import("node:fs");
    expect(existsSync(AGENT_GUIDE)).toBe(true);
    const p = harnessPreamble("web", "planner", "claude", "s_1");
    expect(p).toContain(AGENT_GUIDE);
    expect(p).toContain("guide(topic)");
    expect(p).toContain("crewmux open <role>");
    // boards: one line, pointing at the per-kind recipes
    expect(p.split("\n").filter((l) => l.includes("update_board"))).toHaveLength(1);
    expect(p).toContain('guide("board <kind>")');
  });
});
