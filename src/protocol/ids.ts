import { randomUUID } from "node:crypto";

/** Full 122-bit UUID — never truncate (collision risk grows with traffic). */
export const newId = (prefix: "r" | "s" | "e" | "art" | "msg"): string =>
  `${prefix}_${randomUUID().replaceAll("-", "")}`;

/** Name of the harness MCP server as seen by every agent CLI (tools appear as mcp__harness__*). */
export const HARNESS_MCP_NAME = "harness";
