#!/usr/bin/env node
/**
 * next.ts — "what should I do now?" — the single canonical next-action command.
 *
 *   node system/library/next.ts
 *
 * UA's substrate already exposes verify, walker, drift, almanac as separate
 * commands. An agent has to know to consult each and synthesize. `next` is
 * the PATH: it reads {spec tree, verify state, drift, file vs template} and
 * prints ONE recommended next action with a runnable command.
 *
 * Decision tree (first hit wins):
 *   1. No *.spec at cwd            →  "declare your root spec"
 *   2. Verify has failures         →  "fix the first red predicate" (cite predicate + node)
 *   3. Drift orphan subassembly    →  "wire <Foo> into <Parent>.spec subassemblies block"
 *      (materialized on disk but no parent spec declares it)
 *   4. Drift stale uses            →  "import #sub/<X>/ in <subassembly> or remove the uses declaration"
 *   5. Drift cross-ref drift       →  "fix the broken pattern.md / recipe reference"
 *   6. Drift missing files         →  "create <path> claimed by works-when"
 *   7. Drift unresolved aliases    →  "register #<alias> in system/package.json.imports"
 *   8. Unimplemented contract      →  "implement <Sub> per its word's claims"
 *   9. Else                        →  "all green; npm test, commit, digest"
 *
 * Output: human-readable to stderr (one-paragraph rationale), the recommended
 * shell command to stdout. So `eval "$(node next.ts)"` runs the suggestion.
 * Data → stdout, diagnostics → stderr convention.
 *
 * Exits 0 if a recommendation was emitted, 1 if we couldn't compute one.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { walk, type SpecNode } from "./walker.ts";
import { verifyTree, type VerifyResult } from "./primitives.ts";
import { collectDrift, driftTotal, type DriftReport } from "./drift.ts";


interface Recommendation {
  command: string;     // runnable shell command (stdout)
  why: string;         // one-line rationale (stderr)
  category: "declare" | "fix-red" | "fix-drift" | "implement" | "ship";
}

/**
 * Translate the first drift finding into a recommendation. Order matters:
 * orphans first (they signal a missed wiring step that other passes may
 * cascade from), then stale uses, cross-refs, missing files, unresolved
 * aliases. Unreferenced files are last — usually noise after the post-R4
 * outputs coverage in Pass 1.
 */
function driftToRec(d: DriftReport): Recommendation | null {
  if (d.orphanDirs.length > 0) {
    const o = d.orphanDirs[0];
    return {
      command: `# add \`${basenameOf(o.path)}: "<role>"\` to ${o.parent}.spec subassemblies block`,
      why: `${o.path} is materialized on disk but not declared in ${o.parent}.spec subassemblies block. Wire it in (or delete the dir if it was added by mistake).`,
      category: "fix-drift",
    };
  }
  if (d.staleUses.length > 0) {
    const s = d.staleUses[0];
    return {
      command: `# in ${s.from} library code, import from #sub/${s.declares}/system/library/... — or remove "uses { ${s.declares} }" from the spec`,
      why: `${s.from} declares uses { ${s.declares} } but no library file imports from #sub/${s.declares}/. Wire the import or drop the declaration.`,
      category: "fix-drift",
    };
  }
  if (d.crossReferences.length > 0) {
    const c = d.crossReferences[0];
    return {
      command: `node system/library/drift.ts`,
      why: `cross-reference drift: ${c.file} references ${c.kind ?? "a pattern"} that no longer exists. Run drift for the full list.`,
      category: "fix-drift",
    };
  }
  if (d.missingFiles.length > 0) {
    const m = d.missingFiles[0];
    return {
      command: `# create the file claimed by "${m.predicate}" in ${m.specPath}`,
      why: `${m.subassembly} declares "${m.predicate}" but the file isn't on disk. Create it (or remove the claim).`,
      category: "fix-drift",
    };
  }
  if (d.unresolvedAliases.length > 0) {
    const u = d.unresolvedAliases[0];
    return {
      command: `# register \`"${u.alias}/*": "..."\` in system/package.json imports — or fix the import in ${u.from}`,
      why: `${u.from} imports from ${u.specifier}; alias ${u.alias} is not declared in system/package.json.imports.`,
      category: "fix-drift",
    };
  }
  if (d.unreferencedFiles.length > 0) {
    const u = d.unreferencedFiles[0];
    return {
      command: `# either declare ${u.path} as an output in the parent spec, or delete the file`,
      why: `${u.path} exists under ${u.under} but isn't claimed by any spec (no exists-at predicate, no output declaration).`,
      category: "fix-drift",
    };
  }
  return null;
}

function basenameOf(p: string): string {
  const last = p.split("/").filter(Boolean).pop() ?? p;
  return last;
}

async function findRootSpec(dir: string): Promise<string | null> {
  try {
    const entries = await readdir(dir);
    for (const e of entries) {
      if (e.endsWith(".spec") && !e.startsWith(".")) return join(dir, e);
    }
    return null;
  } catch { return null; }
}

function firstFailure(result: VerifyResult, path: string[] = []): { node: string; predicate: string; detail?: string } | null {
  const here = [...path, result.node.spec.name];
  for (const sig of result.signals) {
    if (sig.kind === "fail") {
      return { node: here.join("/"), predicate: sig.predicate, detail: sig.detail };
    }
  }
  for (const c of result.children) {
    const hit = firstFailure(c, here);
    if (hit) return hit;
  }
  return null;
}

