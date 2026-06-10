/**
 * drift.ts — surface the gap between source files and the spec catalogue.
 *
 *   node system/library/drift.ts [--json] [--at <root>]
 *
 * What it does: walks the spec tree + the project's source tree, reports
 *
 *   1. Files claimed by a spec but missing on disk
 *   2. Source files under tracked directories that no spec references
 *   3. Subassembly directories without specs (orphan folders)
 *   4. Specs that point at empty/nonexistent files
 *   5. Stale `uses` edges — declared but no library code imports from the target
 *   6. Unresolved `#<alias>/` imports — alias not declared in system/package.json.imports
 *
 * This is the maintenance tool that closes the catalogue-vs-reality loop.
 * Without it, the catalogue silently lies the moment source moves.
 *
 * Output: stdout = structured drift report (one section per kind), stderr
 * = progress + diagnostics. Exit code 0 if no drift, 1 if drift found,
 * 2 on usage error.
 *
 * Convention for what's "tracked": every `<glob> exists at <scope>` predicate
 * in any spec's works-when names a real path. We treat the parent directory
 * of any such path as "tracked." Files in tracked dirs that aren't named in
 * any spec are drift candidates.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { pathToFileURL, fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { walk, type SpecNode } from "#ua/walker.ts";

export interface DriftReport {
  missingFiles: Array<{ specPath: string; subassembly: string; predicate: string }>;
  unreferencedFiles: Array<{ path: string; under: string }>;
  orphanDirs: Array<{ path: string; parent: string }>;
  crossReferences: Array<{ from: string; references: string; kind: "composes-with" | "subassembly" | "uses" | "install" }>;
  staleUses: Array<{ from: string; declares: string; suggestion: string }>;
  unresolvedAliases: Array<{ from: string; specifier: string; alias: string }>;
  totals: { missing: number; unreferenced: number; orphan: number; crossRefs: number; staleUses: number; unresolvedAliases: number };
}

const HELP = `Usage: drift.ts [--at <root>] [--json] [--help]

Walk the spec tree + source tree, report drift between them.

  --at <root>   project root (default: cwd)
  --json        emit the report as JSON on stdout
  --help        show this message and exit 0

Exit 0 if no drift, 1 if drift detected, 2 on usage error.
`;

/**
 * Programmatic API: walk passes 1-6, return the populated DriftReport.
 * The default export wraps this with stdout/stderr printing + exit code.
 * Callers that want to react to drift findings inline (e.g. next.ts)
 * should use this directly.
 */
