import { z } from "zod";
import { ArtifactRef } from "./artifacts.js";
import { AgentEnvelope } from "./messages.js";
import { AgentSessionInfo } from "./sessions.js";

const base = { id: z.string(), ts: z.number(), runId: z.string() };

/** Everything the harness does is one of these, appended to SQLite and printed in the harness window. */
export const HarnessEvent = z.discriminatedUnion("type", [
  z.object({ ...base, type: z.literal("run.status"), status: z.enum(["started", "stopped"]), project: z.string() }),
  z.object({ ...base, type: z.literal("session.status"), session: AgentSessionInfo }),
  z.object({ ...base, type: z.literal("message"), envelope: AgentEnvelope }),
  z.object({ ...base, type: z.literal("message.delivery"), messageId: z.string(), to: z.string(), ok: z.boolean(), detail: z.string().optional() }),
  z.object({ ...base, type: z.literal("artifact.created"), artifact: ArtifactRef }),
  /** Context size of a running agent, read from its CLI's own session files. */
  z.object({ ...base, type: z.literal("session.usage"), role: z.string(), tokens: z.number(), window: z.number().optional() }),
  /** A compaction was typed into an agent's CLI. `by` = requesting role, or "user". */
  z.object({ ...base, type: z.literal("session.compact"), role: z.string(), by: z.string(), focus: z.string().optional() }),
]);
export type HarnessEvent = z.infer<typeof HarnessEvent>;
export type HarnessEventType = HarnessEvent["type"];

/** Distributive Omit so each union member keeps its own fields. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type NewHarnessEvent = DistributiveOmit<HarnessEvent, "id" | "ts">;
