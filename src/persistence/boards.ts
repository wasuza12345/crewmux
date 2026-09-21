import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Board, BoardName, BoardView } from "../protocol/index.js";

/** tmp + rename in the same directory: readers (the web page, the sidebar) never see half a file. */
function writeAtomic(file: string, data: string, mode?: number): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, data, mode === undefined ? {} : { mode });
  if (mode !== undefined) chmodSync(tmp, mode); // umask may have narrowed or the file pre-existed
  renameSync(tmp, file);
}

/** Authored boards: one JSON file per board in .crewmux/state/boards/<name>.json. */
export class BoardStore {
  constructor(private readonly dir: string) {}

  private file(name: string): string {
    // The name is validated at the MCP edge too; re-check here because it becomes a path.
    return join(this.dir, `${BoardName.parse(name)}.json`);
  }

  put(board: Board): void {
    mkdirSync(this.dir, { recursive: true });
    writeAtomic(this.file(board.name), `${JSON.stringify(board, null, 2)}\n`);
  }

  /** undefined = no such board. A file that no longer matches the schema is reported, not served. */
  get(name: string): Board | undefined {
    if (!BoardName.safeParse(name).success) return undefined;
    const file = this.file(name);
    if (!existsSync(file)) return undefined;
    const parsed = Board.safeParse(JSON.parse(readFileSync(file, "utf8")));
    if (!parsed.success) throw new Error(`board file ${file} is invalid: ${parsed.error.issues[0]?.message ?? "schema mismatch"}`);
    return parsed.data;
  }

  names(): string[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.slice(0, -5))
      .filter((n) => BoardName.safeParse(n).success)
      .sort();
  }
}

/** Where the running harness serves boards (origin + view token). Mode 0600: the token is a credential. */
export const boardViewFile = (agentDir: string) => join(agentDir, "state", "board-view.json");

export function writeBoardView(agentDir: string, view: BoardView): void {
  mkdirSync(join(agentDir, "state"), { recursive: true });
  writeAtomic(boardViewFile(agentDir), JSON.stringify(view), 0o600);
}

export function readBoardView(agentDir: string): BoardView | undefined {
  const file = boardViewFile(agentDir);
  if (!existsSync(file)) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined; // unreadable (e.g. left by a crashed run): the sidebar just omits the board line
  }
  const parsed = BoardView.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

export function removeBoardView(agentDir: string): void {
  rmSync(boardViewFile(agentDir), { force: true });
}