export async function collectDrift(rootDir: string): Promise<DriftReport> {
  const root = await walk(rootDir);
  const report: DriftReport = {
    missingFiles: [],
    unreferencedFiles: [],
    orphanDirs: [],
    crossReferences: [],
    staleUses: [],
    unresolvedAliases: [],
    totals: { missing: 0, unreferenced: 0, orphan: 0, crossRefs: 0, staleUses: 0, unresolvedAliases: 0 },
  };

  // Pass 1: collect all paths that specs CLAIM exist.
  //
  // Two sources of claims:
  //   (a) `<path> exists at <scope>` predicates in works-when blocks
  //   (b) typed outputs declarations (R2/R4 grammar). A spec that declares
  //       `verb start :: ...` or `module store :: ...` is claiming that
  //       system/library/<name>.ts exists at this node. A `file <path>`
  //       output claims the literal path. (resource outputs are runtime.)
  //
  // Without (b), files materialized via almanac add but only referenced
  // via the outputs block (the common case post-R4) get falsely flagged
  // as "unreferenced" by Pass 2. The materializer's contract is that
  // outputs map to library files; drift's notion of "claimed" must match.
  //
  // Tracking heuristic: only track the PARENT dir of a claimed FILE. The idea
  // is "a spec named foo.ts in this dir; siblings should be named too." We
  // deliberately do NOT track:
  //   - parents of claimed directories (claiming `system/subassemblies` says
  //     the dir must exist, not that every sibling of it must be enumerated;
  //     otherwise `system/package.json` would spuriously drift)
  //   - the claimed directory itself (the directory's contents are governed by
  //     subassembly declarations + their own specs, not the parent claim)
  const claimedPaths = new Set<string>();
  const trackedDirs = new Set<string>();
  await visit(root, async (node) => {
    for (const pred of node.spec.worksWhen) {
      const m = /^(\S+)\s+exists\s+at\s+(every\s+node|root|this\s+node)$/.exec(pred);
      if (!m) continue;
      const [, pathSpec, scope] = m;
      if (pathSpec.includes("*")) continue;  // skip globs — too broad for drift
      const anchorDir = scope === "this node" ? node.diskPath : rootDir;
      const fullPath = join(anchorDir, pathSpec);
      const relPath = relative(rootDir, fullPath);
      // Skip claims that resolve outside the project root.
      if (relPath.startsWith("..")) continue;
      claimedPaths.add(relPath);
      let st;
      try { st = await stat(fullPath); } catch {
        report.missingFiles.push({
          specPath: relative(rootDir, node.diskPath) || ".",
          subassembly: node.spec.name,
          predicate: pred,
        });
        // Missing — assume it was meant as a file; track parent.
        if (!isArtifactPath(relPath)) trackedDirs.add(dirname(relPath));
        continue;
      }
      if (!st.isDirectory() && !isArtifactPath(relPath)) {
        trackedDirs.add(dirname(relPath));
      }
      // If it IS a directory, neither it nor its parent get tracked.
      // Artifact paths (build/, dist/, .svelte-kit/ ...) are never tracked:
      // a membrane claim on one build artifact must not demand every emitted
      // sibling be individually claimed — capsule outputs are rotation, not
      // catalogue.
    }
    // (b) outputs declarations — verb/module/file. The library/ dir under
    // this node is implicitly tracked so Pass 2 doesn't flag declared exports
    // (or their helpers) as unreferenced.
    const nodeLibDir = relative(rootDir, join(node.diskPath, "system/library"));
    let hasLibClaim = false;
    for (const out of node.spec.outputs ?? []) {
      if (out.category === "resource") continue;
      let relPath: string;
      if (out.category === "file") {
        // file outputs may be at the node root or under library/; keep verbatim.
        relPath = relative(rootDir, join(node.diskPath, out.name));
      } else {
        // verb/module outputs name a .ts file under system/library/.
        relPath = relative(rootDir, join(node.diskPath, "system/library", `${out.name}.ts`));
      }
      if (relPath.startsWith("..")) continue;
      claimedPaths.add(relPath);
      hasLibClaim = true;
    }
    // If we registered any verb/module output, the library/ dir is the
    // collection scope and shouldn't be tracked separately (its files are
    // intentionally declared piecewise via outputs, plus helpers).
    if (hasLibClaim) {
      // Reserve the library dir from triggering Pass 2 sweeps.
      trackedDirs.delete(nodeLibDir);
    }
  });

  // Pass 2: walk each tracked directory; files not in claimedPaths are unreferenced.
  for (const dir of trackedDirs) {
    let entries: string[];
    try { entries = await readdir(join(rootDir, dir)); } catch { continue; }
    for (const name of entries) {
      if (name.startsWith(".")) continue;
      const rel = join(dir, name);
      if (claimedPaths.has(rel)) continue;
      // Only flag files — directories are subassembly containers, fine to
      // exist without being individually claimed.
      let st;
      try { st = await stat(join(rootDir, rel)); } catch { continue; }
      if (st.isFile()) {
        report.unreferencedFiles.push({ path: rel, under: dir });
      }
    }
  }

  // Pass 3: orphan subassembly directories. For each spec's diskPath, walk
  // system/subassemblies and flag folders not declared in the spec.
  await visit(root, async (node) => {
    const declared = new Set(node.spec.subassemblies.map(s => s.name));
    const subsDir = join(node.diskPath, "system", "subassemblies");
    let folders: string[];
    try { folders = await readdir(subsDir); } catch { return; }
    for (const folder of folders) {
      if (folder.startsWith(".")) continue;
      if (!declared.has(folder)) {
        report.orphanDirs.push({
          path: relative(rootDir, join(subsDir, folder)),
          parent: node.spec.name,
        });
      }
    }
  });

  // Pass 5: stale `uses` edges. `conforms to <Word>` already
  // enforces shape conformance; `uses { Foo }` already enforces Foo exists in
  // the tree. Neither checks the consuming code ACTUALLY imports from Foo's
  // library — a subassembly can declare `uses { Foo }` and never wire it up.
  // Stale declarations are silent rot; this pass walks each declaring node's
  // library/**/*.ts and flags any uses edge with no static import evidence.
  await collectStaleUses(rootDir, root, report);

  // Pass 6: unresolved alias imports. `system/package.json.imports` is the
  // single source of truth for #<alias>/ subpath imports. Any TS file under
  // system/library/** (project core or vendored almanac) that imports from
  // `#<alias>/...` MUST find that alias declared there — otherwise Node fails
  // at module-resolution time, but only when the importing file is exercised.
  // This pass catches the silent gap before runtime.
  await collectUnresolvedAliases(rootDir, report);

  report.totals = {
    missing: report.missingFiles.length,
    unreferenced: report.unreferencedFiles.length,
    orphan: report.orphanDirs.length,
    crossRefs: report.crossReferences.length,
    staleUses: report.staleUses.length,
    unresolvedAliases: report.unresolvedAliases.length,
  };

  return report;
}

