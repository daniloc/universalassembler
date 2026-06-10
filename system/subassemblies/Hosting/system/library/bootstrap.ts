/**
 * bootstrap.ts — Hosting's liveness report. Regenerates tree.json, probes wrangler dev
 * detached if :8787 isn't already answering, surfaces the deploy command as
 * next-step context.
 */

import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { SpecNode } from "../../../../library/walker.ts";
import type { BootstrapResult, Ctx } from "../../../../library/primitives.ts";

export async function bootstrap(node: SpecNode, ctx: Ctx): Promise<BootstrapResult> {
  const here = dirname(fileURLToPath(import.meta.url));
  const projectRoot = ctx.root.diskPath;
  const relHere = relative(projectRoot, here);
  const outputs: string[] = [];

  // 1. Always refresh tree.json before bringup.
  const treejsonScript = join(here, "treejson.ts");
  const extracted = spawnSync("node", [treejsonScript], { cwd: projectRoot });
  if (extracted.status !== 0) {
    return { node, status: "failed", outputs, detail: "extract failed", children: [] };
  }
  writeFileSync(join(here, "tree.json"), extracted.stdout);
  outputs.push(`${relHere}/tree.json (regenerated)`);

  // 2. wrangler dev — PROBE ONLY, never spawn (bootstrap is a verifier-side
  // report; spawning belongs to operator verbs like dev.ts / deploy.ts).
  const url = "http://127.0.0.1:8787/";
  if (await isUp(url)) {
    outputs.push(`${url} (preview up)`);
    return {
      node,
      status: "ready",
      outputs,
      next: [`node ${relHere}/deploy.ts   # ship to production (requires \`npx wrangler login\`)`],
      children: [],
    };
  }
  return {
    node,
    status: "skipped",
    outputs,
    detail: `wrangler preview down — start with: node ${relHere}/dev.ts`,
    children: [],
  };
}

async function isUp(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(500) });
    return res.ok;
  } catch { return false; }
}

