/**
 * bootstrap.ts — WebServer's liveness report. PROBE ONLY — never spawns.
 *
 * The old version spawned start.ts detached when :3000 wasn't answering.
 * That pattern is what produced the months-long pre-commit-vs-CLI ghost:
 * leaked detached listeners from test sandboxes squatted the port, this
 * bootstrap silently no-op'd ("already running"), and verify failed on
 * routes the squatter didn't serve. A verifier that mutates the world it
 * measures is not a verifier. Bringup is the operator's (or next's) move —
 * this reports state and the exact command.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SpecNode } from "../../../../library/walker.ts";
import type { BootstrapResult, Ctx } from "../../../../library/primitives.ts";

export async function bootstrap(node: SpecNode, _ctx: Ctx): Promise<BootstrapResult> {
  // /health is the almanac WebServer convention. Bootstrap probes it so we
  // know the listener is live without depending on any specific app route.
  const healthUrl = "http://localhost:3000/health";
  const rootUrl = "http://localhost:3000/";
  if (await isUp(healthUrl)) {
    return { node, status: "ready", outputs: [`${rootUrl} (up)`], children: [] };
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const startScript = join(here, "start.ts");
  return {
    node,
    status: "skipped",
    outputs: [],
    detail: `WebServer down — start with: node ${startScript}`,
    children: [],
  };
}

async function isUp(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(500) });
    return res.ok;
  } catch { return false; }
}
