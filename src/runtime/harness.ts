import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { buildRolePrompt, loadConfig, roleColor, type LoadedConfig } from "../config/load.js";
import { EventBus } from "../core/event-bus.js";
import { PathPolicy } from "../core/policy-engine.js";
import { SessionRegistry } from "../core/session-registry.js";
import { HarnessMcpServer } from "../bridge/mcp-server.js";
import { launcherFor } from "../agents/launchers/index.js";
import { EventStore } from "../persistence/events.js";
import { openDb, type Db } from "../persistence/sqlite.js";
import { createWorktree } from "../workspace/worktree.js";
import * as tmux from "../terminal/tmux.js";
import { PANEL_COLUMNS } from "../terminal/chrome.js";
import { newId, USER, type AgentEnvelope, type AgentSessionInfo, type ArtifactRef, type HarnessEvent } from "../protocol/index.js";
import { formatDelivery, harnessPreamble } from "./prompt.js";
import { findCodexSession, resolveResume } from "./resume.js";
import { prepareVendor } from "./vendor-setup.js";
import { contextUsage, type ContextUsage } from "./usage.js";
import { compactCommand } from "../agents/presets.js";
import { ToolError } from "../bridge/tools.js";

export interface HarnessOptions {
  tmuxSession: string; // must already exist — `crewmux up` creates it with the harness in window 0
  log?: (line: string) => void;
  watchIntervalMs?: number;
  usageIntervalMs?: number; // how often context usage is re-read from the CLIs' session files (default 20 s)
  debug?: boolean; // log every MCP call (method + tool name) in the harness window
  /** Command for the sidebar pane in each agent window (`agent panel`); omitted = no sidebar. */
  panelArgv?: string[];
  dbFile?: string; // default .crewmux/state/harness.db
}

/**
 * Composition root for one run: MCP bridge + session registry + tmux delivery.
 * Launches each role's native CLI in its own tmux window and routes messages between them.
 */
export class Harness {
  readonly runId = newId("r");
  readonly bus = new EventBus();
  readonly sessions = new SessionRegistry(this.bus);
  private readonly mcp: HarnessMcpServer;
  private readonly tokens = new Map<string, string>(); // sessionId → token
  private readonly artifacts = new Map<string, ArtifactRef>();
  private readonly deliveryQueues = new Map<string, Promise<void>>(); // paneId → tail, keeps pastes from interleaving
  private db?: Db;
  private store?: EventStore;
  private watcher?: NodeJS.Timeout;
  private usageTimer?: NodeJS.Timeout;
  private readonly usage = new Map<string, ContextUsage>(); // role → latest known context size
  private readonly lastCompact = new Map<string, number>(); // role → ms of the last compaction

  constructor(private config: LoadedConfig, private readonly opts: HarnessOptions) {
    const onCall = opts.debug ? (c: { role: string }, method: string, detail: string) => opts.log?.(`  mcp ${c.role} ${method} ${detail}`.trimEnd()) : undefined;
    this.mcp = new HarnessMcpServer({
      bus: this.bus,
      sessions: this.sessions,
      policy: new PathPolicy(config.policy),
      agentDir: config.dir,
      usage: (role) => this.usageOf(role),
      compact: (by, target, focus) => this.compact(target, { by, focus }),
    }, onCall);
  }

  async start(): Promise<void> {
    this.db = openDb(this.opts.dbFile ?? join(this.config.dir, "state", "harness.db"));
    const store = (this.store = new EventStore(this.db));
    this.bus.addSink((e) => store.append(e));
    this.bus.subscribe((e) => this.onEvent(e));
    await this.mcp.start();
    this.bus.publish({ type: "run.status", runId: this.runId, status: "started", project: this.config.project.project });
    this.watcher = setInterval(() => void this.reapExited(), this.opts.watchIntervalMs ?? 2000);
    this.usageTimer = setInterval(() => this.pollUsage(), this.opts.usageIntervalMs ?? 20_000);
  }

