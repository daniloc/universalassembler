/**
 * upgrade.ts — pull canonical UA core into this vendored project.
 *
 * Run from the project root:
 *
 *   node system/library/upgrade.ts            # dry-run: show what would change
 *   node system/library/upgrade.ts --apply    # commit the changes
 *   node system/library/upgrade.ts --force    # apply even to LOCAL FORK files
 *
 * Vendor-by-default model: every UA project owns a copy of the core library.
 * Updates flow from a canonical source via this verb, never silently. The
 * verb is itself vendored — it can upgrade itself the same way it upgrades
 * the rest.
 *
 * ## Local forks
 *
 * If you've edited a vendored file (e.g. added a project-specific primitive
 * to primitives.ts), mark the file as a fork by including
 *
 *     // LOCAL FORK — do not auto-upgrade
 *
 * anywhere in its first 10 lines. Upgrade will skip it. Use `--force` if you
 * want to overwrite anyway (and re-apply your edits afterwards).
 *
 * ## Output
 *
 * Structured summary the agent can read: updated / added / unchanged / forked
 * counts, with each affected file listed. Designed to be parsed or
 * eyeballed equally well.
 */

import { readFile, writeFile, readdir, stat, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Where canonical UA lives. Resolution order:
//   1. UA_CANONICAL env var (point it at a checkout's system/library)
//   2. a `.ua-canonical` file at the project root (one line: the path)
//   3. error — a vendored copy cannot guess where canon lives.
// In the canonical repo itself, set neither: upgrade is a no-op there.
import { readFileSync, existsSync, realpathSync } from "node:fs";
function resolveCanonical(): string {
  if (process.env.UA_CANONICAL) return process.env.UA_CANONICAL;
  const marker = join(process.cwd(), ".ua-canonical");
  if (existsSync(marker)) return readFileSync(marker, "utf8").trim();
  process.stderr.write(
    "upgrade: cannot locate canonical UA. Set UA_CANONICAL=<path-to-checkout>/system/library\n" +
    "or write that path into a .ua-canonical file at the project root.\n",
  );
  process.exit(2);
}
const CANONICAL = resolveCanonical();

const HELP = `Usage: upgrade.ts [--apply] [--force] [--help]

Pull canonical UA core into this project. Dry-run by default.

  --apply   commit the changes locally (writes files)
  --force   overwrite even files marked // LOCAL FORK
  --help    show this message and exit 0

Mark a vendored file as a local fork by including
\`// LOCAL FORK — do not auto-upgrade\` in its first ~200 chars.
Upgrade then skips it unless --force is set.
`;

const LOCAL = dirname(fileURLToPath(import.meta.url));

// Files NEVER vendored (UA-internal): init bootstraps fresh projects, test
// exercises UA's own internals. Don't ship these to derived projects.
const NEVER_VENDORED = new Set(["init.ts", "test.ts"]);

// Legacy: pre-dictionary projects vendored an almanac/ subtree. Canonical no
// longer ships one (walkRel returns [] and the loop skips), so a legacy
// project's vendored patterns are left untouched — their copy, their call.
// The dictionary flow replaces this. We walk it recursively and emit
// relative paths so each file shows up in the report next to top-level core
// files — `↻ almanac/MCPServer/library/server.ts`, etc.
async function walkRel(base: string, sub = ""): Promise<string[]> {
  const here = sub ? join(base, sub) : base;
  let entries: string[];
  try { entries = await readdir(here); }
  catch { return []; }
  const out: string[] = [];
  for (const name of entries) {
    const rel = sub ? join(sub, name) : name;
    const st = await stat(join(base, rel));
    if (st.isDirectory()) out.push(...await walkRel(base, rel));
    else out.push(rel);
  }
  return out;
}
interface Outcome {
  file: string;
  status: "updated" | "added" | "unchanged" | "forked";
  reason?: string;
}

export default async function upgrade(opts: { apply?: boolean; force?: boolean } = {}): Promise<number> {
  const apply = opts.apply ?? false;
  const force = opts.force ?? false;

  if (LOCAL === CANONICAL) {
    process.stderr.write("error: cannot upgrade UA reference repo from itself\n");
    process.stderr.write(`  local:     ${LOCAL}\n`);
    process.stderr.write(`  canonical: ${CANONICAL}\n`);
    return 2;
  }

  try { await stat(CANONICAL); } catch {
    process.stderr.write(`error: canonical source not found at ${CANONICAL}\n`);
    process.stderr.write(`edit CANONICAL in upgrade.ts to point at your reference UA copy\n`);
    return 2;
  }

  const canonicalEntries = await readdir(CANONICAL);
  const canonicalFiles = canonicalEntries
    .filter(f => f.endsWith(".ts"))
    .filter(f => !NEVER_VENDORED.has(f));

  const almanacFiles = (await walkRel(join(CANONICAL, "almanac")))
    .map(f => join("almanac", f));
  const hookFiles = (await walkRel(join(CANONICAL, "hooks")))
    .map(f => join("hooks", f));
  const allFiles = [...canonicalFiles, ...almanacFiles, ...hookFiles];

  const outcomes: Outcome[] = [];

  for (const file of allFiles) {
    const canonicalPath = join(CANONICAL, file);
    const localPath = join(LOCAL, file);
    const canonicalContent = await readFile(canonicalPath, "utf8");

    let localContent: string | null = null;
    try { localContent = await readFile(localPath, "utf8"); } catch { /* not present locally */ }

    if (localContent === null) {
      outcomes.push({ file, status: "added" });
      if (apply) {
        await mkdir(dirname(localPath), { recursive: true });
        await writeFile(localPath, canonicalContent);
      }
      continue;
    }

    if (localContent === canonicalContent) {
      outcomes.push({ file, status: "unchanged" });
      continue;
    }

    // Check for LOCAL FORK marker in the first ~200 chars (covers comment headers).
    const header = localContent.slice(0, 200);
    if (header.includes("LOCAL FORK") && !force) {
      outcomes.push({ file, status: "forked", reason: "marked as local fork — use --force to override" });
      continue;
    }

    outcomes.push({ file, status: "updated" });
    if (apply) await writeFile(localPath, canonicalContent);
  }

  // Report. Human-readable diagnostics → stderr; structured tail → stdout for greppability.
  const grouped = {
    added: outcomes.filter(o => o.status === "added"),
    updated: outcomes.filter(o => o.status === "updated"),
    forked: outcomes.filter(o => o.status === "forked"),
    unchanged: outcomes.filter(o => o.status === "unchanged"),
  };

  const action = apply ? "Applied" : "Dry run";
  process.stderr.write(`\n${action} — UA core upgrade from ${CANONICAL}\n\n`);

  if (grouped.added.length) {
    process.stderr.write(`Added (${grouped.added.length}):\n`);
    for (const o of grouped.added) process.stderr.write(`  + ${o.file}\n`);
  }
  if (grouped.updated.length) {
    process.stderr.write(`Updated (${grouped.updated.length}):\n`);
    for (const o of grouped.updated) process.stderr.write(`  ↻ ${o.file}\n`);
  }
  if (grouped.forked.length) {
    process.stderr.write(`Skipped — local fork (${grouped.forked.length}):\n`);
    for (const o of grouped.forked) process.stderr.write(`  ✗ ${o.file}  (${o.reason})\n`);
  }
  process.stderr.write(`Unchanged: ${grouped.unchanged.length}\n\n`);

  const wouldChange = grouped.added.length + grouped.updated.length;
  if (!apply && wouldChange > 0) {
    process.stderr.write(`Run \`node system/library/upgrade.ts --apply\` to commit these ${wouldChange} change(s).\n\n`);
  } else if (apply && wouldChange > 0) {
    process.stderr.write(`Re-run \`node system/library/bootstrap.ts\` to verify the upgrade.\n\n`);
  } else if (!apply) {
    process.stderr.write(`Everything already current. Nothing to apply.\n\n`);
  }

  // Structured tail on stdout — agents grep this.
  process.stdout.write(`UPGRADE: added=${grouped.added.length} updated=${grouped.updated.length} forked=${grouped.forked.length} unchanged=${grouped.unchanged.length}\n`);

  return 0;
}

// CLI entrypoint — only runs when invoked as a script, not when imported.
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
  if (args.includes("--help")) { process.stderr.write(HELP); process.exit(0); }
  const code = await upgrade({ apply: args.includes("--apply"), force: args.includes("--force") });
  process.exit(code);
}
