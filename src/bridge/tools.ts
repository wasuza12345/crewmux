import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { z } from "zod";
import { ArtifactKind, MessageType, newId, ReviewVerdict, USER, type AgentEnvelope } from "../protocol/index.js";
import type { EventBus } from "../core/event-bus.js";
import type { PathPolicy } from "../core/policy-engine.js";
import type { SessionRegistry } from "../core/session-registry.js";
import { writeArtifact } from "../workspace/artifacts.js";
import { loadSections, searchSections } from "./guide.js";

/**
 * Who is calling. Derived ONLY from the bearer token the harness issued for this
 * agent session — never from tool arguments, so an agent cannot impersonate another.
 */
export interface CallerIdentity {
  runId: string;
  sessionId: string;
  role: string;
  agentId: string;
  cwd: string;
}

export interface BridgeDeps {
  bus: EventBus;
  sessions: SessionRegistry;
  policy: PathPolicy;
  agentDir: string;
}

export class ToolError extends Error {}

/** Input schemas (zod raw shapes) — shared by the MCP server and by tests. */
export const TOOL_INPUTS = {
  list_agents: {},
  send_message: {
    to: z.string().describe('Recipient role (see list_agents), or "user" for the human'),
    type: MessageType.exclude(["review_result"]).default("request"),
    content: z.string().min(1),
    artifacts: z.array(z.string()).default([]).describe("Artifact ids to attach (from report_artifact)"),
    replyTo: z.string().optional().describe("Message id you are answering"),
  },
  submit_review: {
    to: z.string().describe("Role whose work you reviewed"),
    verdict: ReviewVerdict,
    notes: z.string().min(1).describe("Findings, tagged [BLOCKER]/[MAJOR]/[MINOR] with file:line"),
    replyTo: z.string().optional(),
  },
  report_artifact: {
    kind: ArtifactKind,
    path: z.string().describe("Path relative to your working directory"),
    summary: z.string().default(""),
  },
  ask_user: {
    question: z.string().min(1),
  },
  guide: {
    topic: z.string().default("").describe('What the user wants, e.g. "add grok", "bypass permissions", "resume", "keys". Empty = list all topics.'),
  },
} as const;

export const TOOL_DESCRIPTIONS: Record<keyof typeof TOOL_INPUTS, string> = {
  list_agents: "Who you are and which other agent roles are running right now.",
  send_message: "Send a message to another agent role (or the user). It is typed into that agent's session. Never contact agents any other way.",
  submit_review: "Send your review verdict to the role whose work you reviewed.",
  report_artifact: "Register a file you produced (diff, test report, analysis, ...) so you can attach it to a message by id.",
  ask_user: "Ask the human a question. The answer arrives later as normal input; end your turn after asking.",
  guide:
    "The crewmux manual. Call it BEFORE answering any question about using or configuring crewmux " +
    "(roles, adding a CLI such as grok, models, bypass/permissions, resume, keys, troubleshooting) or editing .crewmux/. " +
    "Then walk the user through the returned steps (or do them if asked) — do not tell them to go read docs.",
};

type Inputs = { [K in keyof typeof TOOL_INPUTS]: z.infer<z.ZodObject<(typeof TOOL_INPUTS)[K]>> };

/** Transport-independent tool logic. The MCP server is a thin wrapper around this. */
export function createToolHandlers(deps: BridgeDeps, caller: CallerIdentity) {
  const route = (to: string, type: AgentEnvelope["type"], content: string, extra: Partial<AgentEnvelope> = {}) => {
    if (to === caller.role) throw new ToolError("cannot send a message to yourself");
    if (to !== USER && !deps.sessions.byRole(to)) {
      const live = deps.sessions.list().filter((s) => s.status !== "exited").map((s) => s.role);
      throw new ToolError(`no running agent with role "${to}" (running: ${live.join(", ") || "none"})`);
    }
    const envelope: AgentEnvelope = { id: newId("msg"), from: caller.role, to, type, content, artifacts: [], ...extra };
    deps.bus.publish({ type: "message", runId: caller.runId, envelope });
    return { messageId: envelope.id, status: "queued" as const };
  };

  return {
    list_agents(_: Inputs["list_agents"]) {
      return {
        you: { role: caller.role, agentId: caller.agentId },
        peers: deps.sessions
          .list()
          .filter((s) => s.status !== "exited" && s.id !== caller.sessionId)
          .map((s) => ({ role: s.role, agentId: s.agentId, kind: s.kind, status: s.status })),
      };
    },

    send_message(input: Inputs["send_message"]) {
      return route(input.to, input.type, input.content, { artifacts: input.artifacts, ...(input.replyTo ? { replyTo: input.replyTo } : {}) });
    },

    submit_review(input: Inputs["submit_review"]) {
      return route(input.to, "review_result", input.notes, { verdict: input.verdict, ...(input.replyTo ? { replyTo: input.replyTo } : {}) });
    },

    report_artifact(input: Inputs["report_artifact"]) {
      if (isAbsolute(input.path)) throw new ToolError("path must be relative to your working directory");
      const abs = resolve(caller.cwd, input.path);
      if (!existsSync(abs)) throw new ToolError(`file not found: ${input.path}`);
      // Resolve symlinks before the containment check so a link can't escape the working directory.
      const rel = relative(realpathSync(caller.cwd), realpathSync(abs));
      if (rel.startsWith("..") || isAbsolute(rel)) throw new ToolError("path escapes your working directory");
      const verdict = deps.policy.check(rel);
      if (!verdict.allowed) throw new ToolError(`denied by policy (${verdict.rule})`);

      const ref = writeArtifact(deps.agentDir, caller.runId, caller.sessionId, caller.role, input.kind, readFileSync(abs, "utf8"), {
        source: rel,
        summary: input.summary,
      });
      deps.bus.publish({ type: "artifact.created", runId: caller.runId, artifact: ref });
      return { artifactId: ref.id };
    },

    ask_user(input: Inputs["ask_user"]) {
      return route(USER, "question", input.question);
    },

    guide(input: Inputs["guide"]) {
      const sections = loadSections();
      if (!input.topic.trim()) {
        return { topics: sections.map((s) => `[${s.doc}] ${s.title}`), hint: "call guide again with a topic to get the full steps" };
      }
      const hits = searchSections(sections, input.topic);
      if (!hits.length) return { found: 0, topics: sections.map((s) => `[${s.doc}] ${s.title}`) };
      return { found: hits.length, sections: hits.map((s) => ({ doc: s.doc, title: s.title, text: s.body })) };
    },
  };
}
