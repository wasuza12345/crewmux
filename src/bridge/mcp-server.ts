import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createToolHandlers, TOOL_DESCRIPTIONS, TOOL_INPUTS, ToolError, type BridgeDeps, type CallerIdentity } from "./tools.js";

export const MCP_SERVER_NAME = "harness";
const MAX_BODY_BYTES = 1_000_000;

/**
 * The only channel agents use to talk to the harness (and, through it, to each other).
 *
 *   agent CLI (MCP client) ──HTTP POST /mcp + Bearer <session token>──► HarnessMcpServer
 *                                                                        └─ tools.ts → EventBus/SessionRegistry
 *
 * Streamable HTTP, stateless, bound to 127.0.0.1 only. One token per agent session.
 */
export class HarnessMcpServer {
  private readonly callers = new Map<string, CallerIdentity>();
  private http?: Server;
  private baseUrl?: string;

  /** `onCall` sees every authenticated JSON-RPC method (for the harness log); never the token. */
  constructor(private readonly deps: BridgeDeps, private readonly onCall?: (caller: CallerIdentity, method: string, detail: string) => void) {}

  async start(port = 0): Promise<string> {
    this.http = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((ok) => this.http!.listen(port, "127.0.0.1", ok));
    this.baseUrl = `http://127.0.0.1:${(this.http.address() as AddressInfo).port}/mcp`;
    return this.baseUrl;
  }

  async stop(): Promise<void> {
    this.callers.clear();
    // Agents keep MCP connections alive; without dropping them, close() waits forever.
    this.http?.closeAllConnections();
    await new Promise<void>((ok) => (this.http ? this.http.close(() => ok()) : ok()));
  }

  get url(): string {
    if (!this.baseUrl) throw new Error("mcp server not started");
    return this.baseUrl;
  }

  /** Call when an agent session starts; revoke when it ends. */
  issueToken(caller: CallerIdentity): string {
    const token = randomBytes(32).toString("base64url");
    this.callers.set(token, caller);
    return token;
  }

  revokeToken(token: string): void {
    this.callers.delete(token);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const reply = (status: number, message: string) => {
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ error: message }));
    };
    try {
      if (new URL(req.url ?? "/", "http://localhost").pathname !== "/mcp") return reply(404, "not found");
      if (req.method !== "POST") return reply(405, "stateless server: POST only");

      const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
      const caller = token ? this.callers.get(token) : undefined;
      if (!caller) return reply(401, "invalid or missing session token");

      const body = await readJson(req);
      if (this.onCall) for (const msg of Array.isArray(body) ? body : [body]) this.onCall(caller, rpcMethod(msg), rpcDetail(msg));
      const server = this.buildServer(caller);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      if (!res.headersSent) reply(400, err instanceof Error ? err.message : String(err));
    }
  }

  /** A fresh McpServer per request, with tools bound to this caller's identity. */
  private buildServer(caller: CallerIdentity): McpServer {
    const server = new McpServer({ name: MCP_SERVER_NAME, version: "0.0.1" });
    const handlers = createToolHandlers(this.deps, caller);

    for (const name of Object.keys(TOOL_INPUTS) as (keyof typeof TOOL_INPUTS)[]) {
      server.registerTool(name, { description: TOOL_DESCRIPTIONS[name], inputSchema: TOOL_INPUTS[name] }, async (input: unknown) => {
        try {
          const result = await (handlers[name] as (i: unknown) => object | Promise<object>)(input);
          return { content: [{ type: "text" as const, text: JSON.stringify(result) }], structuredContent: result as Record<string, unknown> };
        } catch (err) {
          const message = err instanceof ToolError ? err.message : `internal error: ${err instanceof Error ? err.message : String(err)}`;
          return { content: [{ type: "text" as const, text: message }], isError: true };
        }
      });
    }
    return server;
  }
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("request body too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const rpcMethod = (msg: unknown): string =>
  typeof msg === "object" && msg !== null && "method" in msg && typeof msg.method === "string" ? msg.method : "?";
const rpcDetail = (msg: unknown): string => {
  const params = typeof msg === "object" && msg !== null && "params" in msg ? (msg.params as { name?: unknown }) : undefined;
  return typeof params?.name === "string" ? params.name : "";
};
