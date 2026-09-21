import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Board, BOARD_LIMITS, BoardContent, BoardName, boardListUrl, boardUrl, type HarnessEvent } from "../src/protocol/index.js";
import { BoardStore, readBoardView, writeBoardView, boardViewFile, removeBoardView } from "../src/persistence/boards.js";
import { teamBoard } from "../src/runtime/team-board.js";
import { BOARD_PAGE, exportFileName, scriptSafeJson, snapshotHtml, SNAPSHOT_MARKER } from "../src/runtime/board-export.js";
import { initialState, renderPanel, visibleWidth } from "../src/ui/panel.js";

const card = (id: string, extra: Record<string, unknown> = {}) => ({ id, title: `card ${id}`, status: "todo", ...extra });
const content = (extra: Record<string, unknown> = {}) => ({ title: "Plan", columns: [{ id: "c1", title: "Now", cards: [card("a"), card("b")] }], ...extra });

describe("board schema", () => {
  it("accepts a full board and fills defaults", () => {
    const b = BoardContent.parse(content({
      subtitle: "s", banner: { text: "hi", status: "info" },
      kpis: [{ label: "tests", value: "13/13", status: "done", hint: "vitest" }],
      edges: [{ from: "a", to: "b" }, { from: "b", to: "a", style: "dotted", label: "ref" }],
      outOfScope: ["deploy"],
    }));
    expect(b.edges[0]).toEqual({ from: "a", to: "b", style: "solid" });
    expect(BoardContent.parse(content()).kpis).toEqual([]);
    for (const tier of ["runtime", "compile", "static", "none"]) expect(BoardContent.safeParse(content({ columns: [{ id: "c", title: "c", cards: [card("x", { tier })] }] })).success).toBe(true);
  });

  it("rejects unknown status/tier/style, bad ids, duplicate ids and dangling edges", () => {
    const bad = [
      content({ columns: [{ id: "c", title: "c", cards: [card("x", { status: "finished" })] }] }),
      content({ columns: [{ id: "c", title: "c", cards: [card("x", { tier: "vibes" })] }] }),
      content({ edges: [{ from: "a", to: "b", style: "wavy" }] }),
      content({ columns: [{ id: "c", title: "c", cards: [card("has space")] }] }),
      content({ columns: [{ id: "c", title: "c", cards: [card("a"), card("a")] }] }),
      content({ edges: [{ from: "a", to: "ghost" }] }),
      content({ columns: [] }),
      { columns: [{ id: "c", title: "c", cards: [] }] }, // no title
    ];
    for (const b of bad) expect(BoardContent.safeParse(b).success, JSON.stringify(b)).toBe(false);
  });

  it("enforces size limits", () => {
    const long = "x".repeat(BOARD_LIMITS.text + 1);
    expect(BoardContent.safeParse(content({ columns: [{ id: "c", title: "c", cards: [card("a", { body: long })] }] })).success).toBe(false);
    expect(BoardContent.safeParse(content({ title: "x".repeat(BOARD_LIMITS.title + 1) })).success).toBe(false);
    const many = (n: number, p: string) => Array.from({ length: n }, (_, i) => card(`${p}${i}`));
    expect(BoardContent.safeParse(content({ columns: [{ id: "c", title: "c", cards: many(BOARD_LIMITS.cardsPerColumn + 1, "a") }] })).success).toBe(false);
    // per-column limits are fine but the board total is not
    const cols = Array.from({ length: 5 }, (_, c) => ({ id: `c${c}`, title: "c", cards: many(BOARD_LIMITS.cardsPerColumn, `k${c}-`) }));
    const total = BoardContent.safeParse(content({ columns: cols }));
    expect(total.success).toBe(false);
    expect(total.error?.issues.map((i) => i.message).join()).toMatch(/too many cards/);
    expect(BoardContent.safeParse(content({ columns: Array.from({ length: BOARD_LIMITS.columns + 1 }, (_, i) => ({ id: `c${i}`, title: "c", cards: [] })) })).success).toBe(false);
    expect(BoardContent.safeParse(content({ columns: [{ id: "c", title: "c", cards: [card("a", { tags: Array(BOARD_LIMITS.tags + 1).fill("t") })] }] })).success).toBe(false);
  });

  it("board names are lowercase slugs (they become file names)", () => {
    for (const ok of ["plan", "release-1", "a"]) expect(BoardName.safeParse(ok).success).toBe(true);
    for (const bad of ["", "Plan", "../x", "a/b", "a.json", "-x", "x".repeat(41)]) expect(BoardName.safeParse(bad).success, bad).toBe(false);
  });
});

