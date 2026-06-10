/**
 * serve-http.ts — MCPServer's serve-http verb. Speaks MCP over Streamable HTTP
 * (the modern MCP transport) so non-stdio agents (curl, Claude.ai, web clients)
 * can read the spec tree.
 *
 *   node system/subassemblies/MCPServer/system/library/serve-http.ts [--port 7437]
 *
 * Read-only by design: the only exposed surface is the ua://spec/*, ua://verify,
 * and ua://lineage/* resources. No tools are registered.
 *
 * Runs stateless (sessionIdGenerator: undefined) so every POST is independent —
 * appropriate for read-only access and easy to probe with curl.
 *
 * Endpoints:
 *   POST /mcp   — JSON-RPC requests (initialize, tools/list, resources/read, …)
 *   GET  /mcp   — SSE stream of server-initiated messages (kept for spec
 *                 compliance; stateless server has none to send)
 *   GET  /health — liveness probe used by bootstrap.ts
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer } from "./server.ts";

const DEFAULT_PORT = 7437;

function parsePort(argv: string[]): number {
  const i = argv.indexOf("--port");
  if (i >= 0 && argv[i + 1]) {
    const n = Number(argv[i + 1]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const env = process.env.MCP_HTTP_PORT;
  if (env) {
    const n = Number(env);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return DEFAULT_PORT;
}

export async function serveHttp(port: number = DEFAULT_PORT): Promise<void> {
  const http = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "/";

    if (url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, server: "universal-assembler", transport: "streamable-http" }));
      return;
    }

    if (url === "/mcp" || url.startsWith("/mcp?")) {
      // Stateless mode: per SDK contract, each request needs a FRESH transport
      // and a fresh server. State that isn't ours to keep (sessions, message
      // history) is intentionally absent. The walked spec tree is rebuilt per
      // request so on-disk edits to *.spec files become visible immediately.
      const mcp = await createMcpServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      transport.onerror = (err: Error) => {
        process.stderr.write(`[mcp transport error] ${err.message}\n`);
      };
      // When the response closes, tear down the transport + server so handles
      // don't leak across requests.
      res.on("close", () => {
        transport.close().catch(() => {});
        mcp.close().catch(() => {});
      });
      try {
        await mcp.connect(transport);
        await transport.handleRequest(req, res);
      } catch (err) {
        process.stderr.write(`[mcp handler error] ${(err as Error).stack ?? (err as Error).message}\n`);
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "application/json" });
        }
        res.end(JSON.stringify({ error: (err as Error).message }));
      }
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found", hint: "POST /mcp for JSON-RPC, GET /health for liveness" }));
  });

  await new Promise<void>(resolve => http.listen(port, () => resolve()));
  process.stdout.write(`MCP HTTP server listening at http://127.0.0.1:${port}/mcp\n`);
}

// CLI entrypoint — runs only when this module is the process entrypoint.
import { pathToFileURL } from "node:url";
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await serveHttp(parsePort(process.argv.slice(2)));
}
