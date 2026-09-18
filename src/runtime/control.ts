import { chmodSync, existsSync, rmSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import { join } from "node:path";
import type { Harness } from "./harness.js";

/**
 * Lets `crewmux open|close|status` (and the tmux key bindings) talk to the running harness.
 * A unix socket in .crewmux/state with mode 0600: only this user on this machine can connect, no token needed.
 */

export const controlSocketPath = (agentDir: string) => join(agentDir, "state", "control.sock");

type Request = { action: "open"; role: string; fresh?: boolean } | { action: "close"; role: string } | { action: "status" };

export async function startControlServer(harness: Harness, agentDir: string): Promise<Server> {
  const path = controlSocketPath(agentDir);
  if (existsSync(path)) rmSync(path); // stale socket from a crashed run
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => { body += c.toString(); if (body.length > 10_000) req.destroy(); });
    req.on("end", () => {
      void (async () => {
        try {
          const r = JSON.parse(body) as Request;
          let result: unknown;
          if (r.action === "open") result = await harness.launch(r.role, { fresh: Boolean(r.fresh), reload: true });
          else if (r.action === "close") result = await harness.close(r.role);
          else if (r.action === "status") result = harness.status();
          else throw new Error("unknown action");
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, result: result ?? null }));
        } catch (err) {
          res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
        }
      })();
    });
  });
  await new Promise<void>((ok) => server.listen(path, ok));
  chmodSync(path, 0o600);
  return server;
}

export async function stopControlServer(server: Server, agentDir: string): Promise<void> {
  await new Promise<void>((ok) => server.close(() => ok()));
  const path = controlSocketPath(agentDir);
  if (existsSync(path)) rmSync(path);
}

/** Client side, used by the CLI. Throws with the harness's own error message. */
export function sendControl(agentDir: string, req: Request): Promise<unknown> {
  const socketPath = controlSocketPath(agentDir);
  if (!existsSync(socketPath)) return Promise.reject(new Error("harness is not running for this project — start it with `crewmux`"));
  return new Promise((resolve, reject) => {
    const r = request({ socketPath, path: "/", method: "POST", headers: { "content-type": "application/json" } }, (res) => {
      let data = "";
      res.on("data", (c: Buffer) => { data += c.toString(); });
      res.on("end", () => {
        const parsed = JSON.parse(data || "{}") as { ok: boolean; result?: unknown; error?: string };
        if (parsed.ok) resolve(parsed.result);
        else reject(new Error(parsed.error ?? `harness answered ${res.statusCode}`));
      });
    });
    r.on("error", (err) => reject(new Error(`cannot reach the harness (${err.message}) — is it running?`)));
    r.end(JSON.stringify(req));
  });
}
