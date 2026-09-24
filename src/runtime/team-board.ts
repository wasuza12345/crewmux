import { BOARD_LIMITS, TEAM_BOARD, USER, type AgentEnvelope, type Board, type BoardCard, type BoardEdge, type BoardStatus, type HarnessEvent } from "../protocol/index.js";

/**
 * The generated `team` board: who is running, who asks the human, who talks to whom.
 * Pure — rebuilt from the run's events + the configured roles on every request; never stored.
 */

export interface TeamRole {
  role: string;
  agent: string;
  status: string; // "running" | "starting" | "exited" | "stopped"
}

export interface TeamBoardInput {
  project: string;
  roles: TeamRole[]; // every role in roles.yaml (+ any running role not in it)
  events: HarnessEvent[]; // this run, oldest first
  now: number; // ms — the clock is passed in
}

const RECENT_PER_ROLE = 3;
const WAITS_FOR_REPLY = new Set<AgentEnvelope["type"]>(["request", "question", "review_request"]);

const clip = (s: string, max: number) => {
  const flat = s.replaceAll(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};
const hhmm = (ts: number) => new Date(ts).toTimeString().slice(0, 5);
const kTokens = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
/** Card ids must match the board schema: roles are lowercase/digits/"-", message ids are msg_<hex>. */
const roleCard = (role: string) => `role-${role}`;

export function teamBoard({ project, roles, events, now }: TeamBoardInput): Board {
  const usage = new Map<string, { tokens: number; window?: number }>();
  const compacted = new Map<string, number>();
  const failedCompact = new Map<string, number>();
  const messages: { envelope: AgentEnvelope; ts: number; delivered?: boolean }[] = [];
  const byId = new Map<string, (typeof messages)[number]>();
  const statusOf = new Map(roles.map((r) => [r.role, r.status]));

  for (const e of events) {
    if (e.type === "session.status") statusOf.set(e.session.role, e.session.status);
    else if (e.type === "session.usage") {
      if (e.tokens === undefined) usage.delete(e.role); // unknown again after a compaction — never show the old size
      else usage.set(e.role, { tokens: e.tokens, ...(e.window ? { window: e.window } : {}) });
    }
    else if (e.type === "session.compact") { compacted.set(e.role, e.ts); failedCompact.delete(e.role); }
    else if (e.type === "session.compact.failed") { compacted.delete(e.role); failedCompact.set(e.role, e.ts); }
    else if (e.type === "message") {
      const m = { envelope: e.envelope, ts: e.ts };
      messages.push(m);
      byId.set(e.envelope.id, m);
    } else if (e.type === "message.delivery") {
      const m = byId.get(e.messageId);
      if (m) m.delivered = e.ok;
    }
  }
  const allRoles = [...new Set([...roles.map((r) => r.role), ...statusOf.keys()])];
  const agentOf = new Map(roles.map((r) => [r.role, r.agent]));
  const running = (role: string) => statusOf.get(role) === "running" || statusOf.get(role) === "starting";

  // A question to the human is open until the asker says anything after it (the human answers
  // inside the agent's own CLI, which the harness never reads) or stops.
  const lastSent = new Map<string, (typeof messages)[number]>();
  for (const m of messages) lastSent.set(m.envelope.from, m);
  const openQuestions = messages.filter((m) =>
    m.envelope.to === USER && m.envelope.type === "question" && running(m.envelope.from) && lastSent.get(m.envelope.from) === m);

  // A request/question/review_request waits for a reply until the recipient sends anything back.
  const answered = (m: (typeof messages)[number]) =>
    messages.some((r) => r.ts >= m.ts && r !== m && r.envelope.from === m.envelope.to && (r.envelope.to === m.envelope.from || r.envelope.replyTo === m.envelope.id));

  const contextText = (role: string) => {
    const u = usage.get(role);
    if (!u) return undefined;
    return u.window ? `context ${Math.round((u.tokens / u.window) * 100)}% (${kTokens(u.tokens)} of ${kTokens(u.window)})` : `context ${kTokens(u.tokens)} tokens`;
  };

  const columns = allRoles.slice(0, BOARD_LIMITS.columns - 1).map((role) => {
    const asking = openQuestions.some((q) => q.envelope.from === role);
    const state = asking ? "asking" : running(role) ? "running" : "stopped";
    const status: BoardStatus = asking ? "blocked" : running(role) ? "active" : "todo";
    const body = [
      contextText(role),
      compacted.has(role) ? `last compact ${hhmm(compacted.get(role)!)}` : undefined,
      failedCompact.has(role) ? `compact ${hhmm(failedCompact.get(role)!)} did not take effect` : undefined,
    ].filter(Boolean).join(" · ");
    const cards: BoardCard[] = [{
      id: roleCard(role), title: role, status,
      ...(body ? { body } : {}),
      tags: [state, ...(agentOf.get(role) ? [agentOf.get(role)!] : [])],
    }];
    for (const q of openQuestions.filter((x) => x.envelope.from === role)) {
      cards.push({ id: q.envelope.id, title: "asks you", body: clip(q.envelope.content, 600), status: "blocked", tags: [hhmm(q.ts), "C-b a"] });
    }
    const recent = messages.filter((m) => m.envelope.from === role && !(m.envelope.to === USER && m.envelope.type === "question")).slice(-RECENT_PER_ROLE);
    for (const m of recent) {
      const failed = m.delivered === false;
      const status: BoardStatus = failed ? "blocked" : m.envelope.to === USER || m.delivered ? (WAITS_FOR_REPLY.has(m.envelope.type) && !answered(m) ? "active" : "done") : "active";
      cards.push({
        id: m.envelope.id,
        title: clip(`→ ${m.envelope.to === USER ? "you" : m.envelope.to} · ${m.envelope.type}${m.envelope.verdict ? `:${m.envelope.verdict}` : ""}`, BOARD_LIMITS.title),
        body: clip(m.envelope.content, 400),
        status,
        tags: [hhmm(m.ts), ...(failed ? ["not delivered"] : m.delivered === undefined && m.envelope.to !== USER ? ["pending"] : [])],
      });
    }
    return { id: `col-${role}`, title: role, cards };
  });

  // Who talks to whom: one edge per pair, dashed while the latest message of that pair waits for a reply.
  const shown = new Set(allRoles.slice(0, BOARD_LIMITS.columns - 1));
  const pairs = new Map<string, (typeof messages)[number][]>();
  for (const m of messages) {
    const { from, to } = m.envelope;
    if (to === USER || !shown.has(from) || !shown.has(to)) continue;
    const key = `${from}\u0000${to}`;
    pairs.set(key, [...(pairs.get(key) ?? []), m]);
  }
  const edges: BoardEdge[] = [...pairs.values()].slice(0, BOARD_LIMITS.edges).map((list) => {
    const last = list.at(-1)!;
    const waiting = WAITS_FOR_REPLY.has(last.envelope.type) && !answered(last);
    return {
      from: roleCard(last.envelope.from), to: roleCard(last.envelope.to),
      style: waiting ? "dashed" : "solid",
      label: waiting ? `${list.length} · waiting` : `${list.length} msg${list.length === 1 ? "" : "s"}`,
    };
  });

  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);
  const today = messages.filter((m) => m.ts >= dayStart.getTime()).length;
  const runningCount = allRoles.filter(running).length;
  const totalTokens = allRoles.filter(running).reduce((n, r) => n + (usage.get(r)?.tokens ?? 0), 0);

  const banner = openQuestions.length
    ? { text: `${openQuestions.length} agent question${openQuestions.length === 1 ? "" : "s"} waiting for you — Ctrl-b a jumps to the asker`, status: "blocked" as const }
    : runningCount
      ? { text: `${runningCount} agent${runningCount === 1 ? "" : "s"} running`, status: "active" as const }
      : { text: "no agent is running — Ctrl-b n opens one", status: "info" as const };

  return {
    name: TEAM_BOARD,
    title: `Team — ${clip(project, 100)}`,
    subtitle: "generated by the harness from sessions and messages · read-only",
    updatedAt: now,
    updatedBy: "harness",
    banner,
    kpis: [
      { label: "agents running", value: `${runningCount} / ${allRoles.length}`, status: runningCount ? "active" : "todo" },
      { label: "messages today", value: String(today), status: "info" },
      { label: "open questions", value: String(openQuestions.length), status: openQuestions.length ? "blocked" : "done" },
      { label: "total context", value: totalTokens ? `${kTokens(totalTokens)} tokens` : "unknown", status: "info", hint: "sum over running agents, as last read from their CLIs" },
    ],
    columns: columns.length ? columns : [{ id: "col-none", title: "no roles", cards: [] }],
    edges,
  };
}
