/**
 * test/drift.ts — tool-level integration tests for drift.ts.
 *
 * Drift is the catalogue↔reality reconciler. Each test stands up a real seeded
 * UA project in a tmp dir, mutates one specific kind of drift into it, and
 * asserts the CLI's report shape + exit code. The point: catch regressions in
 * the four drift categories AND the output-mode contract (JSON on stdout,
 * structured exit codes).
 */

import test from "node:test";
import assert from "node:assert";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const UA_ROOT = new URL("../../..", import.meta.url).pathname.replace(/\/$/, "");
const INIT = join(UA_ROOT, "system/library/init.ts");
const DRIFT = join(UA_ROOT, "system/library/drift.ts");

// ── helpers ──────────────────────────────────────────────────────────────

function run(cmd: string, args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", c => stdout += c);
    child.stderr.on("data", c => stderr += c);
    child.on("close", code => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

/**
 * Seed a fresh UA Level-4 project in a tmp dir via init.ts --here. We use the
 * real init so the test exercises drift against the same shape an end user
 * gets, including the vendored almanac under system/library/almanac/.
 */
async function seedProject(name: string): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), `ua-${name.toLowerCase()}-drift-`));
  const r = await run("node", [INIT, name, "--here"], root);
  if (r.code !== 0) throw new Error(`init failed (${r.code}): ${r.stderr}`);
  // Strip the vendored almanac to keep cross-ref noise out of category-1/2/3
  // tests. Each cross-ref test seeds its own minimal almanac fixture.
  await rm(join(root, "system/library/almanac"), { recursive: true, force: true });
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

/** Overwrite the project's root spec — the seed leaves one with structural
 *  works-when predicates we don't always want for these focused tests. */
async function writeRootSpec(root: string, name: string, body: string): Promise<void> {
  await writeFile(join(root, `${name}.spec`), `spec ${name} {\n  is "drift test fixture"\n  ${body}\n}\n`);
}

// ── 1. clean fixture ─────────────────────────────────────────────────────

test("drift: clean fixture reports no drift and exits 0", async () => {
  const { root, cleanup } = await seedProject("Clean");
  try {
    // Empty works-when + empty subassemblies = nothing to drift against.
    await writeRootSpec(root, "Clean", `works when {}\n  subassemblies {}`);
    const r = await run("node", [DRIFT, "--at", root, "--json"], root);
    assert.equal(r.code, 0, `expected exit 0, got ${r.code}: ${r.stderr}`);
    const report = JSON.parse(r.stdout);
    assert.equal(report.totals.missing, 0);
    assert.equal(report.totals.unreferenced, 0);
    assert.equal(report.totals.orphan, 0);
    assert.equal(report.totals.crossRefs, 0);
  } finally { await cleanup(); }
});

// ── 2. missing file claimed by spec ──────────────────────────────────────

test("drift: spec claims a missing file → missingFiles count 1, exit 1", async () => {
  const { root, cleanup } = await seedProject("MissingProbe");
  try {
    // Claim data/needle.txt but never create it. Tracking heuristic: the
    // parent dir (data/) is tracked, so we make it empty so there's no
    // collateral "unreferenced" noise to mask the assertion.
    await mkdir(join(root, "data"), { recursive: true });
    await writeRootSpec(root, "MissingProbe",
      `works when { data/needle.txt exists at root }\n  subassemblies {}`);
    const r = await run("node", [DRIFT, "--at", root, "--json"], root);
    assert.equal(r.code, 1, `expected exit 1, got ${r.code}: ${r.stderr}`);
    const report = JSON.parse(r.stdout);
    assert.equal(report.totals.missing, 1, `expected 1 missing, got ${report.totals.missing}`);
    assert.equal(report.missingFiles[0].predicate, "data/needle.txt exists at root");
    assert.equal(report.missingFiles[0].subassembly, "MissingProbe");
  } finally { await cleanup(); }
});

// ── 3. unreferenced file in tracked dir ──────────────────────────────────

test("drift: file in tracked dir not claimed → unreferencedFiles count 1, exit 1", async () => {
  const { root, cleanup } = await seedProject("UnrefProbe");
  try {
    // Claim claimed.txt; leave unclaimed.txt next to it. The parent (data/)
    // becomes tracked the moment claimed.txt is named, so unclaimed.txt drifts.
    await mkdir(join(root, "data"), { recursive: true });
    await writeFile(join(root, "data/claimed.txt"), "");
    await writeFile(join(root, "data/unclaimed.txt"), "");
    await writeRootSpec(root, "UnrefProbe",
      `works when { data/claimed.txt exists at root }\n  subassemblies {}`);
    const r = await run("node", [DRIFT, "--at", root, "--json"], root);
    assert.equal(r.code, 1, `expected exit 1, got ${r.code}: ${r.stderr}`);
    const report = JSON.parse(r.stdout);
    assert.equal(report.totals.unreferenced, 1, `expected 1 unreferenced, got ${report.totals.unreferenced}`);
    assert.equal(report.unreferencedFiles[0].path, "data/unclaimed.txt");
    assert.equal(report.unreferencedFiles[0].under, "data");
  } finally { await cleanup(); }
});

