import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentDefinition } from "../config/schema.js";
import { effectiveCli, fill } from "../agents/presets.js";

/**
 * Finds a vendor's own saved conversation so a role can pick up where it left off.
 * Read-only lookups in the vendors' stores — the harness never writes there.
 *   Claude: <CLAUDE_CONFIG_DIR|~/.claude>/projects/<cwd-slug>/<uuid>.jsonl (created on the first message)
 *   Codex:  <CODEX_HOME|~/.codex>/sessions/YYYY/MM/DD/rollout-…-<id>.jsonl, first line = session_meta with cwd
 *   CliSpec (custom / presets such as grok): session.exists template, e.g. ~/.grok/sessions/{cwd_urlencoded}/{id}/chat_history.jsonl
 */

const claudeHome = () => process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
const codexHome = () => process.env.CODEX_HOME ?? join(homedir(), ".codex");

/** Marker put in every system prompt so a Codex rollout can be matched back to its harness session. */
export const sessionMarker = (harnessSessionId: string) => `harness-session: ${harnessSessionId}`;

export function claudeTranscriptPath(uuid: string): string | undefined {
  const projects = join(claudeHome(), "projects");
  if (!existsSync(projects)) return undefined;
  const dir = readdirSync(projects).find((d) => existsSync(join(projects, d, `${uuid}.jsonl`)));
  return dir ? join(projects, dir, `${uuid}.jsonl`) : undefined;
}

export function claudeTranscriptExists(uuid: string): boolean {
  return claudeTranscriptPath(uuid) !== undefined;
}

/** Rollout files, newest first, from the last `days` day-folders. */
function codexRollouts(days = 14): string[] {
  const root = join(codexHome(), "sessions");
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const now = Date.now();
  for (let d = 0; d < days; d++) {
    const t = new Date(now - d * 86_400_000);
    const dir = join(root, String(t.getFullYear()), String(t.getMonth() + 1).padStart(2, "0"), String(t.getDate()).padStart(2, "0"));
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) if (f.startsWith("rollout-") && f.endsWith(".jsonl")) out.push(join(dir, f));
  }
  return out.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
}

const rolloutId = (file: string): string | undefined => {
  const meta = JSON.parse(readFileSync(file, "utf8").split("\n", 1)[0] || "{}") as { payload?: { id?: string; cwd?: string } };
  return meta.payload?.id;
};

export function codexRolloutPath(id: string): string | undefined {
  return codexRollouts().find((f) => f.endsWith(`-${id}.jsonl`));
}

export function codexRolloutExists(id: string): boolean {
  return codexRolloutPath(id) !== undefined;
}

/** The Codex conversation a harness session started (matched by cwd + the marker in its instructions). */
export function findCodexSession(harnessSessionId: string, cwd: string): string | undefined {
  const marker = sessionMarker(harnessSessionId);
  for (const file of codexRollouts()) {
    const text = readFileSync(file, "utf8");
    const first = JSON.parse(text.split("\n", 1)[0] || "{}") as { payload?: { cwd?: string } };
    if (first.payload?.cwd === cwd && text.includes(marker)) return rolloutId(file);
  }
  return undefined;
}

export interface PreviousSession {
  harnessSessionId: string;
  kind: string;
  cwd: string;
  providerSessionId?: string;
}

/** Vendor session id to resume, or undefined to start fresh. Only resumes in the same working directory. */
export function resolveResume(prev: PreviousSession | undefined, def: AgentDefinition, cwd: string, home = homedir()): string | undefined {
  const kind = def.kind;
  if (!prev || prev.kind !== kind || prev.cwd !== cwd) return undefined;
  if (kind === "claude") return prev.providerSessionId && claudeTranscriptExists(prev.providerSessionId) ? prev.providerSessionId : undefined;
  if (kind === "codex") {
    if (prev.providerSessionId && codexRolloutExists(prev.providerSessionId)) return prev.providerSessionId;
    return findCodexSession(prev.harnessSessionId, cwd);
  }
  // CliSpec-driven CLIs: resume the recorded id; if the spec says where the conversation lives, require it.
  const session = effectiveCli(def).cli?.session;
  if (!session || !prev.providerSessionId) return undefined;
  if (!session.exists) return prev.providerSessionId;
  const path = fill(session.exists, { id: prev.providerSessionId, cwd, cwd_urlencoded: encodeURIComponent(cwd) }, home);
  return existsSync(path) ? prev.providerSessionId : undefined;
}
