import { HARNESS_MCP_NAME } from "../../protocol/index.js";
import { homedir } from "node:os";
import { HARNESS_ENV, harnessEnv, type AgentLauncher } from "../launcher.js";
import { autoCompactArgs } from "../presets.js";

/**
 * Claude Code interactive UI. The MCP config references the token through ${HARNESS_MCP_TOKEN}
 * (expanded by Claude Code from the window env), so the token never appears in argv or on disk.
 * User's own MCP servers stay loaded (no --strict-mcp-config) — we only add ours.
 */
/** Claude Code accepts --autocompact between 100k and 1M tokens. */
function claudeCompactAt(tokens: number | undefined): number | undefined {
  if (tokens === undefined) return undefined;
  if (tokens < 100_000 || tokens > 1_000_000) throw new Error(`compactAt ${tokens}: Claude Code accepts 100000–1000000`);
  return tokens;
}

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
        ...autoCompactArgs(def, claudeCompactAt(ctx.compactAt), homedir()),
        ...def.args,
      ],
      env: harnessEnv(ctx),
    };
  },
};
