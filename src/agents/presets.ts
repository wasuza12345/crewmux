import type { AgentDefinition, CliSpec } from "../config/schema.js";
import { HARNESS_MCP_NAME } from "../protocol/index.js";
import { HARNESS_ENV } from "./launcher.js";

/**
 * Built-in CliSpecs. A preset is exactly what a user could write under `cli:` for kind: custom —
 * adding a CLI never needs code. Flags checked against the installed CLI's --help.
 */
export const PRESETS: Partial<Record<AgentDefinition["kind"], { command: string; cli: CliSpec }>> = {
  // Claude Code and Codex have code launchers (their MCP/prompt flags need JSON/TOML);
  // their presets only describe compaction, which is plain data.
  claude: {
    command: "claude",
    // Claude Code runs a slash command only when it is typed on its own line; a long "/compact <focus>"
    // is answered as a message instead. The focus goes in as an ordinary message just before it.
    cli: { mcp: { args: [] }, allow: [], compact: { command: "/compact", focusMode: "message", auto: ["--autocompact", "{tokens}"] } },
  },
  codex: {
    command: "codex",
    // Codex's /compact takes no instructions; {focus} is dropped.
    cli: { mcp: { args: [] }, allow: [], compact: { command: "/compact", auto: ["-c", "model_auto_compact_token_limit={tokens}"] } },
  },
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
      // Auto-compaction is a config-file percentage in Grok, not a flag — no `auto` here.
      compact: { command: "/compact {focus}" },
      usage: {
        file: "~/.grok/sessions/{cwd_urlencoded}/{id}/updates.jsonl",
        pattern: String.raw`"usage":\{"inputTokens":(\d+)`,
        windowFile: "~/.grok/sessions/{cwd_urlencoded}/{id}/resources_state.json",
        windowPattern: String.raw`"context_window_tokens":\s*(\d+)`,
      },
    },
  },
};

/** The effective command + CliSpec for a definition: preset defaults, then the user's own `cli:` on top. */
export function effectiveCli(def: AgentDefinition): { command: string | undefined; cli: CliSpec | undefined } {
  const preset = PRESETS[def.kind];
  if (!preset) return { command: def.command, cli: def.cli };
  return { command: def.command ?? preset.command, cli: def.cli ? { ...preset.cli, ...def.cli } : preset.cli };
}

/** Launch args that make the CLI auto-compact at `tokens`, or [] if it has no such switch. */
export function autoCompactArgs(def: AgentDefinition, tokens: number | undefined, home: string): string[] {
  const auto = effectiveCli(def).cli?.compact?.auto;
  if (!tokens || !auto) return [];
  return auto.map((a) => fill(a, { tokens: String(tokens) }, home));
}

/** Where a compaction's `focus` goes for this CLI: into the command, into a message before it, or nowhere. */
export function compactFocusMode(def: AgentDefinition): "arg" | "message" | "none" {
  const spec = effectiveCli(def).cli?.compact;
  if (!spec) return "none";
  return spec.focusMode ?? (spec.command.includes("{focus}") ? "arg" : "none");
}

/** The text typed into the CLI to compact now, or undefined if the CLI cannot. `focus` only when it goes in as an arg. */
export function compactCommand(def: AgentDefinition, focus: string): string | undefined {
  const cmd = effectiveCli(def).cli?.compact?.command;
  if (!cmd) return undefined;
  const arg = compactFocusMode(def) === "arg" ? focus.replaceAll("\n", " ") : "";
  return cmd.replace("{focus}", arg).trimEnd();
}

/** Fill {placeholders}; "~/" → home. Pure given `home`. */
export function fill(template: string, vars: Record<string, string | undefined>, home: string): string {
  const out = template.replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m);
  return out.startsWith("~/") ? `${home}${out.slice(1)}` : out;
}
