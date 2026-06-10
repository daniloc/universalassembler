/**
 * install.ts — install UA's git hooks into the local .git/hooks/.
 *
 *   node system/library/hooks/install.ts [--force]
 *
 * Copies every file from system/library/hooks/ (except this script) into
 * .git/hooks/ and chmod +x's them. Idempotent. By default refuses to
 * overwrite an existing hook of the same name; pass --force to override.
 *
 * Called automatically by `init.ts` when seeding a fresh project (if a
 * .git/ exists). For projects that vendored UA before the hooks shipped,
 * run this manually after `upgrade.ts --apply`.
 *
 * Exit codes: 0 success, 1 runtime failure, 2 usage error.
 */

import { readdir, readFile, writeFile, stat, chmod, mkdir } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, basename } from "node:path";
import { execFileSync } from "node:child_process";

const HOOKS_SRC = dirname(fileURLToPath(import.meta.url));
const SCRIPT_FILES = new Set(["install.ts"]);

const HELP = `Usage: install.ts [--force] [--help]

Install UA's git hooks into the local repo's .git/hooks/.

  --force   overwrite existing hooks with the same name
  --help    show this message and exit 0
`;

interface InstallOpts { force?: boolean; }

export default async function install(opts: InstallOpts = {}): Promise<number> {
  const force = opts.force ?? false;

  // Find the git dir. Use --git-common-dir, not --git-dir: for git worktrees,
  // `--git-dir` returns the worktree-specific .git/worktrees/<name>/ which
  // doesn't have a hooks/ subdir by default. `--git-common-dir` returns the
  // shared .git/ where hooks actually live and run from for all worktrees.
  let gitDir: string;
  try {
    gitDir = execFileSync("git", ["rev-parse", "--git-common-dir"], { encoding: "utf8" }).trim();
  } catch {
    process.stderr.write("error: not inside a git repository (try `git init` first)\n");
    return 1;
  }

  const hooksDir = join(gitDir, "hooks");
  // Make sure the hooks dir exists — fresh repos and some worktree
  // configurations don't auto-create it.
  await mkdir(hooksDir, { recursive: true });
  const entries = await readdir(HOOKS_SRC);
  const installable = entries.filter(e => !SCRIPT_FILES.has(e) && !e.endsWith(".md") && !e.endsWith(".ts"));

  let installed = 0, skipped = 0;
  for (const name of installable) {
    const src = join(HOOKS_SRC, name);
    const dst = join(hooksDir, name);
    let existing: string | null = null;
    try { existing = await readFile(dst, "utf8"); } catch { /* doesn't exist */ }
    const incoming = await readFile(src, "utf8");
    if (existing !== null && existing !== incoming && !force) {
      process.stderr.write(`skip ${name} (already present, differs — pass --force to overwrite)\n`);
      skipped++;
      continue;
    }
    if (existing === incoming) {
      skipped++;
      continue;
    }
    await writeFile(dst, incoming);
    await chmod(dst, 0o755);
    process.stderr.write(`installed ${name} → ${dst}\n`);
    installed++;
  }

  process.stderr.write(`\n${installed} installed, ${skipped} unchanged/skipped\n`);
  process.stdout.write(hooksDir + "\n");
  return 0;
}

// CLI entrypoint — only runs when invoked as a script.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2);
  if (args.includes("--help")) { process.stderr.write(HELP); process.exit(0); }
  const code = await install({ force: args.includes("--force") });
  process.exit(code);
}
