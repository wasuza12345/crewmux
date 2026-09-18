import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { launcherFor } from "../src/agents/launchers/index.js";
import { AgentDefinition } from "../src/config/schema.js";
import { ensureConfigBlock, prepareVendor } from "../src/runtime/vendor-setup.js";
import { resolveResume } from "../src/runtime/resume.js";

const TOKEN = "tok_SECRET";
const ctx = { sessionId: "s_1", role: "grok", systemPrompt: "be a second opinion", mcpUrl: "http://127.0.0.1:1/mcp", token: TOKEN };
const def = (raw: object) => AgentDefinition.parse({ id: "x", ...raw });
const after = (a: string[], f: string) => a[a.indexOf(f) + 1];

describe("grok = a built-in CliSpec preset", () => {
  it("appends the role prompt (--rules), pre-approves harness tools, presets a session id; token only in env", () => {
    const g = def({ kind: "grok", model: "grok-5", args: ["--always-approve"] });
    const L = launcherFor("grok");
    expect(L.presetSessionId(g)).toBe(true);
    const spec = L.build(g, { ...ctx, providerSessionId: "u-1" });
    expect(spec.command).toBe("grok");
    expect(after(spec.args, "--rules")).toBe("be a second opinion");
    expect(after(spec.args, "--allow")).toBe("MCPTool(*harness*)");
    expect(after(spec.args, "--session-id")).toBe("u-1");
    expect(after(spec.args, "-m")).toBe("grok-5");
    expect(spec.args.at(-1)).toBe("--always-approve");
    expect(spec.args.join(" ")).not.toContain(TOKEN);
    expect(spec.env.HARNESS_MCP_TOKEN).toBe(TOKEN);
  });

  it("resume replaces --session-id with --resume", () => {
    const args = launcherFor("grok").build(def({ kind: "grok" }), { ...ctx, providerSessionId: "u-1", resumeId: "u-1" }).args;
    expect(after(args, "--resume")).toBe("u-1");
    expect(args).not.toContain("--session-id");
  });

  it("writes the project MCP config with placeholders only, idempotently, keeping existing content", () => {
    const cwd = mkdtempSync(join(tmpdir(), "grok-cfg-"));
    mkdirSync(join(cwd, ".grok"));
    writeFileSync(join(cwd, ".grok/config.toml"), '[ui]\nscreen_mode = "minimal"\n');
    expect(prepareVendor(def({ kind: "grok" }), cwd)).toBe(".grok/config.toml: harness MCP appended");
    expect(prepareVendor(def({ kind: "grok" }), cwd)).toBeUndefined();
    const text = readFileSync(join(cwd, ".grok/config.toml"), "utf8");
    expect(text.startsWith('[ui]\nscreen_mode = "minimal"\n')).toBe(true);
    expect(text.match(/\[mcp_servers\.harness\]/g)).toHaveLength(1);
    expect(text).toContain('url = "${HARNESS_MCP_URL}"');
    expect(text).not.toContain(TOKEN);
  });

  it("resumes only when the conversation file exists for this cwd", () => {
    const home = mkdtempSync(join(tmpdir(), "home-"));
    const cwd = "/home/me/web";
    const dir = join(home, ".grok/sessions", encodeURIComponent(cwd), "u-1");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "chat_history.jsonl"), "{}\n");
    const g = def({ kind: "grok" });
    expect(resolveResume({ harnessSessionId: "s", kind: "grok", cwd, providerSessionId: "u-1" }, g, cwd, home)).toBe("u-1");
    expect(resolveResume({ harnessSessionId: "s", kind: "grok", cwd, providerSessionId: "u-2" }, g, cwd, home)).toBeUndefined();
  });
});

describe("kind: custom driven entirely by YAML (cli:)", () => {
  const custom = def({
    kind: "custom",
    command: "mycli",
    args: ["--yolo"],
    cli: {
      prompt: { flag: "--append-prompt" },
      modelFlag: "--model",
      session: { new: ["--id", "{id}"], resume: ["--continue", "{id}"] },
      mcp: { args: ["--mcp-url", "{url}"] },
      allow: ["--trust-mcp", "harness"],
    },
    model: "m1",
  });

  it("builds argv from the spec with placeholders filled", () => {
    const L = launcherFor("custom");
    expect(L.presetSessionId(custom)).toBe(true);
    const a = L.build(custom, { ...ctx, providerSessionId: "u-9" }).args;
    expect(a).toEqual(["--id", "u-9", "--append-prompt", "be a second opinion", "--trust-mcp", "harness", "--mcp-url", "http://127.0.0.1:1/mcp", "--model", "m1", "--yolo"]);
    const r = L.build(custom, { ...ctx, providerSessionId: "u-9", resumeId: "u-9" }).args;
    expect(r.slice(0, 2)).toEqual(["--continue", "u-9"]);
  });

  it("without `exists`, a recorded id is resumed; without session spec, never", () => {
    expect(resolveResume({ harnessSessionId: "s", kind: "custom", cwd: "/w", providerSessionId: "u-9" }, custom, "/w")).toBe("u-9");
    const plain = def({ kind: "custom", command: "x" });
    expect(launcherFor("custom").presetSessionId(plain)).toBe(false);
    expect(resolveResume({ harnessSessionId: "s", kind: "custom", cwd: "/w", providerSessionId: "u-9" }, plain, "/w")).toBeUndefined();
  });

  it("rejects an MCP config path that escapes the project", () => {
    expect(() => def({ kind: "custom", command: "x", cli: { mcp: { file: { path: "../x.toml", content: "a" } } } })).toThrow(/stay inside/);
    expect(() => def({ kind: "custom", command: "x", cli: { mcp: { file: { path: "/etc/x", content: "a" } } } })).toThrow(/stay inside/);
  });

  it("ensureConfigBlock creates missing folders", () => {
    const cwd = mkdtempSync(join(tmpdir(), "cfg-"));
    expect(ensureConfigBlock(join(cwd, ".tool/deep/c.toml"), "[x]\na=1")).toBe("created");
  });
});

describe("guide search", () => {
  it("finds sections by title and body words; code fences are not headings", async () => {
    const { parseSections, searchSections } = await import("../src/bridge/guide.js");
    const md = "## Install\nrun npm link\n```\n## not a heading\n```\n## Bypass permissions\nuse --dangerously-skip-permissions\n### Grok\nkind: grok\n";
    const secs = parseSections("agent", md);
    expect(secs.map((s) => s.title)).toEqual(["Install", "Bypass permissions", "Grok"]);
    expect(searchSections(secs, "how to bypass")[0]!.title).toBe("Bypass permissions");
    expect(searchSections(secs, "grok")[0]!.title).toBe("Grok");
    expect(searchSections(secs, "zzz")).toEqual([]);
  });
});
