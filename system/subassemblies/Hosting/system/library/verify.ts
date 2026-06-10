/**
 * verify.ts — Hosting's local subtree verifier. A black-box demo.
 *
 * Hosting cares about CloudFlare-specific things: wrangler.jsonc presence,
 * worker.ts being valid, the Workers preview answering on 8787 with the right
 * bytes. None of that needs the shared primitive grammar; it's all one-offs.
 *
 * So this verifier ignores the central primitives entirely and just runs the
 * checks it cares about, returning a VerifyResult tree with its own signals.
 * The orchestrator doesn't know or care. That's the black-box property.
 */

import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { SpecNode } from "../../../../library/walker.ts";
import type { VerifyResult, Signal, Ctx } from "../../../../library/primitives.ts";

export async function verify(node: SpecNode, _ctx: Ctx): Promise<VerifyResult> {
  const signals: Signal[] = [
    await fileCheck("wrangler.jsonc present", join(node.diskPath, "system", "library", "wrangler.jsonc")),
    await fileCheck("worker.ts present", join(node.diskPath, "system", "library", "worker.ts")),
    await fileCheck("tree.json built", join(node.diskPath, "system", "library", "tree.json")),
    await httpCheck("preview answers 200 with site name", "http://localhost:8787/", 200, "UniversalAssembler"),
  ];
  return { node, signals, children: [] };
}

async function fileCheck(label: string, path: string): Promise<Signal> {
  try { await stat(path); return { kind: "pass", predicate: label }; }
  catch { return { kind: "fail", predicate: label, detail: `missing: ${path}` }; }
}

async function httpCheck(label: string, url: string, wantStatus: number, wantBody?: string): Promise<Signal> {
  try {
    const res = await fetch(url);
    if (res.status !== wantStatus) return { kind: "fail", predicate: label, detail: `got ${res.status}` };
    if (wantBody && !(await res.text()).includes(wantBody)) return { kind: "fail", predicate: label, detail: `body missing "${wantBody}"` };
    return { kind: "pass", predicate: label };
  } catch (e) { return { kind: "fail", predicate: label, detail: `unreachable: ${(e as Error).message}` }; }
}
