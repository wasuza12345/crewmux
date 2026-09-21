import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { BoardName } from "../protocol/index.js";
import type { BoardAccess } from "./tools.js";

/**
 * Read-only board pages on the harness HTTP server (same 127.0.0.1 port as /mcp):
 *
 *   GET /board              → list page          GET /board.json        → list data
 *   GET /board/<name>       → board page         GET /board/<name>.json → board data
 *
 * Every route needs ?t=<view token>. The page passes its own ?t= on to the JSON fetch.
 * Returns false when the path is not a board route (the caller answers 404 / handles /mcp).
 */
export function handleBoardRequest(req: IncomingMessage, res: ServerResponse, boards: BoardAccess | undefined): boolean {
  const url = new URL(req.url ?? "/", "http://localhost");
  const m = /^\/board(?:\/([^/]+?))?(\.json)?$/.exec(url.pathname);
  if (!m) return false;
  const [, name, json] = m;

  // The token is in the URL: never let it leak through Referer, caches or a framing page.
  const common = { "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff", "x-frame-options": "DENY" };
  const send = (status: number, type: string, body: string, extra: Record<string, string> = {}): void => {
    res.writeHead(status, { ...common, "content-type": type, ...extra }).end(req.method === "HEAD" ? undefined : body);
  };
  const error = (status: number, message: string): void => send(status, "application/json", JSON.stringify({ error: message }));
  if (req.method !== "GET" && req.method !== "HEAD") {
    error(405, "boards are read-only: GET only");
    return true;
  }

  serve(url, name, Boolean(json), boards, send, error);
  return true;
}

function serve(
  url: URL, name: string | undefined, json: boolean, boards: BoardAccess | undefined,
  send: (status: number, type: string, body: string, extra?: Record<string, string>) => void,
  error: (status: number, message: string) => void,
): void {
  if (!boards) return error(404, "boards are not enabled");
  if (!tokenMatches(url.searchParams.get("t"), boards.viewToken)) {
    return error(401, "missing or wrong board token — open the board with `crewmux board` or Ctrl-b B");
  }
  if (name !== undefined && !BoardName.safeParse(name).success) return error(404, "no such board");
  if (!json) {
    return send(200, "text/html; charset=utf-8", boards.page(), {
      // Inline script/style only; data comes from this origin. No external loads at all.
      "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'",
    });
  }
  if (name === undefined) return send(200, "application/json", JSON.stringify({ boards: boards.list() }));
  const board = boards.get(name);
  if (!board) return error(404, `no board named "${name}"`);
  send(200, "application/json", JSON.stringify(board));
}

function tokenMatches(given: string | null, expected: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
