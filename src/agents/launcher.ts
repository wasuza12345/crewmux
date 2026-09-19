import type { AgentDefinition } from "../config/schema.js";

/** Env vars every launched agent gets. Custom agents read these directly. */
export const HARNESS_ENV = {
  url: "HARNESS_MCP_URL",
  token: "HARNESS_MCP_TOKEN",
  role: "HARNESS_ROLE",
  session: "HARNESS_SESSION_ID",
  prompt: "HARNESS_SYSTEM_PROMPT",
} as const;

export interface LaunchContext {
  sessionId: string;
  role: string;
  model?: string; // role override > agent default
  systemPrompt: string; // harness preamble + role prompt + rules
  mcpUrl: string;
  token: string;
  providerSessionId?: string; // pre-assigned vendor session id when the vendor supports it
  resumeId?: string; // continue this vendor conversation instead of starting a new one
  compactAt?: number; // tokens — ask the CLI to auto-compact at this size (roles.yaml → compactAt)
}

/** Exactly what goes into `tmux new-window`: the vendor's own CLI, untouched, plus env. */
export interface LaunchSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/**
 * The harness does not wrap or re-render agents. A launcher only answers:
 * "how do I start this vendor's native CLI so it can reach the harness MCP server?"
 * Pure — no IO, so it is unit-tested by comparing argv.
 */
export interface AgentLauncher {
  readonly kind: AgentDefinition["kind"];
  /** Whether the vendor lets us choose its session id up front (for later resume). */
  presetSessionId(def: AgentDefinition): boolean;
  build(def: AgentDefinition, ctx: LaunchContext): LaunchSpec;
}

export const harnessEnv = (ctx: LaunchContext): Record<string, string> => ({
  [HARNESS_ENV.url]: ctx.mcpUrl,
  [HARNESS_ENV.token]: ctx.token,
  [HARNESS_ENV.role]: ctx.role,
  [HARNESS_ENV.session]: ctx.sessionId,
});
