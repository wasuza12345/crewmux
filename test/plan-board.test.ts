import { mkdirSync, mkdtempSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ProjectConfig } from "../src/config/schema.js";
import { Board, BOARD_LIMITS } from "../src/protocol/index.js";
import { planBoard } from "../src/runtime/plan-board.js";
import { ProjectBoards } from "../src/runtime/project-boards.js";

const MTIME = 1_758_000_000_000;
const parse = (markdown: string) => {
  const b = planBoard({ markdown, source: "plan.md", mtime: MTIME });
  expect(() => Board.parse(b), "generated plan must be a valid board").not.toThrow();
  return b;
};
const kpi = (b: Board, label: string) => b.kpis.find((k) => k.label === label)?.value;

const PLAN = `# Auth refresh

Single-flight token refresh for the mobile app.

## Build
- [x] schema 🟢
- [~] refresh queue 🟡
  - retries with backoff
  - [x] unit tests
  - [ ] e2e
- [!] needs API key rotation
- [ ] docs ⚪️

## Verify
- [X] typecheck 🟠
- a note, not a task

\`\`\`
- [ ] not a task: inside a fence
## not a heading
\`\`\`

### deeper heading is ignored
Some paragraph that is ignored.

## Out of scope
- [ ] deploy to production
- web client
  - nested under out of scope is ignored
`;

describe("plan board parser (pure)", () => {
  it("## headings → columns, markers → status, emojis → tier, H1 + first paragraph → title/subtitle", () => {
    const b = parse(PLAN);
    expect(b).toMatchObject({ name: "plan", kind: "plan", title: "Auth refresh", subtitle: "Single-flight token refresh for the mobile app.", updatedAt: MTIME, updatedBy: "plan.md" });
    expect(b.columns.map((c) => c.title)).toEqual(["Build", "Verify"]);
    const build = b.columns[0]!.cards;
    expect(build.map((c) => [c.title, c.status, c.tier])).toEqual([
      ["schema", "done", "runtime"],
      ["refresh queue", "active", "compile"],
      ["needs API key rotation", "blocked", undefined],
      ["docs", "todo", "none"], // ⚪ with the U+FE0F variation selector still counts
    ]);
    expect(b.columns[1]!.cards.map((c) => [c.title, c.status, c.tier])).toEqual([["typecheck", "done", "static"], ["a note, not a task", "info", undefined]]);
    // ids are unique and valid (Board.parse above checks the pattern)
    expect(new Set(b.columns.flatMap((c) => c.cards.map((x) => x.id))).size).toBe(6);
  });

  it("nested bullets become the card body; nested checkboxes stay readable", () => {
    const queue = parse(PLAN).columns[0]!.cards[1]!;
    expect(queue.body).toBe("• retries with backoff\n✓ unit tests\n☐ e2e");
    expect(parse(PLAN).columns[0]!.cards[0]!.body).toBeUndefined();
  });

  it("KPIs = done/total, in progress, blocked, todo (info notes are not tasks); blocked → banner", () => {
    const b = parse(PLAN);
    expect(kpi(b, "done")).toBe("2/5");
    expect(kpi(b, "in progress")).toBe("1");
    expect(kpi(b, "blocked")).toBe("1");
    expect(kpi(b, "todo")).toBe("1");
    expect(b.banner).toEqual({ text: "1 blocked: needs API key rotation", status: "blocked" });
  });

  it('"## Out of scope" → outOfScope (top-level items only); fences and deeper headings are ignored', () => {
    const b = parse(PLAN);
    expect(b.outOfScope).toEqual(["deploy to production", "web client"]);
    const titles = b.columns.flatMap((c) => c.cards.map((x) => x.title)).join("|");
    expect(titles).not.toContain("fence");
    expect(b.columns.map((c) => c.title)).not.toContain("not a heading");
  });

  it("all done → done banner; items before the first ## go to an implicit column", () => {
    const b = parse("- [x] one\n- [x] two\n");
    expect(b.title).toBe("Plan");
    expect(b.columns).toHaveLength(1);
    expect(b.columns[0]!.title).toBe("Tasks");
    expect(b.banner).toEqual({ text: "all 2 tasks done", status: "done" });
  });

  it("empty file → a valid board that says how to write one", () => {
    for (const md of ["", "\n\n", "# Only a title\n"]) {
      const b = parse(md);
      expect(b.columns).toEqual([{ id: "col1", title: "Plan", cards: [] }]);
      expect(b.banner?.status).toBe("info");
      expect(b.banner?.text).toMatch(/no tasks yet/);
      expect(kpi(b, "done")).toBe("0/0");
    }
  });

  it("oversized plans are cut to the board limits, and say so", () => {
    const many = Array.from({ length: BOARD_LIMITS.cardsPerColumn + 5 }, (_, i) => `- [ ] task ${i} ${"x".repeat(200)}`).join("\n");
    const cols = Array.from({ length: BOARD_LIMITS.columns + 2 }, (_, i) => `## C${i}\n${many}`).join("\n");
    const b = parse(cols);
    expect(b.columns).toHaveLength(BOARD_LIMITS.columns);
    expect(b.columns.flatMap((c) => c.cards)).toHaveLength(BOARD_LIMITS.cardsTotal);
    expect(b.subtitle).toMatch(/cut to the board limits/);
    expect(b.columns[0]!.cards[0]!.title.length).toBeLessThanOrEqual(BOARD_LIMITS.title);
  });
});