/**
 * A worded spec (LINEAGE word:) whose system/library/ is empty is a
 * materialized CONTRACT awaiting implementation — `new` issues contracts,
 * the model implements them. Returns the first one found.
 */
async function findUnimplementedContract(root: SpecNode, projectRoot: string): Promise<{ subassembly: string; word: string } | null> {
  async function visit(node: SpecNode, dirOnDisk: string): Promise<{ subassembly: string; word: string } | null> {
    const specPath = join(dirOnDisk, `${node.spec.name}.spec`);
    try {
      const src = await readFile(specPath, "utf8");
      const wordMatch = src.match(/^\/\/\s+word:\s+(\S+)/m);
      if (wordMatch) {
        const libDir = join(dirOnDisk, "system", "library");
        let entries: string[] = [];
        try { entries = (await readdir(libDir)).filter(f => !f.startsWith(".")); } catch { /* none */ }
        if (entries.length === 0) return { subassembly: node.spec.name, word: wordMatch[1] };
      }
    } catch { /* no spec file here */ }
    for (const sub of node.subassemblies) {
      if ("schematic" in sub) continue;
      const childName = (sub as SpecNode).spec.name;
      const hit = await visit(sub as SpecNode, join(dirOnDisk, "system/subassemblies", childName));
      if (hit) return hit;
    }
    return null;
  }
  return visit(root, projectRoot);
}

async function recommend(projectRoot: string): Promise<Recommendation> {
  // Step 1: root spec present?
  const rootSpec = await findRootSpec(projectRoot);
  if (!rootSpec) {
    return {
      command: `echo 'spec <YourProjectName> {\\n  is "<one-line>"\\n}' > <YourProjectName>.spec`,
      why: "no *.spec found at the project root. UA is spec-first; declare it before adding subassemblies.",
      category: "declare",
    };
  }

  // Step 2: verify failures?
  const root = await walk(projectRoot);
  const result = await verifyTree(root, { root });
  const fail = firstFailure(result);
  if (fail) {
    return {
      command: `node system/library/verify.ts`,
      why: `${fail.node} has a failing predicate: "${fail.predicate}"${fail.detail ? ` — ${fail.detail}` : ""}. Run verify to see the full tree.`,
      category: "fix-red",
    };
  }

  // Step 3: structural drift? Surfaces orphan subassemblies (materialized
  // on disk but not declared in parent), stale uses (declared but not
  // imported), missing files, cross-ref drift, unresolved aliases.
  // The docs-eval run on 2026-06-08 surfaced an orphan MCPServer that
  // next.ts didn't catch because it never consulted drift; this closes
  // that coverage gap.
  const driftReport = await collectDrift(projectRoot);
  if (driftTotal(driftReport) > 0) {
    const driftRec = driftToRec(driftReport);
    if (driftRec) return driftRec;
  }

  // Step 4: open debt? The governor's ledger — unverifiable claims,
  // opt-outs, forced growth. Debt is cleared by resolving the underlying
  // condition; next routes there before recommending new construction.
  const { openDebt } = await import("./debt.ts");
  const debt = await openDebt(projectRoot);
  if (debt.length > 0) {
    const top = debt[0];
    const hint =
      top.kind === "unverifiable-claim"
        ? "make the claim verifiable (add/extend a primitive, fix the predicate, or remove the line)"
        : top.kind === "outputs-unchecked"
          ? "restore signature conformance (fix the signatures, then drop the opt-out line)"
          : "get the frontier back to green (the entry clears itself on the next green verify)";
    return {
      command: `node system/library/debt.ts list`,
      why: `${debt.length} open debt entr${debt.length === 1 ? "y" : "ies"}. Top: [${top.kind}] ${top.detail} — ${hint}.`,
      category: "fix-drift",
    };
  }

  // Step 5: unimplemented contracts — a worded spec (LINEAGE word:) with an
  // empty system/library/ is a contract awaiting its implementation.
  const unimplemented = await findUnimplementedContract(root, projectRoot);
  if (unimplemented) {
    return {
      command: `node system/library/dictionary.ts show ${unimplemented.word}`,
      why: `${unimplemented.subassembly} is a materialized contract (word: ${unimplemented.word}) with an empty library — implement it per the word's claims and pinned choices.`,
      category: "implement",
    };
  }

  // Step 6: all green.
  // Only recommend `npm test` when a test script actually exists — a fresh
  // seed has none, and the path's one recommendation must never be wrong
  // (cold-start probe, 2026-06-10).
  let hasTestScript = false;
  try {
    const pkg = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8")) as { scripts?: Record<string, string> };
    hasTestScript = !!pkg.scripts?.test;
  } catch { /* no package.json */ }
  return hasTestScript
    ? {
        command: `npm test`,
        why: "spec verified, all subassembly bodies look implemented, ledger clear. Run your tests, commit, then `node system/library/digest.ts` for the human-readable wrap-up.",
        category: "ship",
      }
    : {
        command: `node system/library/digest.ts`,
        why: "spec verified, ledger clear. Grow the frontier (node system/library/new.ts --bare <Name> for a fresh subassembly, or from a dictionary word), or wrap up with the digest.",
        category: "ship",
      };
}

const root = process.argv[2] ? resolve(process.argv[2]) : process.cwd();
const rec = await recommend(root);

process.stderr.write(`next: ${rec.why}\n\n`);
process.stdout.write(`${rec.command}\n`);
process.exit(0);
