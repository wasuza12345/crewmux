import { fileURLToPath } from "node:url";
import type { Board } from "../protocol/index.js";

/** The board page. Served live by the harness and, filled with data, written out by `board export`. */
export const BOARD_PAGE = fileURLToPath(new URL("../../templates/board.html", import.meta.url));

/** Where the template takes the embedded snapshot (inside <head>, before the page script runs). */
export const SNAPSHOT_MARKER = "<!--board-snapshot-->";

/**
 * JSON that is safe inside <script type="application/json">: "<" can't close the element or open a
 * comment, and U+2028/2029 can't break old JS parsers. JSON.parse turns the escapes back into text.
 */
export function scriptSafeJson(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

/**
 * One self-contained HTML file: the page with the board embedded. No polling, no view token,
 * nothing loaded from anywhere (the meta CSP forbids it; file:// has no server to send headers). Pure.
 */
export function snapshotHtml(template: string, board: Board, exportedAt: number): string {
  if (!template.includes(SNAPSHOT_MARKER)) throw new Error(`board template has no ${SNAPSHOT_MARKER} marker`);
  const csp = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'";
  const embedded = [
    `<meta http-equiv="Content-Security-Policy" content="${csp}">`,
    `<script type="application/json" id="board-snapshot">${scriptSafeJson({ board, exportedAt })}</script>`,
  ].join("\n");
  return template.replace(SNAPSHOT_MARKER, () => embedded); // a function: "$&" in board text must stay literal
}

/** <name>-<yyyymmdd-hhmm>.html in local time. */
export function exportFileName(name: string, at: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${name}-${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}-${p(at.getHours())}${p(at.getMinutes())}.html`;
}