  /**
   * Open a role's native CLI in a new tmux window. By default it continues the role's last
   * conversation (same vendor, same working directory) if the vendor still has it; `fresh` skips that.
   */
  async launch(role: string, { fresh = false, reload = false }: { fresh?: boolean; reload?: boolean } = {}): Promise<AgentSessionInfo> {
    // Opening a role at runtime re-reads roles/agents so a role just added to roles.yaml works without a restart.
    if (reload) {
      const latest = loadConfig(this.config.root);
      this.config = { ...this.config, roles: latest.roles, agents: latest.agents };
    }
    const binding = this.config.roles[role];
    if (!binding) throw new Error(`unknown role "${role}"`);
    if (this.sessions.byRole(role)) throw new Error(`role "${role}" is already running`);
    const def = this.config.agents.get(binding.agent)!; // existence checked by loadConfig
    const launcher = launcherFor(def.kind);

    const sessionId = newId("s");
    const cwd = this.config.project.isolation === "worktree"
      ? (await createWorktree(this.config.root, this.config.dir, this.runId, role, this.config.project.baseBranch)).path
      : this.config.root;
    const token = this.mcp.issueToken({ runId: this.runId, sessionId, role, agentId: def.id, cwd });
    const prev = fresh ? undefined : this.store?.lastSession(role);
    const resumeId = resolveResume(prev && { harnessSessionId: prev.id, kind: prev.kind, cwd: prev.cwd, ...(prev.providerSessionId ? { providerSessionId: prev.providerSessionId } : {}) }, def, cwd);
    const providerSessionId = resumeId ?? (launcher.presetSessionId(def) ? randomUUID() : undefined);
    const systemPrompt = [harnessPreamble(this.config.project.project, role, def.id, sessionId), buildRolePrompt(this.config, role)].filter(Boolean).join("\n\n");

    const spec = launcher.build(def, {
      sessionId, role, systemPrompt, token, mcpUrl: this.mcp.url,
      ...(binding.model ? { model: binding.model } : {}),
      ...(binding.compactAt ? { compactAt: binding.compactAt } : {}),
      ...(providerSessionId ? { providerSessionId } : {}),
      ...(resumeId ? { resumeId } : {}),
    });
    if (resumeId) this.opts.log?.(`  ${role}: resuming ${def.kind} conversation ${resumeId}`);
    const prepared = prepareVendor(def, cwd);
    if (prepared) this.opts.log?.(`  ${role}: ${prepared}`);
    let window: string;
    let pane: string;
    try {
      ({ window, pane } = await tmux.newWindow(this.opts.tmuxSession, role, cwd, [spec.command, ...spec.args], spec.env));
      await this.decorate(window, pane, role, def.kind, binding.model ?? def.model);
    } catch (err) {
      this.mcp.revokeToken(token);
      throw err;
    }
    this.tokens.set(sessionId, token);
    const session: AgentSessionInfo = {
      id: sessionId, runId: this.runId, role, agentId: def.id, kind: def.kind, cwd, window, pane, status: "running",
      ...(providerSessionId ? { providerSessionId } : {}),
    };
    this.sessions.add(session);
    return session;
  }

  /** Tab state + pane labels + the sidebar panel on the left of the agent. */
  private async decorate(window: string, pane: string, role: string, vendor: string, model: string | undefined): Promise<void> {
    await tmux.setOption("window", window, "@dot", "●");
    await tmux.setOption("window", window, "@color", roleColor(this.config, role));
    await tmux.setOption("window", window, "@vendor", vendor);
    await tmux.setOption("window", window, "@unread", "0");
    await tmux.setOption("pane", pane, "@label", [role, vendor, model].filter(Boolean).join(" · "));
    if (!this.opts.panelArgv) return;
    const panel = await tmux.splitLeft(pane, this.config.root, this.opts.panelArgv,
      { CREWMUX_HOME: this.config.dir, CREWMUX_RUN_ID: this.runId, CREWMUX_VIEWER: role }, PANEL_COLUMNS);
    await tmux.setOption("pane", panel, "@label", "harness");
    // tmux resizes panes proportionally; pin the sidebar so the agent gets all extra width.
    await tmux.setWindowHook(window, "window-resized", `resize-pane -t ${panel} -x ${PANEL_COLUMNS}`);
  }

  /** Close one role at runtime: its CLI and window go away, its token is revoked, its conversation stays resumable. */
  async close(role: string): Promise<void> {
    const s = this.sessions.byRole(role);
    if (!s) throw new Error(`role "${role}" is not running`);
    await tmux.killWindow(s.window);
    this.markExited(s.id);
  }

  /**
   * Close + reopen in one step, done by the harness itself — so an agent can restart itself (its own
   * shell dies with its window, which would cut a client-side "close && open" in half). Picks up
   * changed config and continues the same conversation unless `fresh`.
   */
  async restart(role: string, { fresh = false }: { fresh?: boolean } = {}): Promise<AgentSessionInfo> {
    if (this.sessions.byRole(role)) await this.close(role);
    return this.launch(role, { fresh, reload: true });
  }