describe("board storage", () => {
  const board = (name: string): Board => Board.parse({ name, updatedAt: 1, updatedBy: "planner", ...content() });

  it("writes atomically (no temp file left), reads back, lists names", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "boards-")), "boards");
    const store = new BoardStore(dir);
    expect(store.names()).toEqual([]);
    store.put(board("plan"));
    store.put(board("alpha"));
    expect(readdirSync(dir).sort()).toEqual(["alpha.json", "plan.json"]);
    expect(store.get("plan")).toEqual(board("plan"));
    expect(store.get("missing")).toBeUndefined();
    expect(store.get("../etc")).toBeUndefined();
    expect(store.names()).toEqual(["alpha", "plan"]);
  });

  it("a hand-edited file that breaks the schema is reported, not served", () => {
    const dir = mkdtempSync(join(tmpdir(), "boards-"));
    writeFileSync(join(dir, "plan.json"), JSON.stringify({ name: "plan", title: "x" }));
    expect(() => new BoardStore(dir).get("plan")).toThrow(/plan\.json is invalid/);
  });

  it("the view token file is mode 0600 and removed on stop", () => {
    const agentDir = mkdtempSync(join(tmpdir(), "crewmux-"));
    writeBoardView(agentDir, { runId: "r_1", origin: "http://127.0.0.1:5", token: "tok" });
    expect(statSync(boardViewFile(agentDir)).mode & 0o777).toBe(0o600);
    const view = readBoardView(agentDir)!;
    expect(boardUrl(view)).toBe("http://127.0.0.1:5/board/team?t=tok");
    removeBoardView(agentDir);
    expect(existsSync(boardViewFile(agentDir))).toBe(false);
    expect(readBoardView(agentDir)).toBeUndefined();
  });
});

describe("team board (generated, pure)", () => {
  const NOW = new Date("2026-09-21T15:00:00").getTime();
  let n = 0;
  const ev = (ts: number, e: Record<string, unknown>) => ({ id: `e${n++}`, ts, runId: "r_1", ...e }) as HarnessEvent;
  const session = (ts: number, role: string, status: string) => ev(ts, { type: "session.status", session: { id: `s_${role}`, runId: "r_1", role, agentId: "fake", kind: "custom", cwd: "/", window: "@1", pane: "%1", status } });
  const msg = (ts: number, id: string, from: string, to: string, type: string, content: string) => ev(ts, { type: "message", envelope: { id, from, to, type, content, artifacts: [] } });
  const delivered = (ts: number, id: string, to: string) => ev(ts, { type: "message.delivery", messageId: id, to, ok: true });
  const yesterday = new Date("2026-09-20T23:00:00").getTime();

  const events = [
    session(yesterday, "planner", "running"),
    session(yesterday, "coder", "running"),
    msg(yesterday, "msg_old", "planner", "coder", "info", "yesterday"),
    delivered(yesterday, "msg_old", "coder"),
    msg(NOW - 5000, "msg_req", "planner", "coder", "request", "implement it"),
    delivered(NOW - 4000, "msg_req", "coder"),
    msg(NOW - 3000, "msg_ask", "coder", "user", "question", "merge now?"),
    ev(NOW - 2000, { type: "session.usage", role: "coder", tokens: 50000, window: 200000 }),
    ev(NOW - 2000, { type: "session.usage", role: "planner", tokens: 30000 }),
    ev(NOW - 1000, { type: "session.compact", role: "planner", by: "user" }),
  ];
  const roles = [
    { role: "planner", agent: "fake", status: "running" },
    { role: "coder", agent: "fake", status: "running" },
    { role: "reviewer", agent: "fake", status: "stopped" },
  ];

  it("is a valid board: one column per role, KPIs from the clock and events", () => {
    const b = teamBoard({ project: "demo", roles, events, now: NOW });
    expect(() => Board.parse(b)).not.toThrow();
    expect(b.name).toBe("team");
    expect(b.updatedAt).toBe(NOW);
    expect(b.columns.map((c) => c.title)).toEqual(["planner", "coder", "reviewer"]);
    expect(Object.fromEntries(b.kpis.map((k) => [k.label, k.value]))).toEqual({
      "agents running": "2 / 3", "messages today": "2", "open questions": "1", "total context": "80k tokens",
    });
    expect(b.banner?.status).toBe("blocked");
  });

  it("role cards: running / asking / stopped, context %, last compact", () => {
    const b = teamBoard({ project: "demo", roles, events, now: NOW });
    const head = (role: string) => b.columns.find((c) => c.title === role)!.cards[0]!;
    expect(head("coder")).toMatchObject({ id: "role-coder", status: "blocked", tags: ["asking", "fake"], body: "context 25% (50k of 200k)" });
    expect(head("planner").status).toBe("active");
    expect(head("planner").body).toMatch(/^context 30k tokens · last compact \d\d:\d\d$/);
    expect(head("reviewer")).toMatchObject({ status: "todo", tags: ["stopped", "fake"] });
    const question = b.columns.find((c) => c.title === "coder")!.cards.find((c) => c.id === "msg_ask")!;
    expect(question).toMatchObject({ title: "asks you", body: "merge now?", status: "blocked" });
  });

  it("edges: dashed while a request waits for a reply, solid once answered", () => {
    const waiting = teamBoard({ project: "demo", roles, events, now: NOW });
    expect(waiting.edges).toEqual([{ from: "role-planner", to: "role-coder", style: "dashed", label: "2 · waiting" }]);
    const answered = teamBoard({ project: "demo", roles, now: NOW, events: [...events, msg(NOW, "msg_ans", "coder", "planner", "answer", "done"), delivered(NOW, "msg_ans", "planner")] });
    expect(answered.edges).toEqual([
      { from: "role-planner", to: "role-coder", style: "solid", label: "2 msgs" },
      { from: "role-coder", to: "role-planner", style: "solid", label: "1 msg" },
    ]);
    // the coder spoke after asking → its question is no longer open
    expect(answered.kpis.find((k) => k.label === "open questions")?.value).toBe("0");
  });

  it("no roles / no events still renders a valid board", () => {
    const b = teamBoard({ project: "empty", roles: [], events: [], now: NOW });
    expect(() => Board.parse(b)).not.toThrow();
    expect(b.banner?.status).toBe("info");
  });
});

