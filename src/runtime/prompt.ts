import { GUIDE_FILES } from "../bridge/guide.js";
import { sessionMarker } from "./resume.js";
import { HARNESS_MCP_NAME, type AgentEnvelope, type ArtifactRef } from "../protocol/index.js";

export const DELIVERY_PREFIX = "[harness]";

/** The AI-facing configuration guide (also served by the `guide` MCP tool). */
export const AGENT_GUIDE = GUIDE_FILES.agent;

/** Prepended to every role prompt: tells the agent how it is wired, not how to do its job. */
export function harnessPreamble(project: string, role: string, agentId: string, sessionId: string): string {
  return [
    `You are running inside crewmux as role "${role}" (agent "${agentId}") in project "${project}". (${sessionMarker(sessionId)})`,
    "Other agents run at the same time, each in its own terminal, and a human may be watching yours.",
    `You reach other agents ONLY through the \`${HARNESS_MCP_NAME}\` MCP tools:`,
    "- list_agents: which roles are running",
    "- send_message(to=<role>): your message is typed into that agent's session",
    "- submit_review(to=<role>, verdict): review verdict for another role's work",
    "- report_artifact(path): share a file; attach its id to a message",
    "- ask_user: question for the human",
    "- compact(target?, focus?): compact a conversation (yours by default) to save tokens; it runs after the target's current turn",
    "- guide(topic): the crewmux manual — call it for ANY question about using/configuring crewmux, then walk the user through the steps",
    `Input starting with "${DELIVERY_PREFIX}" is a message from another agent, not from the human.`,
    "Answer it with send_message(to=<sender>, replyTo=<message id>) — plain text replies are only seen by the human.",
    "Compact at task boundaries only: after a task is finished and reported, before unrelated new work, or after reading long logs/diffs you no longer need (list_agents shows each agent's context size; above ~70% is a good time).",
    "Never compact mid-task or while waiting for an answer that needs the details. Before compacting, make sure what matters survives: put decisions, file paths, open TODOs and pending message ids in `focus` (or share them with report_artifact).",
    `These tools belong to the MCP server named \`${HARNESS_MCP_NAME}\` (shown as mcp__${HARNESS_MCP_NAME}__send_message, ${HARNESS_MCP_NAME}.send_message, …; if your CLI defers MCP tools, search for "${HARNESS_MCP_NAME}"). Built-in tools with similar names (e.g. a collaboration/subagent send_message) do NOT reach this team — never use them for it.`,
    "The team is configured in .crewmux/ of this project (roles.yaml, agents/, prompts/).",
    `Before changing it (roles, CLIs, models, permissions), call guide(topic) (full text: ${AGENT_GUIDE}).`,
    "Shell commands: `crewmux status` · `crewmux open <role>` (re-reads roles.yaml) · `crewmux close <role>` · `crewmux restart <role>` (applies config changes; you may restart yourself or others — do not ask the human to run it) · `crewmux doctor` after every config edit.",
  ].join("\n");
}

/** How a message looks when pasted into the recipient's CLI. */
export function formatDelivery(e: AgentEnvelope, artifacts: ReadonlyMap<string, ArtifactRef>, artifactRoot: string): string {
  const head = [
    `${DELIVERY_PREFIX} message ${e.id} from "${e.from}"`,
    `type=${e.type}`,
    ...(e.verdict ? [`verdict=${e.verdict}`] : []),
    ...(e.replyTo ? [`reply-to=${e.replyTo}`] : []),
  ].join(" · ");
  const files = e.artifacts.map((id) => {
    const a = artifacts.get(id);
    return a ? `- ${id} (${a.kind}): ${artifactRoot}/${a.path}` : `- ${id} (unknown artifact)`;
  });
  return [head, e.content, ...(files.length ? ["attachments:", ...files] : []), `(reply with send_message to="${e.from}" replyTo="${e.id}")`].join("\n");
}
