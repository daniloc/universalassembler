/**
 * debt.ts — the visible-debt ledger. Loud bypass instead of silent flags.
 *
 * The governor's principle (from the ass postmortem): when production is
 * free, verification is the scarce resource — so the substrate rations
 * growth to verified-green. But gates that only block get bypassed
 * silently (the --no-verify saga). Every bypass and every unverifiable
 * declaration becomes a LEDGER ENTRY: visible in next/digest, counted
 * against the metabolism budget, auto-cleared when the underlying
 * condition resolves.
 *
 * Ledger: <project>/.ua/debt.jsonl — one JSON object per line:
 *   { ts, kind, detail, cleared?: string }
 *
 * Kinds:
 *   forced-growth       — a growth gate was bypassed with --force
 *   unverifiable-claim  — a works-when line no primitive matches
 *   outputs-unchecked   — a node opted out of signature conformance
 *
 * CLI: node system/library/debt.ts list
 */

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface DebtEntry {
  ts: string;
  kind: "forced-growth" | "unverifiable-claim" | "outputs-unchecked";
  detail: string;
  cleared?: string;  // ISO timestamp when the condition stopped holding
}

export function debtPath(projectRoot: string): string {
  return join(projectRoot, ".ua", "debt.jsonl");
}

export async function readDebt(projectRoot: string): Promise<DebtEntry[]> {
  try {
    const raw = await readFile(debtPath(projectRoot), "utf8");
    return raw.split("\n").filter(Boolean).map(l => JSON.parse(l) as DebtEntry);
  } catch { return []; }
}

export async function openDebt(projectRoot: string): Promise<DebtEntry[]> {
  return (await readDebt(projectRoot)).filter(e => !e.cleared);
}

export async function recordDebt(
  projectRoot: string,
  kind: DebtEntry["kind"],
  detail: string,
): Promise<void> {
  // Dedupe: an open entry with the same kind+detail is the same debt.
  const open = await openDebt(projectRoot);
  if (open.some(e => e.kind === kind && e.detail === detail)) return;
  const entry: DebtEntry = { ts: new Date().toISOString(), kind, detail };
  const p = debtPath(projectRoot);
  await mkdir(dirname(p), { recursive: true });
  await appendFile(p, JSON.stringify(entry) + "\n");
}

/**
 * Reconcile the ledger against current reality: entries whose condition no
 * longer holds get cleared. `stillHolds` receives each open entry and says
 * whether its condition persists. Rewrites the file in place.
 */
export async function reconcileDebt(
  projectRoot: string,
  stillHolds: (e: DebtEntry) => boolean | Promise<boolean>,
): Promise<{ cleared: number; open: number }> {
  const all = await readDebt(projectRoot);
  let cleared = 0;
  for (const e of all) {
    if (e.cleared) continue;
    if (!(await stillHolds(e))) {
      e.cleared = new Date().toISOString();
      cleared++;
    }
  }
  const open = all.filter(e => !e.cleared).length;
  if (all.length > 0) {
    await writeFile(debtPath(projectRoot), all.map(e => JSON.stringify(e)).join("\n") + "\n");
  }
  return { cleared, open };
}

// ── The growth gate ────────────────────────────────────────────────────────
//
// Construction (new, define) refuses while verify has reds or drift has
// findings: growth is rationed to verified-green. --force overrides BUT
// records forced-growth debt — loud bypass, never silent. The gate must be
// fast and accurate or it trains bypass (the --no-verify saga); it reuses
// the same verify/drift the rest of the loop runs.

export interface GateResult {
  allowed: boolean;
  reasons: string[];
}

export async function growthGate(projectRoot: string, opts: { force?: boolean; action: string }): Promise<GateResult> {
  const reasons: string[] = [];
  try {
    const { walk } = await import("./walker.ts");
    const { verifyTree } = await import("./primitives.ts");
    const root = await walk(projectRoot);
    const result = await verifyTree(root, { root });
    const reds: string[] = [];
    (function collect(r: { node: { spec: { name: string } }; signals: Array<{ kind: string; predicate: string }>; children: unknown[] }) {
      for (const s of r.signals) if (s.kind === "fail") reds.push(`${r.node.spec.name}: ${s.predicate}`);
      for (const c of r.children) collect(c as typeof r);
    })(result as never);
    if (reds.length) reasons.push(`verify has ${reds.length} red claim(s): ${reds.slice(0, 3).join("; ")}${reds.length > 3 ? "; ..." : ""}`);
  } catch { /* no spec tree yet — greenfield is gate-exempt */ }

  try {
    const { collectDrift, driftTotal } = await import("./drift.ts");
    const report = await collectDrift(projectRoot);
    const total = driftTotal(report);
    if (total > 0) reasons.push(`drift has ${total} finding(s) — run: node system/library/drift.ts`);
  } catch { /* ditto */ }

  if (reasons.length === 0) return { allowed: true, reasons };
  if (opts.force) {
    await recordDebt(projectRoot, "forced-growth", `${opts.action} forced while: ${reasons.join(" | ")}`);
    process.stderr.write(
      `growth gate BYPASSED (--force) — forced-growth debt recorded:\n` +
      reasons.map(r => `  - ${r}\n`).join("") +
      `Clear it by getting back to green; the ledger clears itself on the next verify.\n`,
    );
    return { allowed: true, reasons };
  }
  process.stderr.write(
    `growth gate: construction is closed while the frontier is red.\n` +
    reasons.map(r => `  - ${r}\n`).join("") +
    `Fix the above (run: node system/library/next.ts) or pass --force to\n` +
    `proceed WITH a visible forced-growth debt entry.\n`,
  );
  return { allowed: false, reasons };
}

// ── CLI ────────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const cmd = process.argv[2] ?? "list";
  const root = process.cwd();
  if (cmd === "list") {
    const all = await readDebt(root);
    const open = all.filter(e => !e.cleared);
    if (open.length === 0) {
      process.stderr.write("debt: ledger clear\n");
      return 0;
    }
    for (const e of open) {
      process.stdout.write(`${e.ts}  ${e.kind.padEnd(20)} ${e.detail}\n`);
    }
    process.stderr.write(`\n${open.length} open (${all.length - open.length} cleared historically)\n`);
    return 0;
  }
  process.stderr.write("usage: debt.ts list\n");
  return 2;
}

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
const invokedDirectly = (() => {
  try {
    const argv1 = process.argv[1];
    if (!argv1) return false;
    return realpathSync(argv1) === realpathSync(fileURLToPath(import.meta.url));
  } catch { return false; }
})();
if (invokedDirectly) {
  main().then(code => process.exit(code));
}
