import { BOARD_LIMITS, PLAN_BOARD, type Board, type BoardCard, type BoardColumn, type BoardKpi, type BoardStatus, type ProofTier } from "../protocol/index.js";

/**
 * The generated `plan` board: a markdown checklist → columns of cards. Pure (text in → Board out);
 * the file is read by project-boards.ts. Convention (documented in docs/agent-guide.md §5.2):
 *
 *   # Title                     → board title (first H1); the first paragraph under it → subtitle
 *   ## Heading                  → a column  ("## Out of scope" → the out-of-scope list instead)
 *   - [x] / - [ ] / - [~] / - [!] → card: done / todo / active / blocked   (a plain "- item" → info)
 *   🟢 🟡 🟠 ⚪ on the item line → proof tier runtime / compile / static / none
 *   indented lines under an item → the card body
 *
 * Deeper headings, paragraphs and fenced code are ignored. Oversized plans are cut to the board limits.
 */

export interface PlanInput {
  markdown: string;
  source: string; // path relative to the project root, shown as "updated by"
  mtime: number; // ms — the file's modification time
}

const MARK: Record<string, BoardStatus> = { x: "done", X: "done", " ": "todo", "~": "active", "!": "blocked" };
const TIERS: [string, ProofTier][] = [["🟢", "runtime"], ["🟡", "compile"], ["🟠", "static"], ["⚪", "none"]];
const ITEM = /^(?:[-*+]|\d+[.)])\s+(?:\[([ xX~!])\]\s+)?(.*)$/;
const OUT_OF_SCOPE = /^out[\s-]+of[\s-]+scope\b/i;

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
const indentOf = (line: string) => line.replace(/\t/g, "    ").search(/\S/);

function tierOf(text: string): { text: string; tier?: ProofTier } {
  let tier: ProofTier | undefined;
  let out = text;
  for (const [emoji, t] of TIERS) {
    if (out.includes(emoji)) {
      tier ??= t; // the first emoji listed wins if a line has several (a line should carry one)
      out = out.replaceAll(emoji, "");
    }
  }
  out = out.replaceAll("\uFE0F", "").replace(/\s{2,}/g, " ").trim();
  return tier ? { text: out, tier } : { text: out };
}

