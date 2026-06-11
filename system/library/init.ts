/**
 * init.ts — seed a new UA-shaped project.
 *
 * Alias map: SINGLE SOURCE OF TRUTH lives in `system/package.json.imports`.
 * The canonical set is `#ua/*` → `./library/*` and `#sub/*` → `./subassemblies/*`
 * (paths relative to `system/`). Every other declaration site in a seeded project
 * — root package.json, tsconfig paths, this file's emitted JSON — MIRRORS that
 * map. If you need to add a new alias, change `system/package.json` first, then
 * propagate. drift.ts flags any `#<alias>/` import in library source that the
 * map does not declare.
 *
 * The one-liner an agent runs to bootstrap a fresh project with UA's container
 * shape (filesystem fractal + core library + root spec + package.json + tsconfig).
 *
 * Usage:
 *
 *   node /path/to/UniversalAssembler/system/library/init.ts <ProjectName> [--here]
 *
 * Without --here: creates ./ProjectName/ in the current directory.
 * With --here:    seeds into the current directory (must be empty or have only
 *                 a .git/ — refuses if other files present, to prevent stomping).
 *
 * What it does:
 *  1. Creates the fractal: system/library/, system/subassemblies/
 *  2. Vendors UA core library (parser, walker, primitives, verify, bootstrap,
 *     derive, define) — the engine modules
 *  3. Writes <ProjectName>.spec with the canonical works-when block
 *  4. Writes package.json with the #ua/* alias
 *  5. Writes tsconfig.json with matching path mappings
 *  6. Prints next steps
 *
 * After this: `cd <ProjectName> && node system/library/bootstrap.ts` brings the
 * empty project up green. Then elaborate the frontier — add subassemblies.
 */

