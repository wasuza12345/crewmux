import { HARNESS_MCP_NAME } from "../../protocol/index.js";
import { HARNESS_ENV, harnessEnv, type AgentLauncher } from "../launcher.js";

/** TOML basic string — JSON string escaping is a valid subset. */
const toml = (s: string) => JSON.stringify(s);

/**
 * Codex interactive UI. MCP over streamable HTTP with the token read from an env var
 * (bearer_token_env_var), role prompt as developer_instructions. All via -c overrides,
 * so ~/.codex/config.toml is never modified.
 */
export const codexLauncher: AgentLauncher = {
  kind: "codex",
  presetSessionId: () => false,
  build(def, ctx) {
    const model = ctx.model ?? def.model;
    return {
      command: def.command ?? "codex",
      args: [
        ...(ctx.resumeId ? ["resume"] : []), // `codex resume [OPTIONS] <id>` takes the same -c/-m options
        "-c", `mcp_servers.${HARNESS_MCP_NAME}.url=${toml(ctx.mcpUrl)}`,
        "-c", `mcp_servers.${HARNESS_MCP_NAME}.bearer_token_env_var=${toml(HARNESS_ENV.token)}`,
        // harness tools only talk to the harness — no per-call prompt (shell/file approvals are untouched)
        "-c", `mcp_servers.${HARNESS_MCP_NAME}.default_tools_approval_mode="approve"`,
        "-c", `developer_instructions=${toml(ctx.systemPrompt)}`,
        // Codex ≥0.155 ships built-in collaboration.send_message / list_agents; the model picked those
        // instead of ours and messages never arrived. The harness is the multi-agent layer here.
        "-c", "features.multi_agent=false",
        ...(model ? ["-m", model] : []),
        ...def.args,
        ...(ctx.resumeId ? [ctx.resumeId] : []),
      ],
      env: harnessEnv(ctx),
    };
  },
};
