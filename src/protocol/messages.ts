import { z } from "zod";

/**
 * Agent-to-agent traffic is typed and always routed through the harness,
 * which pastes it into the recipient's native CLI. Agents never talk directly.
 */
export const MessageType = z.enum(["request", "question", "answer", "info", "review_request", "review_result"]);
export type MessageType = z.infer<typeof MessageType>;

export const ReviewVerdict = z.enum(["approve", "request_changes", "reject"]);
export type ReviewVerdict = z.infer<typeof ReviewVerdict>;

export const USER = "user";

export const AgentEnvelope = z.object({
  id: z.string(),
  from: z.string(), // sender role (taken from its session token, never from input)
  to: z.string(), // recipient role, or "user"
  type: MessageType,
  content: z.string(),
  artifacts: z.array(z.string()).default([]),
  replyTo: z.string().optional(),
  verdict: ReviewVerdict.optional(), // only for review_result
});
export type AgentEnvelope = z.infer<typeof AgentEnvelope>;
