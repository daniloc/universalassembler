/**
 * serve.ts — runtime-agnostic Hono routing for the spec tree.
 *
 * Generic local code: both WebServer (Node listener) and Hosting (Workers fetch
 * handler) build the same app here. The renderer is pure (no fs), so this works
 * unchanged in any JS runtime that supports Hono.
 */

import { Hono } from "hono";
import type { SpecNode } from "../../../../library/walker.ts";
import { render, renderTree } from "./render.ts";

export function buildApp(root: SpecNode): Hono {
  const app = new Hono();
  const routes = new Map<string, SpecNode>();
  index(root, "/", routes);

  // /health — liveness probe. WebServer conforms to the almanac WebServer
  // pattern: /health responds 200 with "ok". Bootstrap probes this.
  app.get("/health", (c) => c.text("ok"));

  app.get("*", (c) => {
    const path = c.req.path;
    if (path === "/") return c.html(renderTree(root));
    const node = routes.get(path);
    if (!node) return c.html(notFound(path), 404);
    return c.html(render(node, path));
  });

  return app;
}

function index(node: SpecNode, urlPath: string, out: Map<string, SpecNode>): void {
  out.set(urlPath, node);
  for (const sub of node.subassemblies) {
    if ("schematic" in sub) continue;
    const child = urlPath === "/" ? `/${sub.spec.name}` : `${urlPath}/${sub.spec.name}`;
    index(sub, child, out);
  }
}

function notFound(path: string): string {
  const safe = path.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c as "&" | "<" | ">" | '"']));
  return `<!doctype html><meta charset="utf-8"><title>404</title>
<body style="font:16px system-ui;max-width:480px;margin:4rem auto;padding:0 1rem">
<h1>404</h1><p>No spec at <code>${safe}</code>.</p>
<p><a href="/">Back to UniversalAssembler</a></p></body>`;
}
