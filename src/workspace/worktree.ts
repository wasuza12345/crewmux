import { join } from "node:path";
import { git } from "./git.js";

export interface Worktree {
  path: string;
  branch: string;
}

/** One isolated worktree per role per run: .crewmux/state/worktrees/<runId>/<role>, branch agent/<runId>/<role>. */
export async function createWorktree(repoRoot: string, agentDir: string, runId: string, role: string, base: string): Promise<Worktree> {
  const path = join(agentDir, "state", "worktrees", runId, role);
  const branch = `agent/${runId}/${role}`;
  await git(repoRoot, "worktree", "add", "-b", branch, path, base);
  return { path, branch };
}

export async function removeWorktree(repoRoot: string, wt: Worktree, deleteBranch = false): Promise<void> {
  await git(repoRoot, "worktree", "remove", "--force", wt.path);
  if (deleteBranch) await git(repoRoot, "branch", "-D", wt.branch);
}