describe("plan board from the project's file (IO edge)", () => {
  const project = () => {
    const root = mkdtempSync(join(tmpdir(), "plan-"));
    mkdirSync(join(root, ".crewmux"));
    return root;
  };
  const boards = (root: string, planPath?: string) =>
    new ProjectBoards({ root, agentDir: join(root, ".crewmux"), now: () => MTIME, ...(planPath ? { planPath } : {}) });

  it("no plan file → no plan board, and it is not listed", () => {
    const root = project();
    expect(boards(root).get("plan")).toBeUndefined();
    expect(boards(root).list()).toEqual([]);
  });

  it("default paths: plan.md, PLAN.md, .crewmux/plan.md; re-read when the file changes", () => {
    const root = project();
    writeFileSync(join(root, ".crewmux/plan.md"), "- [ ] from agent dir\n");
    const b = boards(root);
    expect(b.get("plan")?.columns[0]!.cards[0]!.title).toBe("from agent dir");
    expect(b.get("plan")?.updatedBy).toBe(".crewmux/plan.md");
    writeFileSync(join(root, "plan.md"), "- [ ] first\n");
    utimesSync(join(root, "plan.md"), new Date(MTIME), new Date(MTIME));
    expect(b.get("plan")?.columns[0]!.cards[0]!.title).toBe("first");
    // same size, new mtime → re-parsed
    writeFileSync(join(root, "plan.md"), "- [x] first\n");
    utimesSync(join(root, "plan.md"), new Date(MTIME + 5000), new Date(MTIME + 5000));
    expect(b.get("plan")?.columns[0]!.cards[0]!.status).toBe("done");
    expect(b.get("plan")?.updatedAt).toBe(MTIME + 5000);
    expect(b.list()).toEqual([{ name: "plan", title: "Plan", kind: "plan", source: "file", updatedAt: MTIME + 5000, updatedBy: "plan.md" }]);
  });

  it("config.yaml boards.plan picks the file", () => {
    const root = project();
    mkdirSync(join(root, "docs"));
    writeFileSync(join(root, "plan.md"), "- [ ] default\n");
    writeFileSync(join(root, "docs/roadmap.md"), "- [ ] configured\n");
    expect(boards(root, "docs/roadmap.md").get("plan")?.columns[0]!.cards[0]!.title).toBe("configured");
  });

  it("an authored plan (update_board) wins over the file", () => {
    const root = project();
    writeFileSync(join(root, "plan.md"), "- [ ] from file\n");
    const b = boards(root);
    b.put(Board.parse({ name: "plan", updatedAt: 7, updatedBy: "planner", title: "Authored", columns: [{ id: "c", title: "c", cards: [] }] }));
    expect(b.get("plan")?.title).toBe("Authored");
    expect(b.list()).toEqual([{ name: "plan", title: "Authored", source: "agent", updatedAt: 7, updatedBy: "planner" }]);
  });

  it("negative: config paths that leave the project are rejected by the schema", () => {
    const cfg = (plan: string) => ProjectConfig.safeParse({ version: 1, project: "p", boards: { plan } });
    for (const bad of ["../plan.md", "/etc/passwd", "docs/../../x.md", "..\\x.md", "C:/x.md", ""]) expect(cfg(bad).success, bad).toBe(false);
    for (const ok of ["plan.md", "docs/roadmap.md", ".crewmux/plan.md"]) expect(cfg(ok).success, ok).toBe(true);
    expect(ProjectConfig.parse({ version: 1, project: "p" }).boards).toEqual({});
  });

  it("negative: a plan file that is a symlink out of the project is not read", () => {
    const root = project();
    const outside = mkdtempSync(join(tmpdir(), "outside-"));
    writeFileSync(join(outside, "private-notes.md"), "- [ ] OUTSIDE CONTENT\n");
    symlinkSync(join(outside, "private-notes.md"), join(root, "plan.md"));
    const b = boards(root).get("plan")!;
    expect(JSON.stringify(b)).not.toContain("OUTSIDE");
    expect(b.banner).toEqual({ text: "plan.md resolves outside the project — not shown", status: "blocked" });
    // a symlinked directory in the configured path is caught the same way
    symlinkSync(outside, join(root, "linked"));
    expect(JSON.stringify(boards(root, "linked/private-notes.md").get("plan"))).not.toContain("OUTSIDE");
  });
});
