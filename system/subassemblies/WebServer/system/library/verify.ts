/**
 * verify.ts — WebServer's local subtree verifier.
 *
 * Honest propagation: uses the shared verifyTree, which runs WebServer's own
 * `works when` claims with the central primitives and recurses to any
 * subassemblies (none here). WebServer could extend the primitives list,
 * replace it entirely, or fabricate the subtree — that's its business.
 */

import type { SpecNode } from "../../../../library/walker.ts";
import { verifyTree, type VerifyResult, type Ctx } from "../../../../library/primitives.ts";

export async function verify(node: SpecNode, ctx: Ctx): Promise<VerifyResult> {
  return verifyTree(node, ctx);
}