export function planBoard({ markdown, source, mtime }: PlanInput): Board {
  let title: string | undefined;
  let subtitle: string | undefined;
  const columns: { title: string; items: { status: BoardStatus; title: string; tier?: ProofTier; body: string[] }[] }[] = [];
  const outOfScope: string[] = [];
  let section: "intro" | "column" | "oos" = "intro";
  let card: (typeof columns)[number]["items"][number] | undefined;
  let inFence = false;

  const column = () => {
    if (section === "intro") {
      // Items before the first "## heading" still count: they go into an implicit column.
      columns.push({ title: "Tasks", items: [] });
      section = "column";
    }
    return columns.at(-1)!;
  };

  for (const raw of markdown.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(raw)) { inFence = !inFence; card = undefined; continue; }
    if (inFence) continue;
    const line = raw.trimEnd();
    if (!line.trim()) continue; // blank lines do not end a list item

    const heading = /^(#{1,6})\s+(.*?)\s*#*$/.exec(line);
    if (heading) {
      card = undefined;
      const [, hashes, text] = heading;
      if (hashes === "#") title ??= text!;
      else if (hashes === "##") {
        if (OUT_OF_SCOPE.test(text!)) section = "oos";
        else { columns.push({ title: text! || "Untitled", items: [] }); section = "column"; }
      }
      continue; // ### and deeper: ignored
    }

    const indent = indentOf(line);
    const item = ITEM.exec(line.trim());
    if (indent >= 2 && card) {
      // Nested bullet or continuation → card body. Nested checkboxes keep their mark readable.
      const nested = item ? `${item[1] === undefined ? "•" : MARK[item[1]] === "done" ? "✓" : "☐"} ${item[2]}` : line.trim();
      card.body.push(`${" ".repeat(Math.max(0, Math.min(indent - 2, 8)))}${nested}`);
      continue;
    }
    if (!item || indent >= 2) {
      card = undefined; // a paragraph ends the current item
      if (section === "intro" && !item) subtitle ??= line.trim();
      continue;
    }
    const [, mark, text] = item;
    if (section === "oos") {
      card = undefined;
      outOfScope.push(tierOf(text!).text);
      continue;
    }
    const { text: cardTitle, tier } = tierOf(text!);
    card = { status: mark === undefined ? "info" : MARK[mark]!, title: cardTitle || "(untitled)", ...(tier ? { tier } : {}), body: [] };
    column().items.push(card);
  }

  // Build within the board limits; say so when something was cut instead of failing the whole board.
  let truncated = columns.length > BOARD_LIMITS.columns;
  let total = 0;
  const cols: BoardColumn[] = columns.slice(0, BOARD_LIMITS.columns).map((c, ci) => {
    const room = Math.max(0, Math.min(BOARD_LIMITS.cardsPerColumn, BOARD_LIMITS.cardsTotal - total));
    if (c.items.length > room) truncated = true;
    const cards = c.items.slice(0, room).map((it, i): BoardCard => ({
      id: `c${ci + 1}-${i + 1}`,
      title: clip(it.title, BOARD_LIMITS.title),
      status: it.status,
      ...(it.tier ? { tier: it.tier } : {}),
      ...(it.body.length ? { body: clip(it.body.join("\n"), BOARD_LIMITS.text) } : {}),
    }));
    total += cards.length;
    return { id: `col${ci + 1}`, title: clip(c.title, BOARD_LIMITS.title), cards };
  });
  if (!cols.length) cols.push({ id: "col1", title: "Plan", cards: [] });
  if (outOfScope.length > BOARD_LIMITS.outOfScope) truncated = true;

  const cards = cols.flatMap((c) => c.cards);
  const count = (s: BoardStatus) => cards.filter((c) => c.status === s).length;
  const done = count("done"), active = count("active"), blocked = count("blocked"), todo = count("todo");
  const tasks = done + active + blocked + todo; // info items are notes, not tasks
  const kpis: BoardKpi[] = [
    { label: "done", value: `${done}/${tasks}`, status: tasks && done === tasks ? "done" : "active", ...(tasks ? { hint: `${Math.round((done / tasks) * 100)}%` } : {}) },
    { label: "in progress", value: String(active), ...(active ? { status: "active" as const } : {}) },
    { label: "blocked", value: String(blocked), status: blocked ? "blocked" : "done" },
    { label: "todo", value: String(todo), ...(todo ? { status: "todo" as const } : {}) },
  ];
  const blockedTitles = cards.filter((c) => c.status === "blocked").map((c) => c.title);
  const banner = blocked
    ? { text: clip(`${blocked} blocked: ${blockedTitles.join(" · ")}`, 500), status: "blocked" as const }
    : tasks && done === tasks
      ? { text: `all ${tasks} tasks done`, status: "done" as const }
      : !tasks
        ? { text: `${clip(source, 200)} has no tasks yet — use "## Column" headings and "- [ ] task" items`, status: "info" as const }
        : undefined;
  const sub = [subtitle, truncated ? `(cut to the board limits — split ${source} into smaller plans)` : undefined].filter(Boolean).join(" ");

  return {
    name: PLAN_BOARD,
    kind: "plan",
    title: clip(title?.trim() || "Plan", BOARD_LIMITS.title),
    ...(sub ? { subtitle: clip(sub, 300) } : {}),
    ...(banner ? { banner } : {}),
    kpis,
    columns: cols,
    edges: [],
    ...(outOfScope.length ? { outOfScope: outOfScope.slice(0, BOARD_LIMITS.outOfScope).map((t) => clip(t || "(empty)", 300)) } : {}),
    updatedAt: mtime,
    updatedBy: clip(source, 200),
  };
}

/** A plan board that only explains why the plan file could not be shown (e.g. it points outside the project). */
export function planNotice(source: string, text: string, now: number): Board {
  return {
    name: PLAN_BOARD, kind: "plan", title: "Plan", updatedAt: now, updatedBy: clip(source, 200),
    banner: { text: clip(text, 500), status: "blocked" }, kpis: [], edges: [],
    columns: [{ id: "col1", title: "Plan", cards: [] }],
  };
}