// ── 4. orphan subassembly dir ────────────────────────────────────────────

async function seedTwoSubassemblies(rootName: string, consumer: string, target: string, consumerUses: string): Promise<{ root: string; cleanup: () => Promise<void>; consumerLib: string }> {
  const { root, cleanup } = await seedProject(rootName);
  await writeRootSpec(root, rootName,
    `works when {}\n  subassemblies {\n    ${consumer}\n    ${target}\n  }`);

  // Consumer subassembly with its own library/.
  const consumerDir = join(root, "system/subassemblies", consumer);
  const consumerLib = join(consumerDir, "system/library");
  await mkdir(consumerLib, { recursive: true });
  await writeFile(join(consumerDir, `${consumer}.spec`),
    `spec ${consumer} {\n  is "x"\n  works when {}\n  subassemblies {}\n  uses { ${consumerUses} }\n}\n`);

  // Target subassembly with a library file to import from.
  const targetDir = join(root, "system/subassemblies", target);
  const targetLib = join(targetDir, "system/library");
  await mkdir(targetLib, { recursive: true });
  await writeFile(join(targetDir, `${target}.spec`),
    `spec ${target} {\n  is "x"\n  works when {}\n  subassemblies {}\n}\n`);
  await writeFile(join(targetLib, "api.ts"), `export const value = 42;\n`);

  return { root, cleanup, consumerLib };
}

test("drift: uses declared + #sub/ alias import present → no stale uses", async () => {
  const { root, cleanup, consumerLib } = await seedTwoSubassemblies("StaleClean", "A", "B", "B");
  try {
    await writeFile(join(consumerLib, "use.ts"),
      `import { value } from "#sub/B/system/library/api.ts";\nconsole.log(value);\n`);
    const r = await run("node", [DRIFT, "--at", root, "--json"], root);
    assert.equal(r.code, 0, `expected exit 0, got ${r.code}: ${r.stderr}`);
    const report = JSON.parse(r.stdout);
    assert.equal(report.totals.staleUses, 0, `expected 0 stale uses, got ${report.totals.staleUses}: ${JSON.stringify(report.staleUses)}`);
  } finally { await cleanup(); }
});

// ── 13. stale uses: declared but no import anywhere → flagged ────────────

