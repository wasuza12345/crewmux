// Stand-in for a vendor CLI inside a tmux window. Reads lines typed/pasted into it:
//   /send <role> <text>   → calls the harness MCP send_message tool
//   /ask <text>           → calls ask_user
//   /quit                 → exits (pane closes)
//   anything else         → echoed as "got: <line>"
import { createInterface } from "node:readline";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const { HARNESS_MCP_URL, HARNESS_MCP_TOKEN, HARNESS_ROLE, HARNESS_SYSTEM_PROMPT = "" } = process.env;
const client = new Client({ name: `fake-${HARNESS_ROLE}`, version: "0" });
await client.connect(new StreamableHTTPClientTransport(new URL(HARNESS_MCP_URL), { requestInit: { headers: { Authorization: `Bearer ${HARNESS_MCP_TOKEN}` } } }));
console.log(`ready role=${HARNESS_ROLE} prompt-has-preamble=${HARNESS_SYSTEM_PROMPT.includes("crewmux")}`);

for await (const line of createInterface({ input: process.stdin })) {
  if (line === "/quit") process.exit(0);
  const a = /^\/ask (.+)$/.exec(line);
  if (a) { await client.callTool({ name: "ask_user", arguments: { question: a[1] } }); console.log("asked"); continue; }
  const m = /^\/send (\S+) (.+)$/.exec(line);
  if (!m) { console.log(`got: ${line}`); continue; }
  const r = await client.callTool({ name: "send_message", arguments: { to: m[1], content: m[2] } });
  console.log(`sent ${r.isError ? "ERROR " : ""}${r.content[0].text}`);
}