  /** Every role in roles.yaml (as it is on disk now) with its current status, for `crewmux status`. */
  status(): { role: string; agent: string; status: string; window?: string }[] {
    let roles = this.config.roles;
    try {
      roles = loadConfig(this.config.root).roles;
    } catch {
      // a half-edited roles.yaml must not break status; show what the harness last loaded
    }
    return Object.entries(roles).map(([role, b]) => {
      const s = this.sessions.byRole(role);
      return { role, agent: b.agent, status: s ? s.status : "stopped", ...(s ? { window: s.window } : {}) };
    });
  }

  async stop(): Promise<void> {
    if (this.watcher) clearInterval(this.watcher);
    if (this.usageTimer) clearInterval(this.usageTimer);
    for (const s of this.sessions.list()) {
      if (s.status === "exited") continue;
      await tmux.killWindow(s.window);
      this.markExited(s.id);
    }
    await Promise.all(this.deliveryQueues.values());
    this.bus.publish({ type: "run.status", runId: this.runId, status: "stopped", project: this.config.project.project });
    await this.mcp.stop();
    this.db?.close();
  }

  private onEvent(e: HarnessEvent): void {
    if (e.type === "artifact.created") this.artifacts.set(e.artifact.id, e.artifact);
    if (e.type === "message") this.deliver(e.envelope);
    if (e.type === "message.delivery" && e.ok) this.bumpUnread(e.to).catch((err: unknown) => this.warn("badge", err));
    if (e.type === "message" && e.envelope.to === USER && e.envelope.type === "question") this.flagQuestion(e.envelope.from).catch((err: unknown) => this.warn("question flag", err));
    this.opts.log?.(describe(e));
  }

  private deliver(envelope: AgentEnvelope): void {
    if (envelope.to === USER) return; // shown in the harness window by the log line
    const target = this.sessions.byRole(envelope.to);
    const report = (ok: boolean, detail?: string): void => {
      this.bus.publish({ type: "message.delivery", runId: this.runId, messageId: envelope.id, to: envelope.to, ok, ...(detail ? { detail } : {}) });
    };
    if (!target) return report(false, "recipient not running");

    const text = formatDelivery(envelope, this.artifacts, join(this.config.dir, "state", "artifacts"));
    this.typeInto(target.pane, text).then(() => report(true), (err: unknown) => report(false, err instanceof Error ? err.message : String(err)));
  }

  /** Paste text into a pane and submit, one at a time per pane so pastes never interleave. */
  private typeInto(pane: string, text: string): Promise<void> {
    const prev = this.deliveryQueues.get(pane) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(() => tmux.pasteAndSubmit(pane, text, this.config.project.delivery.pasteDelayMs));
    this.deliveryQueues.set(pane, next.catch(() => undefined));
    return next;
  }

  /**
   * Type the CLI's own compact command into a role's session (it runs after the current turn).
   * `by` is the requesting role or "user"; AI requests obey config.compact (ai on/off, min interval).
   */
  async compact(role: string, { by = USER, focus = "" }: { by?: string; focus?: string } = {}): Promise<void> {
    const s = this.sessions.byRole(role);
    if (!s) throw new ToolError(`no running agent with role "${role}"`);
    const def = this.config.agents.get(s.agentId)!;
    const text = compactCommand(def, focus);
    if (!text) throw new ToolError(`${role} (${def.kind}) has no compact command — add cli.compact to agents/${def.id}.yaml`);
    const now = Date.now();
    if (by !== USER) {
      const { ai, minIntervalMinutes } = this.config.project.compact;
      if (!ai) throw new ToolError("the human turned off AI compaction (config.yaml → compact.ai: false)");
      const last = this.lastCompact.get(role);
      if (last !== undefined && now - last < minIntervalMinutes * 60_000) {
        const wait = Math.ceil((minIntervalMinutes * 60_000 - (now - last)) / 60_000);
        throw new ToolError(`${role} was compacted recently — try again in ${wait} min`);
      }
    }
    this.lastCompact.set(role, now);
    this.bus.publish({ type: "session.compact", runId: this.runId, role, by, ...(focus ? { focus } : {}) });
    await this.typeInto(s.pane, text);
  }