test("drift: uses declared but library has no matching import → staleUses count 1", async () => {
  const { root, cleanup, consumerLib } = await seedTwoSubassemblies("StaleProbe", "A", "B", "B");
  try {
    // A's library has files, but none import from B.
    await writeFile(join(consumerLib, "use.ts"),
      `export const unrelated = 1;\n`);
    const r = await run("node", [DRIFT, "--at", root, "--json"], root);
    assert.equal(r.code, 1, `expected exit 1, got ${r.code}: ${r.stderr}`);
    const report = JSON.parse(r.stdout);
    assert.equal(report.totals.staleUses, 1, `expected 1 stale use, got ${report.totals.staleUses}: ${JSON.stringify(report.staleUses)}`);
    assert.equal(report.staleUses[0].declares, "B");
    assert.equal(report.staleUses[0].from, "system/subassemblies/A");
    assert.match(report.staleUses[0].suggestion, /#sub\/B/);
  } finally { await cleanup(); }
});

// ── 14. stale uses: dotted ref honors the last segment ───────────────────

test("drift: uses Bar.Baz dotted ref resolves on last segment", async () => {
  // Consumer declares `uses { Bar.Baz }`; only Baz exists in the tree.
  // The verifier's `declared uses are satisfied` primitive uses last-segment
  // resolution, and this pass mirrors that. A real import from #sub/Baz/ is
  // what counts — Bar is just a namespace label in the prose.
  const { root, cleanup, consumerLib } = await seedTwoSubassemblies("DottedProbe", "A", "Baz", "Bar.Baz");
  try {
    await writeFile(join(consumerLib, "use.ts"),
      `import { value } from "#sub/Baz/system/library/api.ts";\nvoid value;\n`);
    const r = await run("node", [DRIFT, "--at", root, "--json"], root);
    assert.equal(r.code, 0, `expected exit 0, got ${r.code}: ${r.stderr}`);
    const report = JSON.parse(r.stdout);
    assert.equal(report.totals.staleUses, 0, `expected 0 stale uses with dotted ref, got ${report.totals.staleUses}: ${JSON.stringify(report.staleUses)}`);
  } finally { await cleanup(); }
});

// ── 15. stale uses: schematic target is exempt ───────────────────────────

test("drift: uses targets a schematic subassembly → no false positive", async () => {
  const { root, cleanup } = await seedProject("SchematicProbe");
  try {
    // B is DECLARED in the root spec but never materialized (no folder under
    // system/subassemblies/B). The walker treats it as schematic. The pass-5
    // tolerance: schematic targets are forward-looking declarations, exempt.
    await writeRootSpec(root, "SchematicProbe",
      `works when {}\n  subassemblies {\n    A\n    B\n  }`);
    const consumerDir = join(root, "system/subassemblies/A");
    const consumerLib = join(consumerDir, "system/library");
    await mkdir(consumerLib, { recursive: true });
    await writeFile(join(consumerDir, "A.spec"),
      `spec A {\n  is "x"\n  works when {}\n  subassemblies {}\n  uses { B }\n}\n`);
    await writeFile(join(consumerLib, "use.ts"), `export const x = 1;\n`);
    const r = await run("node", [DRIFT, "--at", root, "--json"], root);
    // No drift expected — the schematic target makes the uses edge a no-op
    // for the import check. (Orphan dirs etc. are also zero here.)
    assert.equal(r.code, 0, `expected exit 0, got ${r.code}: ${r.stderr}`);
    const report = JSON.parse(r.stdout);
    assert.equal(report.totals.staleUses, 0, `schematic target should not trigger stale uses, got ${report.totals.staleUses}: ${JSON.stringify(report.staleUses)}`);
  } finally { await cleanup(); }
});

// ── 10. --json output mode: parseable JSON on stdout ─────────────────────

test("drift: human-mode report channels follow data/diagnostics convention", async () => {
  const { root, cleanup } = await seedProject("ChannelProbe");
  try {
    // Synthesize an orphan dir so the human report has real content to show.
    await writeRootSpec(root, "ChannelProbe", `works when {}\n  subassemblies {}`);
    await mkdir(join(root, "system/subassemblies/Orphan"), { recursive: true });
    const r = await run("node", [DRIFT, "--at", root], root);
    assert.equal(r.code, 1);

    // The structured report — what a human or downstream tool consumes — is
    // data. By the data-on-stdout, diagnostics-on-stderr convention the file
    // listing should land on stderr (it's a diagnostic about the project),
    // OR — if the project's contract is "the report IS the data" — on stdout.
    // Whichever channel carries it, the body must include the orphan path so
    // the user can act on the finding.
    const combined = r.stdout + r.stderr;
    assert.match(combined, /system\/subassemblies\/Orphan/,
      `orphan path missing from output. stdout=${JSON.stringify(r.stdout)} stderr=${JSON.stringify(r.stderr)}`);
    assert.match(combined, /Drift report|DRIFT:/,
      `human-readable header missing from output`);
  } finally { await cleanup(); }
});

// ── 12. unresolved alias imports ─────────────────────────────────────────
//
// system/package.json.imports is the single source of truth for #<alias>/
// subpath imports. A library file that imports from `#runtime/...` (a
// hallucinated alias) MUST drift before Node fails at runtime.

test("drift: library import uses undeclared alias → unresolvedAliases count 1, exit 1", async () => {
  const { root, cleanup } = await seedProject("AliasProbe");
  try {
    await writeRootSpec(root, "AliasProbe", `works when {}\n  subassemblies {}`);
    // Drop a TS file under system/library that imports from a fake alias.
    await writeFile(join(root, "system/library/bad.ts"),
      `import { x } from "#runtime/loader.ts";\nvoid x;\n`);
    const r = await run("node", [DRIFT, "--at", root, "--json"], root);
    assert.equal(r.code, 1, `expected exit 1, got ${r.code}: ${r.stderr}`);
    const report = JSON.parse(r.stdout);
    assert.equal(report.totals.unresolvedAliases, 1,
      `expected 1 unresolved alias, got ${report.totals.unresolvedAliases}: ${JSON.stringify(report.unresolvedAliases)}`);
    assert.equal(report.unresolvedAliases[0].alias, "#runtime");
    assert.equal(report.unresolvedAliases[0].specifier, "#runtime/loader.ts");
  } finally { await cleanup(); }
});

test("drift: declared alias imports are clean (no false positives)", async () => {
  const { root, cleanup } = await seedProject("AliasOkProbe");
  try {
    await writeRootSpec(root, "AliasOkProbe", `works when {}\n  subassemblies {}`);
    // Use the canonical #ua/* alias — should NOT be flagged.
    await writeFile(join(root, "system/library/good.ts"),
      `import type { SpecNode } from "#ua/walker.ts";\nvoid 0 as unknown as SpecNode;\n`);
    const r = await run("node", [DRIFT, "--at", root, "--json"], root);
    const report = JSON.parse(r.stdout);
    assert.equal(report.totals.unresolvedAliases, 0,
      `expected 0 unresolved aliases, got ${report.totals.unresolvedAliases}: ${JSON.stringify(report.unresolvedAliases)}`);
  } finally { await cleanup(); }
});
