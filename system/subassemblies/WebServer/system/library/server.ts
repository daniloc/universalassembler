/**
 * server.ts — WebServer subassembly: Node HTTP listener for local development.
 *
 * The routing lives in the Documents subassembly (serve.ts beside the renderer); this file only
 * supplies the Node-specific listener. The Hosting subassembly does the same
 * shape with a CloudFlare Workers fetch handler instead of a Node listener.
 */

import { serve } from "@hono/node-server";
import type { Hono } from "hono";
import type { SpecNode } from "../../../../library/walker.ts";
import { buildApp } from "../../../Documents/system/library/serve.ts";

// The almanac/WebServer template's canonical factory shape is `() => Hono`.
// UA's own WebServer needs the project's root SpecNode to wire the routes,
// so the signature diverges deliberately — declared as `module server` in
// the spec with the project-specific type, not the generic template type.
export function server(root: SpecNode): Hono {
  return buildApp(root);
}

export function start(root: SpecNode, port: number = 3000): void {
  const app = server(root);
  serve({ fetch: app.fetch, port }, (info) => {
    console.log(`UniversalAssembler home: http://localhost:${info.port}/`);
  });
}
