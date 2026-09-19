import type { HarnessEvent, MessageType, ReviewVerdict } from "../protocol/index.js";

/** The sidebar/popup view of a run, rebuilt from events only (never from agent screens). Pure. */

export type RoleStatus = "running" | "exited" | "not started";

export interface PanelRole {
  role: string;
  vendor: string;
  color: string; // #rrggbb
  status: RoleStatus;
  tokens?: number;
  window?: number;
  compactedAt?: number;
}

export interface FeedItem {
  id: string;
  ts: number;
  from: string;
  to: string;
  type: MessageType;
  verdict?: ReviewVerdict;
  content: string;
  delivered?: boolean; // undefined = pending
}

export interface PanelState {
  roles: PanelRole[];
  feed: FeedItem[];
}

const NEW_ROLE_COLOR = "#c8d0c9";

export const initialState = (roles: Omit<PanelRole, "status">[]): PanelState => ({
  roles: roles.map((r) => ({ ...r, status: "not started" })),
  feed: [],
});

export function reduce(state: PanelState, e: HarnessEvent): PanelState {
  switch (e.type) {
    case "session.status": {
      const status: RoleStatus = e.session.status === "exited" ? "exited" : "running";
      // A role opened at runtime may be newer than the roles.yaml this panel started with.
      const known = state.roles.some((r) => r.role === e.session.role);
      const roles = known ? state.roles : [...state.roles, { role: e.session.role, vendor: e.session.kind, color: NEW_ROLE_COLOR, status }];
      return { ...state, roles: roles.map((r) => (r.role === e.session.role ? { ...r, status } : r)) };
    }
    case "message": {
      const m = e.envelope;
      const item: FeedItem = { id: m.id, ts: e.ts, from: m.from, to: m.to, type: m.type, content: m.content, ...(m.verdict ? { verdict: m.verdict } : {}) };
      return { ...state, feed: [...state.feed, item] };
    }
    case "session.usage":
      return { ...state, roles: state.roles.map((r) => (r.role === e.role ? { ...r, tokens: e.tokens, ...(e.window ? { window: e.window } : {}) } : r)) };
    case "session.compact":
      return { ...state, roles: state.roles.map((r) => (r.role === e.role ? { ...r, compactedAt: e.ts } : r)) };
    case "message.delivery":
      return { ...state, feed: state.feed.map((f) => (f.id === e.messageId ? { ...f, delivered: e.ok } : f)) };
    default:
      return state;
  }
}

/* ── rendering ─────────────────────────────────────────── */

interface Seg { text: string; color?: string; dim?: boolean; bold?: boolean }
type Line = Seg[];

const USER_COLOR = "#e07a7a";
const OK = "#57c28d";
const WARN = "#e3a857";

/** Visible width: combining marks (Thai vowels/tones etc.) take no column. */
export const visibleWidth = (s: string): number => [...s.replace(/\p{M}/gu, "")].length;

function truncate(s: string, width: number): string {
  if (visibleWidth(s) <= width) return s;
  let out = "";
  for (const ch of s) {
    if (visibleWidth(out + ch) > width - 1) break;
    out += ch;
  }
  return `${out}…`;
}

/** Word wrap; words longer than the line are broken by character. */
function wrap(s: string, width: number): string[] {
  const lines: string[] = [];
  for (const para of s.split("\n")) {
    let cur = "";
    for (const word of para.split(/(\s+)/)) {
      if (visibleWidth(cur + word) <= width) { cur += word; continue; }
      if (cur.trim()) lines.push(cur.trimEnd());
      cur = word.trimStart();
      while (visibleWidth(cur) > width) {
        let head = "";
        for (const ch of cur) { if (visibleWidth(head + ch) > width) break; head += ch; }
        lines.push(head);
        cur = cur.slice(head.length);
      }
    }
    lines.push(cur.trimEnd());
  }
  return lines;
}

const ansiColor = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  return `\x1b[38;2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}m`;
};

function renderLine(line: Line, width: number, ansi: boolean): string {
  let used = 0;
  let out = "";
  for (const seg of line) {
    const room = width - used;
    if (room <= 0) break;
    const text = visibleWidth(seg.text) > room ? truncate(seg.text, room) : seg.text;
    used += visibleWidth(text);
    if (!ansi) { out += text; continue; }
    const style = `${seg.bold ? "\x1b[1m" : ""}${seg.dim ? "\x1b[2m" : ""}${seg.color ? ansiColor(seg.color) : ""}`;
    out += style ? `${style}${text}\x1b[0m` : text;
  }
  return out;
}

