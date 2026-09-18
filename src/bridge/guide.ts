import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The crewmux manuals, served to agents through the `guide` MCP tool so they can walk the
 * user through setup instead of the user reading docs. Read from the installed repo (one source).
 */
export const GUIDE_FILES = {
  agent: fileURLToPath(new URL("../../docs/agent-guide.md", import.meta.url)), // English, for AI
  user: fileURLToPath(new URL("../../docs/usage.md", import.meta.url)), // Thai, the human manual
} as const;

export interface Section {
  doc: keyof typeof GUIDE_FILES;
  title: string;
  body: string; // heading line included
}

/** Split markdown into sections at ## / ### headings (fenced code blocks are not headings). Pure. */
export function parseSections(doc: Section["doc"], markdown: string): Section[] {
  const out: Section[] = [];
  let current: Section | undefined;
  let inFence = false;
  for (const line of markdown.split("\n")) {
    if (line.startsWith("```")) inFence = !inFence;
    const h = !inFence && /^(#{2,3})\s+(.*)$/.exec(line);
    if (h) {
      if (current) out.push(current);
      current = { doc, title: h[2]!.trim(), body: line };
    } else if (current) {
      current.body += `\n${line}`;
    }
  }
  if (current) out.push(current);
  return out.map((s) => ({ ...s, body: s.body.trimEnd() }));
}

const words = (s: string) => s.toLowerCase().split(/[^\p{L}\p{N}_.-]+/u).filter((w) => w.length > 1);

/** Best sections for a free-text topic: title hits weigh more than body hits. Pure. */
export function searchSections(sections: Section[], topic: string, limit = 3): Section[] {
  const terms = words(topic);
  if (!terms.length) return [];
  return sections
    .map((s) => {
      const title = s.title.toLowerCase();
      const body = s.body.toLowerCase();
      const score = terms.reduce((n, t) => n + (title.includes(t) ? 5 : 0) + Math.min(body.split(t).length - 1, 5), 0);
      return { s, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.s);
}

export function loadSections(): Section[] {
  return (Object.keys(GUIDE_FILES) as Section["doc"][]).flatMap((doc) =>
    existsSync(GUIDE_FILES[doc]) ? parseSections(doc, readFileSync(GUIDE_FILES[doc], "utf8")) : [],
  );
}