  /** Re-read context sizes; publish only real changes (≥ 1% of the window, or ≥ 5k tokens when the window is unknown). */
  private pollUsage(): void {
    for (const s of this.sessions.list()) {
      if (s.status === "exited") continue;
      const def = this.config.agents.get(s.agentId);
      if (!def) continue;
      if (def.kind === "codex" && !s.providerSessionId) {
        const found = findCodexSession(s.id, s.cwd);
        if (found) this.sessions.setProviderSession(s.id, found);
      }
      const u = contextUsage(def, this.sessions.get(s.id)!);
      if (!u) continue;
      const prev = this.usage.get(s.role);
      const step = u.window ? u.window / 100 : 5000;
      if (prev && Math.abs(prev.tokens - u.tokens) < step && prev.window === u.window) continue;
      this.usage.set(s.role, u);
      this.bus.publish({ type: "session.usage", runId: this.runId, role: s.role, tokens: u.tokens, ...(u.window ? { window: u.window } : {}) });
    }
  }

  /** Latest known context size of a role (for list_agents). */
  usageOf(role: string): ContextUsage | undefined {
    return this.usage.get(role);
  }

  /** Cosmetic tmux updates must never break delivery — report and move on. */
  private warn(what: string, err: unknown): void {
    this.opts.log?.(`  ! ${what}: ${err instanceof Error ? err.message : String(err)}`);
  }

  /** Tab badge ✉N — cleared by the after-select-window hook when the user looks at it. */
  private async bumpUnread(role: string): Promise<void> {
    const s = this.sessions.byRole(role);
    if (!s || (await tmux.isWindowActive(s.window))) return;
    const n = Number(await tmux.getOption("window", s.window, "@unread")) || 0;
    await tmux.setOption("window", s.window, "@unread", String(n + 1));
  }

  /** Status-right "? N question(s)" + where `C-b a` jumps. */
  private async flagQuestion(fromRole: string): Promise<void> {
    const target = this.opts.tmuxSession; // set-option rejects "=name"
    const n = Number(await tmux.getOption("session", target, "@asks")) || 0;
    await tmux.setOption("session", target, "@asks", String(n + 1));
    await tmux.setOption("session", target, "@ask_role", fromRole);
  }

  /**
   * The agent CLI's pane is gone → it exited: mark it, revoke its token, close its window
   * (otherwise the sidebar pane alone would keep the window open).
   */
  private async reapExited(): Promise<void> {
    const alive = await tmux.listPanes(this.opts.tmuxSession);
    for (const s of this.sessions.list()) {
      if (s.status === "exited" || alive.has(s.pane)) continue;
      this.markExited(s.id);
      await tmux.killWindow(s.window);
    }
  }

  private markExited(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    // Codex picks its own conversation id — look it up now so the next launch can resume it.
    if (s?.kind === "codex" && !s.providerSessionId) {
      const found = findCodexSession(s.id, s.cwd);
      if (found) this.sessions.setProviderSession(s.id, found);
    }
    const token = this.tokens.get(sessionId);
    if (token) this.mcp.revokeToken(token);
    this.tokens.delete(sessionId);
    this.sessions.setStatus(sessionId, "exited");
  }
}

/** One human-readable line per event for the harness window. */
export function describe(e: HarnessEvent): string {
  const t = new Date(e.ts).toTimeString().slice(0, 8);
  switch (e.type) {
    case "run.status": return `${t}  run ${e.status} · ${e.project} · ${e.runId}`;
    case "session.status": return `${t}  ${e.session.role} (${e.session.kind}) ${e.session.status}`;
    case "message": {
      const m = e.envelope;
      const body = m.content.length > 100 ? `${m.content.slice(0, 100)}…` : m.content;
      return `${t}  ${m.from} → ${m.to} [${m.type}${m.verdict ? `:${m.verdict}` : ""}] ${body.replaceAll("\n", " ")}`;
    }
    case "message.delivery": return `${t}    ${e.ok ? "✓ delivered" : "✗ not delivered"} to ${e.to}${e.detail ? ` (${e.detail})` : ""}`;
    case "artifact.created": return `${t}  ${e.artifact.role} shared ${e.artifact.kind} ${e.artifact.id}`;
    case "session.usage": return `${t}  ${e.role} context ${Math.round(e.tokens / 1000)}k${e.window ? ` (${Math.round((e.tokens / e.window) * 100)}%)` : ""}`;
    case "session.compact": return `${t}  ${e.role} compact ← ${e.by}${e.focus ? ` · keep: ${e.focus.slice(0, 60)}` : ""}`;
  }
}
