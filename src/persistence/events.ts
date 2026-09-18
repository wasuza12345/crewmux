import { HarnessEvent } from "../protocol/index.js";
import type { Db } from "./sqlite.js";

export class EventStore {
  private readonly insert;
  private readonly byRun;

  constructor(private readonly db: Db) {
    this.insert = db.readonly ? undefined : db.prepare("INSERT INTO events (id, ts, run_id, type, body) VALUES (?, ?, ?, ?, ?)");
    this.byRun = db.prepare("SELECT body FROM events WHERE run_id = ? ORDER BY seq");
  }

  /** Events of a run after `seq`, oldest first — used to tail the log. */
  since(runId: string, seq: number): { seq: number; event: HarnessEvent }[] {
    return (this.db.prepare("SELECT seq, body FROM events WHERE run_id = ? AND seq > ? ORDER BY seq").all(runId, seq) as { seq: number; body: string }[])
      .map((r) => ({ seq: r.seq, event: HarnessEvent.parse(JSON.parse(r.body)) }));
  }

  /** Latest recorded session of a role in any run (for resume). */
  lastSession(role: string): { id: string; kind: string; cwd: string; providerSessionId?: string } | undefined {
    const row = this.db.prepare(
      "SELECT body FROM events WHERE type = 'session.status' AND json_extract(body, '$.session.role') = ? ORDER BY seq DESC LIMIT 1",
    ).get(role) as { body: string } | undefined;
    if (!row) return undefined;
    const e = HarnessEvent.parse(JSON.parse(row.body));
    return e.type === "session.status" ? e.session : undefined;
  }

  /** The most recently started run, if any. */
  latestRunId(): string | undefined {
    const row = this.db.prepare("SELECT run_id FROM events WHERE type = 'run.status' ORDER BY seq DESC LIMIT 1").get() as { run_id: string } | undefined;
    return row?.run_id;
  }

  append(e: HarnessEvent): void {
    if (!this.insert) throw new Error("event store is read-only");
    this.insert.run(e.id, e.ts, e.runId, e.type, JSON.stringify(e));
  }

  replay(runId: string): HarnessEvent[] {
    return (this.byRun.all(runId) as { body: string }[]).map((r) => HarnessEvent.parse(JSON.parse(r.body)));
  }
}
