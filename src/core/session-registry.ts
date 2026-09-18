import type { AgentSessionInfo, SessionStatus } from "../protocol/index.js";
import type { EventBus } from "./event-bus.js";

/** Owns which agent sessions exist and their status. The only place session status changes. */
export class SessionRegistry {
  private readonly sessions = new Map<string, AgentSessionInfo>();

  constructor(private readonly bus: EventBus) {}

  add(session: AgentSessionInfo): void {
    if (session.status !== "exited" && this.byRole(session.role)) throw new Error(`role "${session.role}" already has a live session`);
    this.sessions.set(session.id, { ...session });
    this.publish(session.id);
  }

  setStatus(id: string, status: SessionStatus): void {
    const s = this.sessions.get(id);
    if (!s) throw new Error(`unknown session ${id}`);
    if (s.status === status) return;
    s.status = status;
    this.publish(id);
  }

  /** Record the vendor's own conversation id once known (Codex: found after the fact). */
  setProviderSession(id: string, providerSessionId: string): void {
    const s = this.sessions.get(id);
    if (!s) throw new Error(`unknown session ${id}`);
    if (s.providerSessionId === providerSessionId) return;
    s.providerSessionId = providerSessionId;
    this.publish(id);
  }

  get(id: string): AgentSessionInfo | undefined {
    return this.sessions.get(id);
  }

  /** The live (non-exited) session for a role — roles are the addresses agents use. */
  byRole(role: string): AgentSessionInfo | undefined {
    return [...this.sessions.values()].find((s) => s.role === role && s.status !== "exited");
  }

  list(): AgentSessionInfo[] {
    return [...this.sessions.values()];
  }

  private publish(id: string): void {
    const session = { ...this.sessions.get(id)! };
    this.bus.publish({ type: "session.status", runId: session.runId, session });
  }
}
