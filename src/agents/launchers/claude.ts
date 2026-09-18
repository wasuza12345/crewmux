import { HARNESS_MCP_NAME } from "../../protocol/index.js";
import { HARNESS_ENV, harnessEnv, type AgentLauncher } from "../launcher.js";

/**
 * Claude Code interactive UI. The MCP config references the token through ${HARNESS_MCP_TOKEN}
 * (expanded by Claude Code from the window env), so the token never appears in argv or on disk.
 * User's own MCP servers stay loaded (no --strict-mcp-config) — we only add ours.
 */
export const claudeLauncher: AgentLauncher = {
  kind: "claude",
  presetSessionId: () => true,
  build(def, ctx) {
    const mcpConfig = JSON.stringify({
      mcpServers: { [HARNESS_MCP_NAME]: { type: "http", url: ctx.mcpUrl, headers: { Authorization: `Bearer \${${HARNESS_ENV.token}}` } } },
    });
    const model = ctx.model ?? def.model;
    return {
      command: def.command ?? "claude",
      args: [
        "--mcp-config", mcpConfig,
        "--allowedTools", `mcp__${HARNESS_MCP_NAME}`, // harness tools only talk to the harness — no per-call prompt
        "--append-system-prompt", ctx.systemPrompt,
        "--name", ctx.role,
        // --resume keeps the original id (no --fork-session), so the recorded id stays valid.
        ...(ctx.resumeId ? ["--resume", ctx.resumeId] : ctx.providerSessionId ? ["--session-id", ctx.providerSessionId] : []),
        ...(model ? ["--model", model] : []),
        ...def.args,
      ],
      env: harnessEnv(ctx),
    };
  },
};
