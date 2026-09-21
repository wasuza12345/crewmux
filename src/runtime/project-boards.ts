import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { BoardStore } from "../persistence/boards.js";
import { PLAN_BOARD, TEAM_BOARD, type Board, type BoardSummary } from "../protocol/index.js";
import { planBoard, planNotice } from "./plan-board.js";

/**
 * Every board of one project, resolved the same way for the web server and `crewmux board export`:
 *
 *   team → generated from the run (needs a running harness: `team` option)
 *   plan → the authored board if an agent wrote one (authored wins), else generated from the plan markdown file
 *   else → authored (.crewmux/state/boards/<name>.json)
 *
 * This is the IO edge for the plan file: it is re-parsed only when its mtime/size change.
 */
export interface ProjectBoardsOptions {
  root: string; // project root (parent of .crewmux)
  agentDir: string;
  planPath?: string; // config.yaml → boards.plan (already checked to be relative, no "..")
  team?: () => Board; // absent = no running harness (offline export)
  now?: () => number;
  warn?: (what: string, err: unknown) => void;
}

/** Tried in order when config.yaml does not name the plan file. */
export const DEFAULT_PLAN_FILES = (agentDirName: string) => ["plan.md", "PLAN.md", `${agentDirName}/plan.md`];

/** Plans bigger than this are not parsed (the board would be cut to its limits anyway). */
const MAX_PLAN_BYTES = 512 * 1024;

export class ProjectBoards {
  readonly store: BoardStore;
  private cache?: { key: string; board: Board };

  constructor(private readonly opts: ProjectBoardsOptions) {
    this.store = new BoardStore(join(opts.agentDir, "state", "boards"));
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  get(name: string): Board | undefined {
    if (name === TEAM_BOARD) return this.opts.team?.();
    const authored = this.store.get(name);
    if (authored || name !== PLAN_BOARD) return authored;
    return this.planFromFile();
  }

  put(board: Board): void {
    this.store.put(board);
  }

  list(): BoardSummary[] {
    const rows: BoardSummary[] = [];
    if (this.opts.team) rows.push({ name: TEAM_BOARD, title: "Team (generated)", source: "generated", updatedAt: this.now(), updatedBy: "harness" });
    const names = this.store.names();
    for (const name of names) {
      try {
        const b = this.store.get(name);
        if (b) rows.push(summary(b, "agent"));
      } catch (err) {
        this.opts.warn?.(`board ${name}`, err); // one broken file must not hide the other boards
      }
    }
    if (!names.includes(PLAN_BOARD)) {
      const plan = this.planFromFile();
      if (plan) rows.splice(this.opts.team ? 1 : 0, 0, summary(plan, "file"));
    }
    return rows;
  }

  /** The plan file as a board; undefined when no plan file exists. */
  private planFromFile(): Board | undefined {
    const candidates = this.opts.planPath ? [this.opts.planPath] : DEFAULT_PLAN_FILES(relative(this.opts.root, this.opts.agentDir));
    for (const rel of candidates) {
      const abs = resolve(this.opts.root, rel);
      if (!existsSync(abs)) continue;
      // Resolve symlinks before the containment check so a link can't make the page show a file outside the project.
      const real = realpathSync(abs);
      const inside = relative(realpathSync(this.opts.root), real);
      if (inside.startsWith("..") || isAbsolute(inside)) return planNotice(rel, `${rel} resolves outside the project — not shown`, this.now());
      const st = statSync(real);
      if (!st.isFile()) continue;
      if (st.size > MAX_PLAN_BYTES) return planNotice(rel, `${rel} is larger than ${MAX_PLAN_BYTES / 1024} KB — split it into smaller plans`, this.now());
      const key = `${real}\0${st.mtimeMs}\0${st.size}`;
      if (this.cache?.key !== key) this.cache = { key, board: planBoard({ markdown: readFileSync(real, "utf8"), source: rel, mtime: Math.round(st.mtimeMs) }) };
      return this.cache.board;
    }
    return undefined;
  }
}

const summary = (b: Board, source: BoardSummary["source"]): BoardSummary => ({
  name: b.name, title: b.title, source, updatedAt: b.updatedAt,
  ...(b.kind ? { kind: b.kind } : {}),
  ...(b.updatedBy ? { updatedBy: b.updatedBy } : {}),
});