const hhmm = (ts: number) => new Date(ts).toTimeString().slice(0, 5);

/** "45%" (warn ≥ 70%) when the window is known, else "312k"; "⟳" after a compaction. */
function contextSeg(r: PanelRole): Seg[] {
  if (r.tokens === undefined) return r.compactedAt ? [{ text: "⟳", dim: true }] : [];
  const pct = r.window ? Math.round((r.tokens / r.window) * 100) : undefined;
  const label = pct !== undefined ? `${pct}%` : `${Math.round(r.tokens / 1000)}k`;
  return [{ text: label + (r.compactedAt ? "⟳" : ""), ...(pct !== undefined && pct >= 70 ? { color: WARN } : { dim: true }) }];
}
const dot = (s: RoleStatus) => (s === "running" ? "●" : "○");
const shortType: Record<MessageType, string> = { request: "req", question: "ask", answer: "ans", info: "info", review_request: "review?", review_result: "review" };

export interface RenderOptions {
  width: number;
  height: number;
  mode: "side" | "popup";
  viewer?: string; // role whose window this panel sits in
  ansi?: boolean; // false in tests
}

export function renderPanel(state: PanelState, opts: RenderOptions): string[] {
  const { width, height, mode } = opts;
  const ansi = opts.ansi ?? true;
  const colorOf = (role: string) => (role === "user" ? USER_COLOR : state.roles.find((r) => r.role === role)?.color);
  const name = (role: string): Seg => ({ text: role === "user" ? "you" : role, ...(colorOf(role) ? { color: colorOf(role)! } : {}) });

  const head: Line[] = [[{ text: "AGENTS", dim: true }]];
  const roleCol = Math.min(14, Math.max(...state.roles.map((r) => r.role.length), 4) + 1);
  for (const r of state.roles) {
    head.push([
      { text: `${dot(r.status)} `, color: r.status === "running" ? OK : "#66716b" },
      { text: r.role.padEnd(roleCol), color: r.color },
      { text: r.vendor.padEnd(7), dim: true },
      ...(r.status !== "running" ? [{ text: r.status, dim: true }] : contextSeg(r)),
      ...(r.role === opts.viewer ? [{ text: " ◀", dim: true }] : []),
    ]);
  }

  const questions = state.feed.filter((f) => f.to === "user" && f.type === "question").slice(-3);
  if (questions.length) {
    head.push([], [{ text: `ASKING YOU (${questions.length})`, color: USER_COLOR, bold: true }]);
    for (const q of questions) {
      head.push([name(q.from), { text: ` ${hhmm(q.ts)}`, dim: true }]);
      for (const l of wrap(q.content, width - 2).slice(0, mode === "side" ? 2 : 6)) head.push([{ text: `  ${l}`, color: WARN }]);
    }
    head.push([{ text: "  C-b a → answer in its window", dim: true }]);
  }

  const footer: Line[] = mode === "side"
    ? [[{ text: "M-1..9", color: "#3fb68b" }, { text: " agent  ", dim: true }, { text: "C-b m", color: "#3fb68b" }, { text: " all", dim: true }],
       [{ text: "C-b a", color: "#3fb68b" }, { text: " answer ", dim: true }, { text: "q", color: "#3fb68b" }, { text: " here: leave", dim: true }]]
    : [[{ text: "q / Esc", color: "#3fb68b" }, { text: " close", dim: true }]];

  const room = Math.max(0, height - head.length - footer.length - 2);
  const msgLines: Line[] = [];
  for (const f of state.feed) {
    const status: Seg = f.to === "user" ? { text: "" } : f.delivered === undefined ? { text: " …", dim: true } : f.delivered ? { text: " ✓", color: OK } : { text: " ✗", color: USER_COLOR };
    msgLines.push([{ text: `${hhmm(f.ts)} `, dim: true }, name(f.from), { text: "→", dim: true }, name(f.to), { text: ` ${shortType[f.type]}${f.verdict ? `:${f.verdict}` : ""}`, dim: true }, status]);
    const body = mode === "side" ? [truncate(f.content.replaceAll("\n", " "), width - 2)] : wrap(f.content, width - 2);
    for (const l of body) msgLines.push([{ text: `  ${l}` }]);
  }
  const shown = msgLines.slice(-room);
  const body: Line[] = [[], [{ text: "MESSAGES", dim: true }], ...(shown.length ? shown : [[{ text: "  none yet", dim: true }]])];

  const lines = [...head, ...body];
  while (lines.length < height - footer.length) lines.push([]);
  return [...lines.slice(0, height - footer.length), ...footer].map((l) => renderLine(l, width, ansi));
}