export function driftTotal(r: DriftReport): number {
  return r.totals.missing + r.totals.unreferenced + r.totals.orphan +
         r.totals.crossRefs + r.totals.staleUses + r.totals.unresolvedAliases;
}

export default async function drift(opts: { at?: string; json?: boolean } = {}): Promise<number> {
  const rootDir = opts.at ?? process.cwd();
  let report: DriftReport;
  try { report = await collectDrift(rootDir); } catch (e) {
    process.stderr.write(`drift: cannot walk ${rootDir}: ${(e as Error).message}\n`);
    return 1;
  }

  if (opts.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    printHuman(report);
  }

  return driftTotal(report) > 0 ? 1 : 0;
}

// ── Pass 5 helpers ────────────────────────────────────────────────────────
//
// For each elaborated subassembly that declares `uses { ... }`, walk its
// library/**/*.ts and check at least one file imports from the target's
// library. Two acceptable shapes:
//
//   - `#sub/<Target>/system/library/...`  → canonical alias, hard match
//   - relative path resolving to <Target>'s diskPath/system/library  → soft
//     pass, recorded as drift WITH a note suggesting migration to #sub/*
//
// Tolerances (encoded as silent skips, not flags):
//   - SCHEMATIC targets are exempt — the `uses` declaration is forward-looking,
//     no library exists yet to import from.
//   - RPC/DI coupling (ctx.hive.<Foo>) doesn't appear as a static import; we
//     can't see it from this side of the file. Documented limitation; the
//     common direct-import case is what this catches.

/** Index every elaborated SpecNode by name. The verifier's `declared uses are
 *  satisfied` primitive matches on the last dotted segment of a uses ref, so
 *  we follow the same convention here — Foo.Bar resolves to whatever is named
 *  Bar in the tree. */
function indexElaborated(root: SpecNode): Map<string, SpecNode> {
  const out = new Map<string, SpecNode>();
  (function index(n: SpecNode): void {
    out.set(n.spec.name, n);
    for (const s of n.subassemblies) {
      if (!("schematic" in s)) index(s as SpecNode);
    }
  })(root);
  return out;
}