import { copyFile, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";
import { execSync } from "node:child_process";

const HELP = `Usage: init.ts <ProjectName> [--here] [--catalogue] [--help]

Seed a fresh UA-shaped project: filesystem fractal + core library +
root spec + package.json + tsconfig.

  <ProjectName>  PascalCase (defaults to current directory's name with
                 --here or --catalogue)
  --here         seed into the current directory (must be empty or
                 contain only .git/)
  --catalogue    Catalogue install — vendor system/library + write a root
                 spec only. Refuses to clobber existing files but is
                 OK with a non-empty dir. Skips package.json/tsconfig
                 if they already exist (the whole point: drop UA into
                 an existing project).
  --help         show this message and exit 0

Without --here, creates ./<ProjectName>/ under the current directory.
Without --catalogue, the full fractal layout is seeded.
`;

interface InitOpts { name: string; here?: boolean; catalogue?: boolean; }

export default async function init(opts: InitOpts): Promise<number> {
  const { name: projectName, here = false, catalogue = false } = opts;
  if (!projectName || !/^[A-Z][A-Za-z0-9]*$/.test(projectName)) {
    process.stderr.write(`error: project name must start with an uppercase letter and contain only [A-Za-z0-9]\n`);
    process.stderr.write(`got: ${projectName || "(empty)"}\n`);
    return 2;
  }

  const targetDir = here || catalogue ? process.cwd() : join(process.cwd(), projectName);

  // Refuse to clobber. --here requires an effectively empty dir; --catalogue
  // explicitly does NOT — it's meant to drop UA into an existing project. But
  // even in catalogue mode we refuse to overwrite specific files (root spec,
  // any pre-existing vendor at system/library) so we never destroy work.
  if (here && !catalogue) {
    const entries = (await readdir(targetDir)).filter(e => e !== ".git" && e !== ".DS_Store");
    if (entries.length > 0) {
      process.stderr.write(`error: --here requires an empty directory (or one with only .git/)\n`);
      process.stderr.write(`found: ${entries.join(", ")}\n`);
      return 2;
    }
  }
  if (catalogue) {
    // Catalogue mode refuses to clobber these specific files. Anything else in
    // the dir is fine — the user has a real project there.
    const specFile = join(targetDir, `${projectName}.spec`);
    const existingLib = join(targetDir, "system", "library");
    const conflicts: string[] = [];
    if (await pathExists(specFile)) conflicts.push(`${projectName}.spec`);
    if (await pathExists(existingLib)) conflicts.push("system/library/");
    if (conflicts.length > 0) {
      process.stderr.write(`error: --catalogue refuses to clobber existing UA artifacts: ${conflicts.join(", ")}\n`);
      process.stderr.write(`run \`node ${join(targetDir, "system/library/upgrade.ts")}\` to refresh vendored files instead.\n`);
      return 2;
    }
  }

  // Find where UA core lives — this file IS in system/library/, so two levels up is UA root.
  const UA_LIB = dirname(fileURLToPath(import.meta.url));

  await mkdir(join(targetDir, "system", "library"), { recursive: true });
  // The fractal layout (system/subassemblies/) is fractal-mode only. In catalogue
  // mode the user catalogues paths that already live elsewhere; no fractal dir.
  if (!catalogue) {
    await mkdir(join(targetDir, "system", "subassemblies"), { recursive: true });
  }

  // The project dictionary — born empty, grown by define.ts (built code -> word).
  // Entries are words with commitments; `conforms to <Word>` claims hold
  // every instance to the current definition.
  await mkdir(join(targetDir, "dictionary"), { recursive: true });
  await writeFile(
    join(targetDir, "dictionary", "README.md"),
    "# Dictionary\n\nThis project's normative glossary — words with commitments.\n" +
    "Define entries from your own code: `node system/library/define.ts <Subassembly>`.\n" +
    "Materialize contracts from words: `node system/library/new.ts <Word> [<Name>]`.\n" +
    "Anything declaring `conforms to <Word>` is held to the entry's claims on every verify.\n",
  );

  // Vendor UA core. Skip test.ts (it tests UA's own internals) and this file itself.
  for (const f of CORE_FILES) {
    await copyFile(join(UA_LIB, f), join(targetDir, "system", "library", f));
  }

  // Vendor the hooks directory — pre-commit + install.ts. The hooks close
  // the verification feedback loop at the git boundary.
  await copyTree(join(UA_LIB, "hooks"), join(targetDir, "system", "library", "hooks"));

  // Root spec — the agent fills in `is` and grows subassemblies. Works-when has
  // the canonical structural checks pre-wired so the very first bootstrap shows
  // green + dialect + an empty frontier.
  //
  // Catalogue mode writes a MINIMAL works-when. The fractal-only predicates
  // (`spec.tree mirrors directory.tree`, `tests pass at every node`, `verb
  // exports are present at every node`) are deliberately absent — they'd fail
  // by design when the project's real code lives outside system/subassemblies/.
  const specFile = `${projectName}.spec`;
  const specContent = catalogue ? catalogueSpec(projectName) : fractalSpec(projectName);
  await writeFile(join(targetDir, specFile), specContent);

  // package.json — full project mode always writes it. Catalogue mode is more
  // careful: only writes one if the user has no package.json (UA-only projects
  // still benefit from the #ua/* alias). If they do, we leave it alone — never
  // overwrite the user's project metadata or scripts.
  //
  // Two package.jsons matter here:
  //   - root package.json — what the user-facing tooling sees
  //   - system/package.json — what Node sees when resolving #ua/* imports from
  //     within system/library/*.ts (it walks UP and stops at the nearest one)
  // The #ua/* alias only works if `imports` lives in the package.json closest
  // to system/library/. So we seed system/package.json with the alias; derive.ts
  // will preserve it on subsequent runs.
  const pkgPath = join(targetDir, "package.json");
  const pkgExists = await pathExists(pkgPath);
  const wrotePkg = !catalogue || !pkgExists;
  if (wrotePkg) {
    const pkgJson = {
      name: projectName.toLowerCase().replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase(),
      type: "module",
      private: true,
      imports: {
        "#ua/*": "./system/library/*",
        "#sub/*": "./system/subassemblies/*",
      },
    };
    await writeFile(pkgPath, JSON.stringify(pkgJson, null, 2) + "\n");
  }

  // Seed system/package.json with the #ua/* + #sub/* aliases (paths relative
  // to system/). This is the one Node consults when resolving imports from
  // system/library/ scripts like drift.ts AND from one subassembly to another
  // (#sub/Foo/system/library/loader.ts instead of brittle ../../../Foo paths).
  // derive.ts preserves the `imports` field by design.
  const sysPkgPath = join(targetDir, "system", "package.json");
  if (!await pathExists(sysPkgPath)) {
    await writeFile(sysPkgPath, JSON.stringify({
      type: "module",
      private: true,
      imports: {
        "#ua/*": "./library/*",
        "#sub/*": "./subassemblies/*",
      },
    }, null, 2) + "\n");
  }

  // tsconfig.json — same logic. Don't smash an existing tsconfig in catalogue
  // mode; the user already has one wired to their code. If they want the alias
  // they can copy `"#ua/*": ["./system/library/*"]` into their own paths.
  const tsPath = join(targetDir, "tsconfig.json");
  const tsExists = await pathExists(tsPath);
  if (!catalogue || !tsExists) {
    const tsConfig = {
      compilerOptions: {
        module: "nodenext",
        moduleResolution: "nodenext",
        target: "es2022",
        allowImportingTsExtensions: true,
        noEmit: true,
        strict: true,
        skipLibCheck: true,
        paths: {
          "#ua/*": ["./system/library/*"],
          "#sub/*": ["./system/subassemblies/*"],
        },
      },
      include: [specFile, "system/**/*.ts"],
    };
    await writeFile(tsPath, JSON.stringify(tsConfig, null, 2) + "\n");
  }

  // If a .git/ already lives at targetDir (or anywhere up the chain), install
  // the pre-commit hook. Fresh seeds without git just get the hooks vendored —
  // installation can happen later via `node system/library/hooks/install.ts`.
  let hookInstallNote = "";
  try {
    execSync("git rev-parse --git-dir", { cwd: targetDir, stdio: "ignore" });
    execSync(`node ${join(targetDir, "system/library/hooks/install.ts")}`, { cwd: targetDir, stdio: "ignore" });
    hookInstallNote = "  pre-commit hook installed — commits now run bootstrap automatically\n";
  } catch { /* no git here; user can install hooks later */ }

  const cdHint = here || catalogue ? "" : `cd ${projectName} && `;
  // Confirmation + next-steps → stderr (diagnostic). Final path → stdout (data).
  if (catalogue) {
    process.stderr.write(`\n✓ UA catalogue install for "${projectName}" at ${targetDir}\n`);
    process.stderr.write(`  vendored: system/library/ (parser + walker + primitives + bootstrap + hooks) + dictionary/\n`);
    process.stderr.write(`  wrote:    ${specFile}\n`);
    if (!wrotePkg) {
      process.stderr.write(`  preserved: package.json (left your existing one alone — add "#ua/*": "./system/library/*" to "imports" yourself if you want the alias)\n`);
    }
    process.stderr.write(`${hookInstallNote}\n`);
    process.stderr.write(`Catalogue mode: UA describes your existing code, no restructure required.\n`);
    process.stderr.write(`Next:\n`);
    process.stderr.write(`  ${cdHint}node system/library/bootstrap.ts  # verify the seed (catalogue mode)\n`);
    process.stderr.write(`  edit ${specFile} — fill the works-when block with predicates that name real local invariants,\n`);
    process.stderr.write(`  then add a subassemblies block declaring the services/packages this project already has.\n\n`);
    process.stderr.write(`When you want spec.tree to mirror directory.tree, re-run init without --catalogue\n`);
    process.stderr.write(`in a fresh dir to see what the full fractal looks like.\n\n`);
  } else {
    process.stderr.write(`\n✓ UA project "${projectName}" seeded at ${targetDir}\n${hookInstallNote}\n`);
    process.stderr.write(`Next:\n`);
    process.stderr.write(`  ${cdHint}node system/library/bootstrap.ts          # verify the seed brings up clean\n`);
    process.stderr.write(`  ${cdHint}node system/library/next.ts               # the path — one recommended action\n\n`);
    process.stderr.write(`The frontier lives in ${specFile} — fill the empty subassemblies block to grow.\n`);
    process.stderr.write(`Read the bootstrap output's Dialect section to know what grammar + primitives + aliases are available.\n\n`);
  }
  process.stdout.write(targetDir + "\n");
  return 0;
}

/** Full fractal root spec. Pre-wires the canonical structural checks. */
function fractalSpec(name: string): string {
  return `// Posture: this is scaffolding, not architecture. Edit any spec, add a subassembly,
// replace a verb, change the grammar. It's all just text.
//
// Deriving projects are encouraged to develop their own UA dialect — add primitives
// for your domain, extend the grammar with new blocks, rename verbs to fit your team.
// The container is canonical; the dialect is yours.
//
// To get started: node system/library/bootstrap.ts
// Brings every subassembly online, verifies the live system, prints next-step context.

spec ${name} {

  is "TODO — describe what this project is in under 140 characters."

  works when {
    *.spec                   exists at every node
    system/subassemblies     exists at every node
    system/library           exists at every node
    *.spec                   parses at every node
    spec.tree                mirrors directory.tree
    declared verbs           are present in library
    verb exports             are present at every node
    declared uses            are satisfied
    declared outputs         are present
  }

  subassemblies {
  }
}
`;
}

/** Minimal catalogue root spec. Drops fractal-only predicates. */
function catalogueSpec(name: string): string {
  return `// Catalogue install. UA describes this project on top of code that already exists;
// the fractal layout (system/subassemblies/<Name>/<Name>.spec) is NOT assumed.
// Predicates that only make sense in fractal mode (spec.tree mirrors directory.tree,
// tests pass at every node, verb exports are present at every node) are absent
// by design — add them when you move to the full fractal layout.
//
// To verify the catalogue: node system/library/bootstrap.ts

spec ${name} {

  is "TODO — describe what this project is in under 140 characters."

  works when {
    system/library           exists at root
    *.spec                   parses at root
  }

  subassemblies {
    // Declare the real services/packages/surfaces this project already has.
    // The full fractal isn't required — UA can verify each one in place
    // (point predicates at their actual locations via local works-when blocks).
  }
}
`;
}

async function pathExists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}

