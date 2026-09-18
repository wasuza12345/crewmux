import { execa } from "execa";

export const git = async (cwd: string, ...args: string[]): Promise<string> =>
  (await execa("git", args, { cwd })).stdout.trim();

export const currentBranch = (cwd: string) => git(cwd, "rev-parse", "--abbrev-ref", "HEAD");
export const isClean = async (cwd: string) => (await git(cwd, "status", "--porcelain")) === "";
