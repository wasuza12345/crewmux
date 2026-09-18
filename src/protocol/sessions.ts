import { z } from "zod";

export const SessionStatus = z.enum(["starting", "running", "exited"]);
export type SessionStatus = z.infer<typeof SessionStatus>;

/** One native agent CLI running in one tmux window, bound to one role. */
export const AgentSessionInfo = z.object({
  id: z.string(),
  runId: z.string(),
  role: z.string(), // unique among running sessions — the address other agents use
  agentId: z.string(), // .crewmux/agents/<id>.yaml
  kind: z.string(), // claude | codex | custom
  cwd: z.string(),
  window: z.string(), // tmux window id, e.g. "@7"
  pane: z.string(), // the agent CLI's pane id, e.g. "%12" — messages are pasted here
  providerSessionId: z.string().optional(), // vendor-native id for resume (e.g. claude --session-id)
  status: SessionStatus,
});
export type AgentSessionInfo = z.infer<typeof AgentSessionInfo>;
