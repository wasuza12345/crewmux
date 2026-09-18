import type { PolicyConfig } from "../config/schema.js";

export interface PathVerdict {
  allowed: boolean;
  rule?: string; // which pattern matched — returned to the agent so it knows why
}

const globToRegex = (glob: string): RegExp =>
  new RegExp(`^${glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);

/** Guards files the harness itself reads on an agent's behalf (report_artifact). Pure. */
export class PathPolicy {
  private readonly deny: { glob: string; re: RegExp }[];

  constructor(config: PolicyConfig) {
    this.deny = config.paths.deny.map((glob) => ({ glob, re: globToRegex(glob) }));
  }

  check(relPath: string): PathVerdict {
    const base = relPath.split("/").pop() ?? relPath;
    const hit = this.deny.find((d) => d.re.test(relPath) || d.re.test(base));
    return hit ? { allowed: false, rule: `paths.deny: ${hit.glob}` } : { allowed: true };
  }
}