// Vendored files. Top-level constants so they're stable across calls and exported
// to other tooling (upgrade.ts mirrors this list implicitly via filesystem walk).
const CORE_FILES = [
  "parser.ts", "walker.ts", "primitives.ts",
  "verify.ts", "bootstrap.ts", "derive.ts", "define.ts",
  "upgrade.ts",    // every vendored project can pull canonical evolutions
  "drift.ts",      // catalogue-vs-reality reconciliation
  "dictionary.ts", // the project's normative glossary (conforms-to claims)
  "new.ts",        // materialize a contract from a word (no code copied)
  "next.ts",       // the single-action path command
  "debt.ts",       // the governor's ledger + growth gate
  "digest.ts",     // the human-metabolism change summary
  "accept.ts",     // the human attestation layer — green is not blessed
];

async function copyTree(src: string, dst: string): Promise<void> {
  let entries: string[];
  try { entries = await readdir(src); } catch { return; }
  await mkdir(dst, { recursive: true });
  for (const name of entries) {
    const s = join(src, name);
    const d = join(dst, name);
    const st = await stat(s);
    if (st.isDirectory()) await copyTree(s, d);
    else await copyFile(s, d);
  }
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
  const name = (args.find(a => !a.startsWith("--")) ?? basename(process.cwd()))
    .replace(/[^A-Za-z0-9]/g, "");
  const code = await init({
    name,
    here: args.includes("--here"),
    catalogue: args.includes("--catalogue"),
  });
  process.exit(code);
}
