import { isAbsolute } from "node:path";
import { z } from "zod";

/** .crewmux/config.yaml */
export const ProjectConfig = z.object({
  version: z.literal(1),
  project: z.string().regex(/^[A-Za-z0-9_-]+$/, "letters, digits, _ and - only (used in tmux session name)"),
  baseBranch: z.string().default("main"),
  /** shared: every agent works in the repo root · worktree: one git worktree per session */
  isolation: z.enum(["shared", "worktree"]).default("shared"),
  compact: z.object({
    /** Agents may compact themselves and others through the `compact` MCP tool. */
    ai: z.boolean().default(true),
    /** Minimum minutes between two AI-requested compactions of the same role. */
    minIntervalMinutes: z.number().nonnegative().default(10),
  }).prefault({}),
  delivery: z.object({
    /** Wait between pasting a message and pressing Enter, so the CLI finishes handling the paste. */
    pasteDelayMs: z.number().int().nonnegative().default(300),
  }).prefault({}),
  boards: z.object({
    /** Markdown file the `plan` board is generated from, relative to the project root.
     *  Default: the first of plan.md, PLAN.md, .crewmux/plan.md that exists. Symlinks are checked at read time. */
    plan: z.string().min(1).refine((p) => !isAbsolute(p) && !/^[A-Za-z]:/.test(p) && !p.replaceAll("\\", "/").split("/").includes(".."), {
      message: "boards.plan must be a path relative to the project root that stays inside it (no leading / and no ..)",
    }).optional(),
  }).prefault({}),
});
export type ProjectConfig = z.infer<typeof ProjectConfig>;

/**
 * How to drive a CLI the harness has no built-in launcher for — all data, no code.
 * Placeholders in strings: {id} (vendor session id), {url} (harness MCP url), {role}, {cwd},
 * {cwd_urlencoded}; a leading "~/" means the home directory.
 */
const Args = z.array(z.string());
export const CliSpec = z.object({
  /** Role prompt as a flag, e.g. { flag: "--rules" } → ["--rules", <prompt>]. Always also in env HARNESS_SYSTEM_PROMPT. */
  prompt: z.object({ flag: z.string() }).optional(),
  /** Flag for the model, e.g. "-m" → ["-m", <model>]. */
  modelFlag: z.string().optional(),
  session: z.object({
    /** Args for a NEW conversation with a harness-chosen UUID, e.g. ["--session-id", "{id}"]. Omit if the CLI can't take one. */
    new: Args.optional(),
    /** Args to continue a conversation, e.g. ["--resume", "{id}"]. */
    resume: Args,
    /** File that exists only once the conversation has content; resume is skipped without it. */
    exists: z.string().optional(),
  }).optional(),
  mcp: z.object({
    /** Extra args that point the CLI at the harness MCP server, e.g. ["--mcp", "{url}"]. Token: env HARNESS_MCP_TOKEN. */
    args: Args.default([]),
    /** Or a project-level config file the CLI reads; `content` is appended once if its first line is missing. */
    file: z.object({ path: z.string(), content: z.string() }).optional(),
  }).prefault({}),
  /** How to compact the conversation. `command` is typed into the CLI ({focus} = optional instructions);
   *  `auto` are launch args that make the CLI compact by itself at {tokens} (roles.yaml → compactAt). */
  compact: z.object({ command: z.string(), auto: Args.optional() }).optional(),
  /** Where the CLI records context usage: last regex match (group 1) in `file` = tokens in context;
   *  window from `window`, or from `windowFile` + `windowPattern`. */
  usage: z.object({
    file: z.string(),
    pattern: z.string(),
    window: z.number().int().positive().optional(),
    windowFile: z.string().optional(),
    windowPattern: z.string().optional(),
  }).optional(),
  /** Extra args that pre-approve the harness tools, e.g. ["--allow", "MCPTool(*harness*)"]. */
  allow: Args.default([]),
});
export type CliSpec = z.infer<typeof CliSpec>;

/** .crewmux/agents/<id>.yaml — one vendor CLI and how to start it. */
export const AgentDefinition = z.object({
  id: z.string(),
  kind: z.enum(["claude", "codex", "grok", "custom"]), // grok = a built-in CliSpec preset (agents/presets.ts)
  model: z.string().optional(),
  command: z.string().optional(), // binary override; required for kind=custom
  args: z.array(z.string()).default([]), // extra args appended as-is
  cli: CliSpec.optional(), // kind=custom (or overrides for a preset): session/resume/prompt/MCP/compact wiring
  contextWindow: z.number().int().positive().optional(), // for "% used" when the CLI does not record it (e.g. Claude)
})
  .refine((a) => a.kind !== "custom" || a.command, { message: "kind: custom requires command" })
  .refine((a) => !a.cli?.mcp.file || !(/^\//.test(a.cli.mcp.file.path) || a.cli.mcp.file.path.split("/").includes("..")), {
    message: "cli.mcp.file.path must be relative to the project and stay inside it",
  });
export type AgentDefinition = z.infer<typeof AgentDefinition>;

/** .crewmux/roles.yaml — a role is an address other agents send messages to. */
export const RoleBinding = z.object({
  agent: z.string(), // AgentDefinition.id
  model: z.string().optional(), // overrides the agent's default
  prompt: z.string().optional(), // file under .crewmux/prompts
  rules: z.array(z.string()).default([]), // rule files appended to the prompt, relative to .crewmux/ (e.g. ../CLEAN-CODE.md)
  autostart: z.boolean().default(true), // opened by `crewmux up` without naming it
  compactAt: z.number().int().min(20_000).optional(), // tokens: the CLI auto-compacts at this size (if it supports it)
});
export const RolesConfig = z.object({
  roles: z.record(z.string().regex(/^[a-z0-9-]+$/, "lowercase, digits and - only"), RoleBinding),
});
export type RolesConfig = z.infer<typeof RolesConfig>;

/** .crewmux/policy.yaml — tool approvals stay with each vendor CLI; the harness only guards what it reads itself. */
export const PolicyConfig = z.object({
  paths: z.object({ deny: z.array(z.string()).default([]) }).prefault({}),
});
export type PolicyConfig = z.infer<typeof PolicyConfig>;
