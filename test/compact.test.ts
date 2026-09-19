import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { launcherFor } from "../src/agents/launchers/index.js";
import { autoCompactArgs, compactCommand } from "../src/agents/presets.js";
import { AgentDefinition } from "../src/config/schema.js";
import { claudeUsage, codexUsage, readTail, specUsage } from "../src/runtime/usage.js";

const def = (raw: object) => AgentDefinition.parse({ id: "x", ...raw });
const ctx = { sessionId: "s_1", role: "r", systemPrompt: "p", mcpUrl: "http://127.0.0.1:1/mcp", token: "t" };
const tmp = () => mkdtempSync(join(tmpdir(), "compact-"));

describe("compact commands per vendor (data, not code)", () => {
  it("claude/grok keep the focus text, codex drops it (its /compact takes none)", () => {
    expect(compactCommand(def({ kind: "claude" }), "keep file paths")).toBe("/compact keep file paths");
    expect(compactCommand(def({ kind: "grok" }), "keep decisions")).toBe("/compact keep decisions");
    expect(compactCommand(def({ kind: "codex" }), "ignored")).toBe("/compact");
    expect(compactCommand(def({ kind: "claude" }), "")).toBe("/compact");
    expect(compactCommand(def({ kind: "claude" }), "a\nb")).toBe("/compact a b");
  });

  it("custom: whatever cli.compact says; none → undefined", () => {
    expect(compactCommand(def({ kind: "custom", command: "x", cli: { compact: { command: ":summarize {focus}" } } }), "k")).toBe(":summarize k");
    expect(compactCommand(def({ kind: "custom", command: "x" }), "k")).toBeUndefined();
  });

  it("auto-compact launch args come from the preset or cli.compact.auto", () => {
    expect(autoCompactArgs(def({ kind: "codex" }), 150000, "/h")).toEqual(["-c", "model_auto_compact_token_limit=150000"]);
    expect(autoCompactArgs(def({ kind: "claude" }), 150000, "/h")).toEqual(["--autocompact", "150000"]);
    expect(autoCompactArgs(def({ kind: "grok" }), 150000, "/h")).toEqual([]); // config-file only
    expect(autoCompactArgs(def({ kind: "custom", command: "x", cli: { compact: { command: "/c", auto: ["--ctx-limit={tokens}"] } } }), 90000, "/h")).toEqual(["--ctx-limit=90000"]);
    expect(autoCompactArgs(def({ kind: "codex" }), undefined, "/h")).toEqual([]);
  });

  it("launchers pass compactAt through; Claude enforces its 100k–1M range", () => {
    const codex = launcherFor("codex").build(def({ kind: "codex" }), { ...ctx, compactAt: 120000 }).args;
    expect(codex).toContain("model_auto_compact_token_limit=120000");
    const claude = launcherFor("claude").build(def({ kind: "claude" }), { ...ctx, compactAt: 200000 }).args;
    expect(claude.slice(claude.indexOf("--autocompact"), claude.indexOf("--autocompact") + 2)).toEqual(["--autocompact", "200000"]);
    expect(() => launcherFor("claude").build(def({ kind: "claude" }), { ...ctx, compactAt: 50000 })).toThrow(/100000–1000000/);
  });
});

describe("reading context usage from the CLIs' own files", () => {
  it("claude: input + cache read + cache creation of the latest turn", () => {
    const f = join(tmp(), "t.jsonl");
    writeFileSync(f, [
      JSON.stringify({ message: { usage: { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 5 } } }),
      JSON.stringify({ type: "user" }),
      JSON.stringify({ message: { usage: { input_tokens: 2, cache_read_input_tokens: 311639, cache_creation_input_tokens: 509, output_tokens: 1576 } } }),
    ].join("\n"));
    expect(claudeUsage(f)).toEqual({ tokens: 312150 });
  });

  it("codex: last token_count → last turn input and model window", () => {
    const f = join(tmp(), "r.jsonl");
    const tc = (n: number) => JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: n }, model_context_window: 258400 } } });
    writeFileSync(f, [tc(1000), tc(116960), JSON.stringify({ type: "response_item" })].join("\n"));
    expect(codexUsage(f)).toEqual({ tokens: 116960, window: 258400 });
  });

  it("spec (grok / custom): last regex match, window from a second file", () => {
    const home = tmp();
    const dir = join(home, ".grok/sessions", encodeURIComponent("/w"), "u1");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "updates.jsonl"), '{"usage":{"inputTokens":24047}}\n{"usage":{"inputTokens":92236}}\n');
    writeFileSync(join(dir, "resources_state.json"), '{"context_window_tokens": 500000}');
    const spec = {
      file: "~/.grok/sessions/{cwd_urlencoded}/{id}/updates.jsonl",
      pattern: String.raw`"usage":\{"inputTokens":(\d+)`,
      windowFile: "~/.grok/sessions/{cwd_urlencoded}/{id}/resources_state.json",
      windowPattern: String.raw`"context_window_tokens":\s*(\d+)`,
    };
    expect(specUsage(spec, { id: "u1", cwd: "/w", cwd_urlencoded: encodeURIComponent("/w") }, home)).toEqual({ tokens: 92236, window: 500000 });
    expect(specUsage({ ...spec, file: "~/nope" }, { id: "u1", cwd: "/w", cwd_urlencoded: "x" }, home)).toBeUndefined();
  });

  it("readTail returns only the end of large files", () => {
    const f = join(tmp(), "big.txt");
    writeFileSync(f, `${"x".repeat(10_000)}END`);
    expect(readTail(f, 5)).toBe("xxEND");
  });
});
