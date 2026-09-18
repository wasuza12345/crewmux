import { cpSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildRolePrompt, loadConfig } from "../src/config/load.js";

const TEMPLATE = resolve(import.meta.dirname, "../templates/.crewmux");
const scaffold = () => {
  const root = mkdtempSync(join(tmpdir(), "harness-cfg-"));
  cpSync(TEMPLATE, join(root, ".crewmux"), { recursive: true });
  return root;
};

describe("templates/.crewmux", () => {
  it("loads and cross-validates", () => {
    const cfg = loadConfig(join(scaffold(), "some", "deep")); // walks up like git — dir need not exist
    expect([...cfg.agents.keys()].sort()).toEqual(["claude", "codex"]);
    expect(Object.keys(cfg.roles).sort()).toEqual(["clean-code", "coder", "planner", "reviewer"]);
    expect(cfg.project.isolation).toBe("shared");
    expect(cfg.policy.paths.deny).toContain("*.env");
    expect(Object.entries(cfg.roles).filter(([, b]) => b.autostart).map(([r]) => r)).toEqual(["planner", "coder"]);
  });

  it("clean-code prompt = role prompt + rules file, in order", () => {
    const cfg = loadConfig(scaffold());
    const prompt = buildRolePrompt(cfg, "clean-code");
    expect(prompt.indexOf("# Role: clean-code reviewer")).toBe(0);
    expect(prompt).toContain('<rules source="rules/clean-code.md">');
    expect(prompt).toContain("No duplication of knowledge");
  });

  it("a repo's own rules file is appended after the default rules", () => {
    const root = scaffold();
    writeFileSync(join(root, "CLEAN-CODE.md"), "# repo rule: no default exports");
    const roles = join(root, ".crewmux", "roles.yaml");
    writeFileSync(roles, `roles:\n  clean-code:\n    agent: claude\n    prompt: clean-code.md\n    rules: [rules/clean-code.md, ../CLEAN-CODE.md]\n  planner: { agent: claude }\n  coder: { agent: codex }\n  reviewer: { agent: claude }\n`);
    const prompt = buildRolePrompt(loadConfig(root), "clean-code");
    expect(prompt.indexOf("rules/clean-code.md")).toBeLessThan(prompt.indexOf("../CLEAN-CODE.md"));
    expect(prompt).toContain("no default exports");
  });

  it("rejects a role pointing at a missing rules file", () => {
    const root = scaffold();
    writeFileSync(join(root, ".crewmux", "roles.yaml"), `roles:\n  clean-code: { agent: claude, rules: [rules/nope.md] }\n  planner: { agent: claude }\n  coder: { agent: codex }\n  reviewer: { agent: claude }\n`);
    expect(() => loadConfig(root)).toThrow(/missing rules file rules\/nope.md/);
  });
});
