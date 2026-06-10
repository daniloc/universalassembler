/**
 * bootstrap.ts — MCPServer's bringup status.
 *
 * Stdio is the primary transport for UA itself — agent hosts (Claude Code,
 * Zed) spawn `start.ts` per the project's .mcp.json. Nothing to start at
 * bootstrap time; we just report readiness + how to plug in.
 *
 * HTTP is opt-in for projects that vendor the MCPServer pattern; if a
 * HttpTransport subassembly has been elaborated (it's a child node, not a
 * schematic stub), we delegate to it so it can spawn its own listener.
 *
 * Previously this returned `children: []` unconditionally, which silently
 * swallowed any elaborated child's bringup. Round 4 surfaced that bug.
 */

import { bootstrapSubassembly } from "#ua/primitives.ts";
import type { SpecNode } from "#ua/walker.ts";
import type { BootstrapResult, Ctx } from "#ua/primitives.ts";

export async function bootstrap(node: SpecNode, ctx: Ctx): Promise<BootstrapResult> {
  // Delegate to any elaborated children (schematic stubs are skipped by
  // bootstrapSubassembly's contract).
  const children = await Promise.all(
    node.subassemblies
      .filter(s => !("schematic" in s))
      .map(s => bootstrapSubassembly(s as SpecNode, ctx)),
  );

  return {
    node,
    status: "ready",
    outputs: ["stdio MCP — agent hosts spawn it from .mcp.json"],
    next: [
      "agents that read .mcp.json will pick stdio up automatically",
      "manual stdio test: node system/subassemblies/MCPServer/system/library/start.ts (sits on stdin waiting for an MCP client)",
      "HTTP transport (opt-in): node system/subassemblies/MCPServer/system/library/serveHttp.ts [--port 7437]",
    ],
    children,
  };
}