/** Recursively yield every *.ts file under `dir`. Missing dirs return []. */
async function listTsFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walkDir(d: string): Promise<void> {
    let entries: string[];
    try { entries = await readdir(d); } catch { return; }
    for (const name of entries) {
      if (name.startsWith(".")) continue;
      const full = join(d, name);
      let st;
      try { st = await stat(full); } catch { continue; }
      if (st.isDirectory()) { await walkDir(full); continue; }
      if (name.endsWith(".ts")) out.push(full);
    }
  }
  await walkDir(dir);
  return out;
}

/** Extract every `import ... from "<spec>"` and `import("<spec>")` specifier
 *  from a source file. String-level; doesn't try to parse TS. Good enough to
 *  spot the `#sub/<Foo>/...` shape and the relative-path shape. */
function extractImportSpecifiers(src: string): string[] {
  const out: string[] = [];
  // static: import ... from "X"  (and  export ... from "X")
  const staticRe = /\b(?:import|export)\b[^'"`;]*?\bfrom\s*["']([^"']+)["']/g;
  // side-effect: import "X"
  const sideRe = /\bimport\s*["']([^"']+)["']/g;
  // dynamic: import("X")
  const dynRe = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const re of [staticRe, sideRe, dynRe]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) out.push(m[1]);
  }
  return out;
}

async function collectStaleUses(rootDir: string, root: SpecNode, report: DriftReport): Promise<void> {
  const elaborated = indexElaborated(root);

  await visit(root, async (node) => {
    if (!node.spec.uses || node.spec.uses.length === 0) return;
    const libDir = join(node.diskPath, "system/library");
    const tsFiles = await listTsFiles(libDir);
    const fromRel = relative(rootDir, node.diskPath) || ".";

    for (const ref of node.spec.uses) {
      // Match the verifier's resolution: last dotted segment is the target name.
      const target = ref.split(".").pop()!;
      const targetNode = elaborated.get(target);

      // Tolerance: schematic (unmaterialized) targets are exempt. There's no
      // library to import from yet, and the declaration is forward-looking.
      if (!targetNode) continue;

      const targetLibAbs = join(targetNode.diskPath, "system/library");

      let hardMatch = false;
      let softMatch = false;
      for (const file of tsFiles) {
        let src: string;
        try { src = await readFile(file, "utf8"); } catch { continue; }
        for (const spec of extractImportSpecifiers(src)) {
          // Canonical alias — hard pass. Match exact `#sub/<Target>/...`
          // to avoid `#sub/Foo` matching `#sub/FooBar/...`.
          if (spec === `#sub/${target}` || spec.startsWith(`#sub/${target}/`)) {
            hardMatch = true;
            break;
          }
          // Relative path — resolve against the importing file's dir and
          // see if it lands inside the target's library. Soft pass.
          if (spec.startsWith(".")) {
            const resolved = join(dirname(file), spec);
            if (resolved === targetLibAbs || resolved.startsWith(targetLibAbs + "/")) {
              softMatch = true;
              // keep scanning — a hard match elsewhere would still win
            }
          }
        }
        if (hardMatch) break;
      }

      if (hardMatch) continue;
      if (softMatch) {
        // Pre-existing relative-path imports are a soft pass for now: the
        // edge IS wired up, just not via the canonical alias. Flag with a
        // migration note so the catalogue still records the rot signal,
        // but the message tells the user what to do.
        report.staleUses.push({
          from: fromRel,
          declares: ref,
          suggestion: `library imports ${target} via a relative path — migrate to "#sub/${target}/system/library/..." for the canonical alias`,
        });
        continue;
      }

      // No import found at all — fully stale.
      report.staleUses.push({
        from: fromRel,
        declares: ref,
        suggestion: `no library file imports from ${target} — add \`import ... from "#sub/${target}/system/library/..."\` or remove \`uses { ${ref} }\` from the spec`,
      });
    }
  });
}

