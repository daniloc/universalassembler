/**
 * start.ts — MCPServer's start verb. Spawned by an agent host (Claude Code,
 * Zed, etc.) as a child process. Speaks MCP over stdio.
 *
 *   node system/subassemblies/MCPServer/system/library/start.ts
 *
 * Usually you wouldn't run this by hand — your agent host invokes it per
 * the project's .mcp.json at the project root.
 */

import { startMcp } from "./server.ts";

await startMcp();