describe("sidebar board line", () => {
  const url = boardListUrl({ origin: "http://127.0.0.1:43123", token: "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG" });
  const state = initialState([{ role: "planner", vendor: "claude", color: "#fff" }]);

  it("side: one short hint above the key hints (no truncated URL); popup: the full list URL", () => {
    expect(url).toBe("http://127.0.0.1:43123/board?t=abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG");
    const side = renderPanel(state, { width: 32, height: 16, mode: "side", ansi: false, board: url });
    for (const l of side) expect(visibleWidth(l)).toBeLessThanOrEqual(32);
    expect(side.at(-3)).toBe("C-b B board · URL: C-b m");
    expect(side.join("\n")).not.toContain("http");
    const popup = renderPanel(state, { width: 30, height: 20, mode: "popup", ansi: false, board: url }).join("");
    expect(popup.replaceAll(" ", "")).toContain(`boards:${url}`);
    expect(renderPanel(state, { width: 32, height: 16, mode: "side", ansi: false }).join("\n")).not.toContain("C-b B");
  });
});

describe("board export (snapshot HTML)", () => {
  const evil = "</script><img src=x onerror=alert(1)><!-- $& $' \u2028\u2029";
  const board: Board = Board.parse({
    name: "release-1", updatedAt: 1, updatedBy: "coder", kind: "release",
    ...content({ columns: [{ id: "c1", title: evil, cards: [card("a", { title: evil, body: evil, tags: ["<b>x</b>"] })] }] }),
    banner: { text: `NO-GO ${evil}`, status: "blocked" },
  });
  const template = readFileSync(BOARD_PAGE, "utf8");

  it("the shipped template has the marker once and the snapshot code path", () => {
    expect(template.split(SNAPSHOT_MARKER)).toHaveLength(2);
    expect(template).toContain('getElementById("board-snapshot")');
  });

  it("embeds the data as inert JSON: a card title with </script><img onerror> cannot break out", () => {
    const at = Date.UTC(2026, 8, 21, 10, 5);
    const html = snapshotHtml(template, board, at);
    expect(html).not.toContain(SNAPSHOT_MARKER);
    expect(html).not.toContain("<img");
    expect(html).not.toMatch(/[\u2028\u2029]/);
    // exactly one extra </script>: ours. The JSON runs up to it and parses back to the same board.
    expect(html.split("</script>").length).toBe(template.split("</script>").length + 1);
    const json = /<script type="application\/json" id="board-snapshot">([^]*?)<\/script>/.exec(html)![1]!;
    expect(JSON.parse(json)).toEqual({ board, exportedAt: at });
    // "$&" / "$'" in board text must not be expanded by String.replace
    expect(JSON.parse(json).board.columns[0].title).toBe(evil);
    // no network from a file: a meta CSP stands in for the server's header
    expect(html).toMatch(/<meta http-equiv="Content-Security-Policy" content="default-src 'none';/);
    expect(scriptSafeJson({ s: "<&>\u2028" })).toBe('{"s":"\\u003c\\u0026\\u003e\\u2028"}');
  });

  it("default file name is <name>-<yyyymmdd-hhmm>.html (local time)", () => {
    expect(exportFileName("plan", new Date(2026, 0, 2, 3, 4))).toBe("plan-20260102-0304.html");
  });
});
