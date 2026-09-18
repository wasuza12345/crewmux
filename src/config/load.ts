import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parse } from "yaml";
import type { z } from "zod";
import { AgentDefinition, PolicyConfig, ProjectConfig, RolesConfig } from "./schema.js";

export const AGENT_DIR = ".crewmux";

export interface LoadedConfig {
  root: string; // repo root (parent of .crewmux)
  dir: string; // absolute .crewmux path
  project: ProjectConfig;
  agents: Map<string, AgentDefinition>;
  roles: RolesConfig["roles"];
  policy: PolicyConfig;
}

/** Walk up from `start` until a directory containing .crewmux/ is found (like git). */
export function findAgentDir(start = process.cwd()): string | undefined {
  let dir = resolve(start);
  for (;;) {
    const candidate = join(dir, AGENT_DIR);
    if (existsSync(candidate) && statSync(candidate).isDirectory()) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function readYaml<S extends z.ZodType>(file: string, schema: S): z.infer<S> {
  const parsed = schema.safeParse(parse(readFileSync(file, "utf8")) ?? {});
  if (!parsed.success) throw new Error(`${file}: ${parsed.error.message}`);
  return parsed.data;
}

function readDir<S extends z.ZodType>(dir: string, schema: S): z.infer<S>[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
    .sort()
    .map((f) => readYaml(join(dir, f), schema));
}

export function loadConfig(start = process.cwd()): LoadedConfig {
  const dir = findAgentDir(start);
  if (!dir) throw new Error(`no ${AGENT_DIR}/ found from ${start} — run \`crewmux\` in the project folder`);

  const project = readYaml(join(dir, "config.yaml"), ProjectConfig);
  const roles = readYaml(join(dir, "roles.yaml"), RolesConfig).roles;
  const policy = readYaml(join(dir, "policy.yaml"), PolicyConfig);
  const agents = new Map(readDir(join(dir, "agents"), AgentDefinition).map((a) => [a.id, a]));

  // Cross-file integrity: every role must point to a defined agent and existing prompt.
  for (const [role, binding] of Object.entries(roles)) {
    if (!agents.has(binding.agent)) throw new Error(`roles.yaml: role "${role}" → unknown agent "${binding.agent}"`);
    if (binding.prompt && !existsSync(join(dir, "prompts", binding.prompt))) {
      throw new Error(`roles.yaml: role "${role}" → missing prompt prompts/${binding.prompt}`);
    }
    for (const rule of binding.rules) {
      if (!existsSync(join(dir, rule))) throw new Error(`roles.yaml: role "${role}" → missing rules file ${rule}`);
    }
  }

  return { root: dirname(dir), dir, project, agents, roles, policy };
}

/** System prompt for a role = prompts/<prompt> + every file in `rules`, in order. Rules live in one place only. */
export function buildRolePrompt(config: Pick<LoadedConfig, "dir" | "roles">, role: string): string {
  const binding = config.roles[role];
  if (!binding) throw new Error(`unknown role "${role}"`);
  const parts = binding.prompt ? [readFileSync(join(config.dir, "prompts", binding.prompt), "utf8").trim()] : [];
  for (const rule of binding.rules) parts.push(`<rules source="${rule}">\n${readFileSync(join(config.dir, rule), "utf8").trim()}\n</rules>`);
  return parts.join("\n\n");
}

const ROLE_PALETTE = ["#e3a857", "#5cb4cc", "#ab8fdc", "#7fc97f", "#e07aa8", "#d6c35a", "#6f9be0", "#e0896f"] as const;

/** Stable color per role (order in roles.yaml), shared by the tmux tabs and the panel. */
export function roleColor(config: Pick<LoadedConfig, "roles">, role: string): string {
  const i = Object.keys(config.roles).indexOf(role);
  return ROLE_PALETTE[(i < 0 ? 0 : i) % ROLE_PALETTE.length]!;
}
