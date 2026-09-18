import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Source of truth for layer boundaries (CLEAN-CODE.md §1 describes this table).
 * key = layer of the importing file, value = layers it may import.
 */
const ALLOWED: Record<string, string[]> = {
  protocol: ["protocol"],
  config: ["protocol", "config"],
  core: ["protocol", "config", "core"],
  agents: ["protocol", "config", "agents"],
  bridge: ["protocol", "config", "core", "workspace", "bridge"],
  workspace: ["protocol", "workspace"],
  persistence: ["protocol", "persistence"],
  terminal: ["terminal"],
  runtime: ["protocol", "config", "core", "agents", "bridge", "workspace", "persistence", "terminal", "runtime"],
  ui: ["protocol", "config", "persistence", "ui"], // read-only viewer: never core/bridge/runtime
  root: ["*"], // src/cli.ts — entry point
};

const SRC = resolve(import.meta.dirname, "../src");

const layerOf = (file: string): string => {
  const rel = relative(SRC, file).split("/");
  if (rel.length === 1) return "root";
  return rel[0]!;
};

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(join(dir, d.name)) : /\.tsx?$/.test(d.name) ? [join(dir, d.name)] : []));

describe("architecture", () => {
  const files = walk(SRC);

  it("every source file belongs to a known layer", () => {
    for (const f of files) expect(Object.keys(ALLOWED), relative(SRC, f)).toContain(layerOf(f));
  });

  it("imports only follow allowed layer directions", () => {
    const violations: string[] = [];
    for (const file of files) {
      const from = layerOf(file);
      const allowed = ALLOWED[from]!;
      if (allowed.includes("*")) continue;
      for (const [, spec] of readFileSync(file, "utf8").matchAll(/(?:from|import)\s+["'](\.[^"']+)["']/g)) {
        const to = layerOf(resolve(dirname(file), spec!));
        if (!allowed.includes(to)) violations.push(`${relative(SRC, file)} (${from}) → ${spec} (${to})`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("protocol has no runtime dependency other than zod and node:crypto", () => {
    for (const f of files.filter((x) => layerOf(x) === "protocol")) {
      const external = [...readFileSync(f, "utf8").matchAll(/from\s+["']([^."'][^"']*)["']/g)].map((m) => m[1]);
      for (const dep of external) expect(["zod", "node:crypto"], `${relative(SRC, f)} imports ${dep}`).toContain(dep);
    }
  });
});