// ── Pass 6 helpers ────────────────────────────────────────────────────────
//
// `system/package.json.imports` is the source of truth for #<alias>/ subpath
// imports. Walk every *.ts under system/library/**, extract import specifiers
// starting with `#`, and flag any whose alias prefix isn't declared. This
// catches: typos (#runtime/, #sub-asm/), stale aliases left behind after a
// rename, and library files imported from contexts where the wrong package.json
// is closest. Cheap regex pass — no module-resolution emulation.

async function collectUnresolvedAliases(rootDir: string, report: DriftReport): Promise<void> {
  // Read the canonical map. If system/package.json is missing or unparseable,
  // skip this pass silently — a fresh seed without it isn't drift, it's just
  // pre-seed. (init.ts always writes this file.)
  let declared: Set<string>;
  try {
    const raw = await readFile(join(rootDir, "system/package.json"), "utf8");
    const pkg = JSON.parse(raw) as { imports?: Record<string, string> };
    if (!pkg.imports) return;
    // Keys look like "#ua/*" or "#ua"; strip "/*" and the leading "#".
    declared = new Set(Object.keys(pkg.imports).map(k => k.replace(/\/\*$/, "")));
  } catch { return; }

  const libRoot = join(rootDir, "system/library");
  const files = await listTsFiles(libRoot);
  for (const file of files) {
    // Skip vendored almanac TEMPLATES — they're emitted into other projects
    // where the alias map is identical, so they're correctly aliased there.
    // But we DO scan them here as a sanity check: if a template imports an
    // alias we don't ship, every materialized copy will break.
    //
    // Skip test/ files. Their fixtures build synthetic source via template
    // literals that contain fake-alias import statements to exercise this
    // very scanner; the regex-based extractor can't tell a real import from
    // a string-quoted one. Proper fix is tokenization in
    // extractImportSpecifiers; this is the band-aid until then.
    if (file.includes("/test/") || file.endsWith("/test.ts")) continue;
    let src: string;
    try { src = await readFile(file, "utf8"); } catch { continue; }
    for (const spec of extractImportSpecifiers(src)) {
      if (!spec.startsWith("#")) continue;
      // Alias name is everything up to the first "/" (or whole string).
      const slash = spec.indexOf("/");
      const alias = slash === -1 ? spec : spec.slice(0, slash);
      if (declared.has(alias)) continue;
      report.unresolvedAliases.push({
        from: relative(rootDir, file),
        specifier: spec,
        alias,
      });
    }
  }
}

/** Extract `name { ... }` blocks from a spec, returning the body of each
 *  match. Handles nested braces by counting depth. Cheap, single-pass. */
function extractBracedBlocks(src: string, names: string[]): Array<{ name: string; body: string }> {
  const out: Array<{ name: string; body: string }> = [];
  for (const name of names) {
    const re = new RegExp(`\\b${name}\\s*\\{`, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      const start = m.index + m[0].length;
      let depth = 1;
      let i = start;
      while (i < src.length && depth > 0) {
        const c = src[i];
        if (c === "{") depth++;
        else if (c === "}") depth--;
        if (depth === 0) break;
        i++;
      }
      if (depth === 0) out.push({ name, body: src.slice(start, i) });
    }
  }
  return out;
}

const ARTIFACT_DIRS = ["build", "dist", ".svelte-kit", ".vite", "out", "node_modules", "coverage"];
function isArtifactPath(relPath: string): boolean {
  return relPath.split("/").some(seg => ARTIFACT_DIRS.includes(seg));
}

async function visit(node: SpecNode, fn: (n: SpecNode) => Promise<void>): Promise<void> {
  await fn(node);
  for (const sub of node.subassemblies) {
    if (!("schematic" in sub)) await visit(sub as SpecNode, fn);
  }
}

