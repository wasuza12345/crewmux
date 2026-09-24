#!/usr/bin/env node
// Stand-in for a full-screen CLI that turns bracketed paste on (Claude Code, Codex do): it records
// the exact bytes its pane receives into probe-<role>.log, so a test can tell a paste
// (wrapped in ESC[200~ … ESC[201~) from keys that were really typed.
import { appendFileSync } from "node:fs";
import { join } from "node:path";

const log = join(process.cwd(), `probe-${process.env.HARNESS_ROLE ?? "x"}.log`);
process.stdout.write("\u001b[?2004h"); // DECSET 2004: ask the terminal to bracket pasted text
console.log("ready probe");
process.stdin.setRawMode?.(true);
process.stdin.on("data", (chunk) => appendFileSync(log, chunk));
process.stdin.resume();
