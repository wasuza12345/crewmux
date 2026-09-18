import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createWorktree } from "../src/workspace/worktree.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

describe("worktree isolation", () => {
  it("same role in two runs gets two separate worktrees on the base branch", async () => {
    const repo = mkdtempSync(join(tmpdir(), "harness-wt-"));
    git(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, "a.txt"), "x");
    git(repo, "add", ".");
    git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
    const agentDir = join(repo, ".crewmux");

    const first = await createWorktree(repo, agentDir, "r_1", "coder", "main");
    const second = await createWorktree(repo, agentDir, "r_2", "coder", "main");
    expect(first.path).not.toBe(second.path);
    expect(existsSync(join(second.path, "a.txt"))).toBe(true);
    expect(git(second.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("agent/r_2/coder");
  });
});
