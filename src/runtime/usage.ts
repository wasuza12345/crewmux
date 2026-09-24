import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import type { AgentDefinition } from "../config/schema.js";
import type { AgentSessionInfo } from "../protocol/index.js";
import { effectiveCli, fill } from "../agents/presets.js";
import { claudeTranscriptPath, codexRolloutPath, findCodexSession } from "./resume.js";

/**
 * How full an agent's context is, read from the files each CLI writes about its own session
 * (never from its screen). Unknown → undefined; the harness then simply shows nothing.
 */
export interface ContextUsage {
  tokens: number;
  window?: number;
  /**
   * When this reading was taken (ms). A CLI writes nothing when it compacts, so a reading from
   * before a compaction still describes the old conversation — the harness treats it as unknown.
   */
  at?: number;
}

const TAIL_BYTES = 512 * 1024;

/** ISO timestamp → ms; anything unparseable is simply "no timestamp". */
function isoMs(v: unknown): number | undefined {
  if (typeof v !== "string") return undefined;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? undefined : ms;
}

/** Last write of the file the CLI keeps its session in — the fallback "when" for readings without one. */
function mtimeMs(file: string): number | undefined {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return undefined; // rotated away between the read and now
  }
}

/** Last `bytes` of a file — session logs grow large and only the latest entries matter. */
export function readTail(file: string, bytes = TAIL_BYTES): string {
  const size = statSync(file).size;
  const start = Math.max(0, size - bytes);
  const buf = Buffer.alloc(size - start);
  const fd = openSync(file, "r");
  try {
    readSync(fd, buf, 0, buf.length, start);
  } finally {
    closeSync(fd);
  }
  return buf.toString("utf8");
}

/** Last JSONL line containing `needle`, parsed. */
function lastJsonLine(text: string, needle: string): Record<string, unknown> | undefined {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (!line.includes(needle)) continue;
    try {
      return JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue; // first line of a tail may be cut in half
    }
  }
  return undefined;
}

/** Claude transcript: context = input + cache read + cache creation of the latest assistant turn. */
export function claudeUsage(transcript: string): ContextUsage | undefined {
  const row = lastJsonLine(readTail(transcript), '"usage"') as { timestamp?: string; message?: { usage?: Record<string, number> } } | undefined;
  const u = row?.message?.usage;
  if (!u) return undefined;
  const at = isoMs(row?.timestamp);
  return {
    tokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
    ...(at !== undefined ? { at } : {}),
  };
}

/** Codex rollout: latest token_count event → last turn's input tokens and the model window. */
export function codexUsage(rollout: string): ContextUsage | undefined {
  const row = lastJsonLine(readTail(rollout), '"token_count"') as
    | { timestamp?: string; payload?: { info?: { last_token_usage?: { input_tokens?: number }; model_context_window?: number } } }
    | undefined;
  const info = row?.payload?.info;
  const tokens = info?.last_token_usage?.input_tokens;
  if (tokens === undefined) return undefined;
  const at = isoMs(row?.timestamp) ?? mtimeMs(rollout);
  return {
    tokens,
    ...(info?.model_context_window ? { window: info.model_context_window } : {}),
    ...(at !== undefined ? { at } : {}),
  };
}

/** CliSpec.usage: last regex match (group 1) in a file; window fixed or from a second file. */
export function specUsage(spec: NonNullable<ReturnType<typeof effectiveCli>["cli"]>["usage"], vars: Record<string, string>, home: string): ContextUsage | undefined {
  if (!spec) return undefined;
  const lastMatch = (file: string, pattern: string): number | undefined => {
    const path = fill(file, vars, home);
    if (!existsSync(path)) return undefined;
    const matches = [...readTail(path).matchAll(new RegExp(pattern, "g"))];
    const v = matches.at(-1)?.[1];
    return v === undefined ? undefined : Number(v);
  };
  const tokens = lastMatch(spec.file, spec.pattern);
  if (tokens === undefined) return undefined;
  const window = spec.window ?? (spec.windowFile && spec.windowPattern ? lastMatch(spec.windowFile, spec.windowPattern) : undefined);
  const at = mtimeMs(fill(spec.file, vars, home)); // the spec gives no timestamp — the file's last write is the reading's time
  return { tokens, ...(window ? { window } : {}), ...(at !== undefined ? { at } : {}) };
}

/** Usage for a running session, dispatching on the vendor. */
export function contextUsage(def: AgentDefinition, s: AgentSessionInfo, home = homedir()): ContextUsage | undefined {
  try {
    let usage: ContextUsage | undefined;
    if (def.kind === "claude") {
      const t = s.providerSessionId ? claudeTranscriptPath(s.providerSessionId) : undefined;
      usage = t ? claudeUsage(t) : undefined;
    } else if (def.kind === "codex") {
      const id = s.providerSessionId ?? findCodexSession(s.id, s.cwd);
      const r = id ? codexRolloutPath(id) : undefined;
      usage = r ? codexUsage(r) : undefined;
    } else if (s.providerSessionId) {
      usage = specUsage(effectiveCli(def).cli?.usage, { id: s.providerSessionId, cwd: s.cwd, cwd_urlencoded: encodeURIComponent(s.cwd) }, home);
    }
    if (usage && !usage.window && def.contextWindow) usage.window = def.contextWindow;
    return usage;
  } catch {
    return undefined; // a half-written or rotated vendor file must never break the harness
  }
}
