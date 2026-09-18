import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentDefinition } from "../config/schema.js";
import { effectiveCli } from "../agents/presets.js";

/**
 * CLIs that cannot take the harness MCP server as a flag get it in their PROJECT-level config
 * (CliSpec.mcp.file) — never the user's global config. The block should hold ${VAR} placeholders
 * only; the CLI expands them from the agent window's environment.
 */
export function ensureConfigBlock(file: string, content: string): "created" | "appended" | "present" {
  const marker = content.split("\n").find((l) => l.trim()) ?? content;
  if (!existsSync(file)) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${content}\n`);
    return "created";
  }
  const text = readFileSync(file, "utf8");
  if (text.includes(marker)) return "present";
  writeFileSync(file, `${text.replace(/\n*$/, "\n\n")}${content}\n`);
  return "appended";
}

/** Anything a CLI needs on disk before it starts. Returns a log line when something was written. */
export function prepareVendor(def: AgentDefinition, cwd: string): string | undefined {
  const file = effectiveCli(def).cli?.mcp.file;
  if (!file) return undefined;
  const r = ensureConfigBlock(join(cwd, file.path), file.content);
  return r === "present" ? undefined : `${file.path}: harness MCP ${r}`;
}
