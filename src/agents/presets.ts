import type { AgentDefinition, CliSpec } from "../config/schema.js";
import { HARNESS_MCP_NAME } from "../protocol/index.js";
import { HARNESS_ENV } from "./launcher.js";

/**
 * Built-in CliSpecs. A preset is exactly what a user could write under `cli:` for kind: custom —
 * adding a CLI never needs code. Flags checked against the installed CLI's --help.
 */
export const PRESETS: Partial<Record<AgentDefinition["kind"], { command: string; cli: CliSpec }>> = {
  // Grok CLI 1.0.3 (xAI)
  grok: {
    command: "grok",
    cli: {
      prompt: { flag: "--rules" }, // appends; --system-prompt-override would replace Grok's own instructions
      modelFlag: "-m",
      session: {
        new: ["--session-id", "{id}"],
        resume: ["--resume", "{id}"],
        exists: "~/.grok/sessions/{cwd_urlencoded}/{id}/chat_history.jsonl",
      },
      mcp: {
        args: [],
        file: {
          path: ".grok/config.toml", // Grok reads project config and expands ${VAR}
          content: [
            `[mcp_servers.${HARNESS_MCP_NAME}]`,
            "# added by crewmux — values come from the agent window's environment",
            `url = "\${${HARNESS_ENV.url}}"`,
            "enabled = true",
            `headers = { Authorization = "Bearer \${${HARNESS_ENV.token}}" }`,
          ].join("\n"),
        },
      },
      allow: ["--allow", `MCPTool(*${HARNESS_MCP_NAME}*)`],
    },
  },
};

/** The effective command + CliSpec for a definition: preset defaults, then the user's own `cli:` on top. */
export function effectiveCli(def: AgentDefinition): { command: string | undefined; cli: CliSpec | undefined } {
  const preset = PRESETS[def.kind];
  if (!preset) return { command: def.command, cli: def.cli };
  return { command: def.command ?? preset.command, cli: def.cli ? { ...preset.cli, ...def.cli } : preset.cli };
}

/** Fill {placeholders}; "~/" → home. Pure given `home`. */
export function fill(template: string, vars: Record<string, string | undefined>, home: string): string {
  const out = template.replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m);
  return out.startsWith("~/") ? `${home}${out.slice(1)}` : out;
}
