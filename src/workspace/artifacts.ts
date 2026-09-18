import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { newId, type ArtifactKind, type ArtifactRef } from "../protocol/index.js";

const EXT: Record<ArtifactKind, string> = { diff: "patch", file: "txt", test_report: "json", summary: "md", analysis: "md" };

/** Writes to .crewmux/state/artifacts/<runId>/<role>/<kind>-<id>.<ext> and returns the ref. */
export function writeArtifact(agentDir: string, runId: string, sessionId: string, role: string, kind: ArtifactKind, content: string, meta: Record<string, unknown> = {}): ArtifactRef {
  const id = newId("art");
  const rel = join(runId, role, `${kind}-${id}.${EXT[kind]}`);
  const abs = join(agentDir, "state", "artifacts", rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  return { id, kind, sessionId, role, path: rel, meta };
}