function printHuman(r: DriftReport): void {
  // Convention: data → stdout, diagnostics → stderr. The drift report is
  // diagnostic (a human is reading "what's wrong"); the structured exit
  // code is the machine-readable signal. JSON mode (--json) is data and
  // continues to go to stdout via the caller. Surfaced by tool-tests:
  // test/drift.ts test 11 was tolerantly written because asserting strict
  // stderr would have failed before this fix.
  const out = process.stderr;
  if (
    r.totals.missing === 0 &&
    r.totals.unreferenced === 0 &&
    r.totals.orphan === 0 &&
    r.totals.crossRefs === 0 &&
    r.totals.staleUses === 0 &&
    r.totals.unresolvedAliases === 0
  ) {
    out.write("No drift detected. Catalogue matches reality.\n");
    return;
  }
  out.write("Drift report\n");
  out.write("============\n\n");
  if (r.missingFiles.length > 0) {
    out.write(`Missing — specs claim these files but they aren't on disk (${r.missingFiles.length}):\n`);
    for (const m of r.missingFiles) {
      out.write(`  ${m.subassembly} (${m.specPath}): ${m.predicate}\n`);
    }
    out.write("\n");
  }
  if (r.unreferencedFiles.length > 0) {
    out.write(`Unreferenced — files exist under tracked dirs but no spec mentions them (${r.unreferencedFiles.length}):\n`);
    for (const u of r.unreferencedFiles) {
      out.write(`  ${u.path}  (under ${u.under})\n`);
    }
    out.write("\n");
  }
  if (r.orphanDirs.length > 0) {
    out.write(`Orphan subassembly dirs — folder exists but not declared in parent (${r.orphanDirs.length}):\n`);
    for (const o of r.orphanDirs) {
      out.write(`  ${o.path}  (parent: ${o.parent})\n`);
    }
    out.write("\n");
  }
  if (r.crossReferences.length > 0) {
    out.write(`Cross-reference drift — prose names a pattern the almanac no longer has (${r.crossReferences.length}):\n`);
    for (const c of r.crossReferences) {
      out.write(`  ${c.from} -> ${c.references}  (${c.kind})\n`);
    }
    out.write("\n");
  }
  if (r.staleUses.length > 0) {
    out.write(`Stale uses — \`uses\` declared but no library file imports from the target (${r.staleUses.length}):\n`);
    for (const s of r.staleUses) {
      out.write(`  ${s.from} declares ${s.declares}\n`);
      out.write(`    → ${s.suggestion}\n`);
    }
    out.write("\n");
  }
  if (r.unresolvedAliases.length > 0) {
    out.write(`Unresolved aliases — source imports a #<alias>/ that system/package.json.imports does not declare (${r.unresolvedAliases.length}):\n`);
    for (const u of r.unresolvedAliases) {
      out.write(`  ${u.from}: import "${u.specifier}"  (alias ${u.alias} not in imports)\n`);
    }
    out.write("\n");
  }
  out.write(`DRIFT: missing=${r.totals.missing} unreferenced=${r.totals.unreferenced} orphan=${r.totals.orphan} crossRefs=${r.totals.crossRefs} staleUses=${r.totals.staleUses} unresolvedAliases=${r.totals.unresolvedAliases}\n`);
}

// CLI entrypoint
// Direct-invocation guard. realpathSync BOTH sides: on macOS /tmp is a
// symlink to /private/tmp, and a raw href comparison silently never matches
// — the CLI exits 0 having done nothing (cold-start probe, 2026-06-10).
if ((() => {
  try {
    const a = process.argv[1];
    if (!a) return false;
    return realpathSync(a) === realpathSync(fileURLToPath(import.meta.url));
  } catch { return false; }
})()) {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  const atIdx = args.indexOf("--at");
  if (atIdx >= 0 && !args[atIdx + 1]) {
    process.stderr.write("drift: --at requires a path argument\n");
    process.exit(2);
  }
  const at = atIdx >= 0 ? args[atIdx + 1] : undefined;
  const known = new Set(["--at", "--json", "--help", "-h"]);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--at") { i++; continue; }
    if (!known.has(a)) {
      process.stderr.write(`drift: unknown argument: ${a}\n${HELP}`);
      process.exit(2);
    }
  }
  const code = await drift({ at, json: args.includes("--json") });
  process.exit(code);
}
