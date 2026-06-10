/**
 * verify.ts — top-level runner. Calls verifyTree at the root; prints whatever
 * tree comes back; exits non-zero on any fail.
 *
 *   node system/library/verify.ts
 *
 * All real work — predicate evaluation, propagation to subassemblys — happens
 * in primitives.ts (verifyTree/verifySubassembly) and in each subassembly's
 * local verify.ts. The runner just kicks it off at the root and renders.
 */

import { walk } from "./walker.ts";
import { verifyTree, type VerifyResult } from "./primitives.ts";

interface Totals { pass: number; fail: number; unverified: number; }

function print(result: VerifyResult, prefix: string, isRoot: boolean, isLast: boolean): Totals {
  const connector = isRoot ? "" : (isLast ? "└── " : "├── ");
  console.log(`${prefix}${connector}${result.node.spec.name}`);
  const childPrefix = prefix + (isRoot ? "" : (isLast ? "    " : "│   "));

  const totals: Totals = { pass: 0, fail: 0, unverified: 0 };
  for (const sig of result.signals) {
    const mark = sig.kind === "pass" ? "✓" : sig.kind === "fail" ? "✗" : "?";
    const tail = sig.detail ? `  — ${sig.detail}` : sig.kind === "unverified" ? "  (no primitive matched)" : "";
    console.log(`${childPrefix}  ${mark} ${sig.predicate}${tail}`);
    totals[sig.kind === "pass" ? "pass" : sig.kind === "fail" ? "fail" : "unverified"]++;
  }
  for (let i = 0; i < result.children.length; i++) {
    const r = print(result.children[i], childPrefix, false, i === result.children.length - 1);
    totals.pass += r.pass; totals.fail += r.fail; totals.unverified += r.unverified;
  }
  return totals;
}

const root = await walk(process.cwd());
console.log("");
const result = await verifyTree(root, { root });
const totals = print(result, "", true, true);
console.log(`\n${totals.pass} pass, ${totals.fail} fail, ${totals.unverified} unverified`);

// ── Debt bookkeeping + the metabolism line ──────────────────────────────
// Every unverified claim is debt (a declaration nothing can check); every
// outputs-unchecked opt-out is debt; forced-growth debt clears when the
// frontier returns to green. The metabolism line is the governor's gauge:
// when production is free, verification is the scarce resource — this is
// the number that says whether growth is outrunning it.
{
  const { recordDebt, reconcileDebt, openDebt } = await import("./debt.ts");
  const projectRoot = process.cwd();

  const unverifiedSet = new Set<string>();
  const uncheckedNodes = new Set<string>();
  (function collect(r: typeof result) {
    for (const s of r.signals) {
      if (s.kind === "unverified") unverifiedSet.add(`${r.node.spec.name}: ${s.predicate}`);
    }
    for (const p of r.node.spec.worksWhen ?? []) {
      if (/^outputs\s+unchecked$/.test(p.trim())) uncheckedNodes.add(r.node.spec.name);
    }
    for (const c of r.children) collect(c);
  })(result);

  for (const u of unverifiedSet) await recordDebt(projectRoot, "unverifiable-claim", u);
  for (const n of uncheckedNodes) await recordDebt(projectRoot, "outputs-unchecked", n);

  const green = totals.fail === 0;
  await reconcileDebt(projectRoot, (e) => {
    if (e.kind === "unverifiable-claim") return unverifiedSet.has(e.detail);
    if (e.kind === "outputs-unchecked") return uncheckedNodes.has(e.detail);
    if (e.kind === "forced-growth") return !green;  // clears when frontier is green
    return true;
  });

  const open = await openDebt(projectRoot);
  const claims = totals.pass + totals.fail + totals.unverified;
  console.log(
    `metabolism: ${claims} claims, ${totals.pass} green, ${totals.fail} red, ` +
    `${totals.unverified} unverified, ${open.length} debt`,
  );
}

if (totals.fail > 0) process.exit(1);
