import { z } from "zod";

export const ArtifactKind = z.enum(["diff", "file", "test_report", "summary", "analysis"]);
export type ArtifactKind = z.infer<typeof ArtifactKind>;

/** Files agents hand each other are copied to .crewmux/state/artifacts and referenced by id. */
export const ArtifactRef = z.object({
  id: z.string(),
  kind: ArtifactKind,
  sessionId: z.string(),
  role: z.string(),
  path: z.string(), // relative to .crewmux/state/artifacts
  meta: z.record(z.string(), z.unknown()).default({}),
});
export type ArtifactRef = z.infer<typeof ArtifactRef>;
