/**
 * dictionary.ts — the project's normative glossary.
 *
 * A dictionary entry is a WORD with commitments: a ~10-30 line markdown file
 * at <project>/dictionary/<Word>.md. The model already owns the encyclopedia
 * (it can one-shot any implementation); the project needs only the idiolect —
 * WHICH variant this project means by the word, and what claims anything
 * called by that word must satisfy.
 *
 * Format:
 *
 *     # <Word>
 *     means: <one line — what the word denotes; leans on the model's prior>
 *     here: <pinned choices for THIS project: stack, file names, shapes, env>
 *
 *     ## claims
 *     - <works-when predicate line; may use {NAME}/{PORT}-style variables>
 *
 *     ## not
 *     - <disambiguation: when NOT to use this word; what to use instead>
 *
 *     ## traps
 *     - <project-discovered gotchas, accumulating prose>
 *
 * Only `means:` is required. Claims attach to any subassembly that declares
 * `conforms to <Word>` in its works-when block (see primitives.ts) — so a
 * dictionary edit propagates to every instance on the next verify, which is
 * semantic drift-detection: conformance to the CURRENT definition, not a
 * byte-diff against template code that rots.
 *
 * Empirical drivers (2026-06, three days of bake-offs):
 *   - every convergence leak measured was vocabulary-shaped, not code-shaped
 *   - shipped skeleton code rotted within hours (R6 template drift); prose
 *     commitments did not
 *   - real teams build exactly this layer by hand (.agents/skills/) and
 *     nothing verifies it; here the claims block is executable
 *
 * CLI:
 *   node system/library/dictionary.ts list
 *   node system/library/dictionary.ts show <Word>
 */

import { readFile, readdir } from "node:fs/promises";
import { join, basename } from "node:path";

export interface DictEntry {
  word: string;
  means: string;
  here?: string;
  claims: string[];
  not: string[];
  traps: string[];
  /** Source path the entry was read from. */
  path: string;
}

/** Locate the project's dictionary directory. Convention: <root>/dictionary. */
export function dictionaryDir(projectRoot: string): string {
  return join(projectRoot, "dictionary");
}

/** Parse one entry file. Throws with a precise message on format errors. */
export function parseEntry(source: string, path: string): DictEntry {
  const lines = source.split("\n");
  let word = "";
  let means = "";
  let here: string | undefined;
  const sections: Record<string, string[]> = { claims: [], not: [], traps: [] };
  let current: string | null = null;

  for (const raw of lines) {
    const line = raw.trimEnd();
    const h1 = /^#\s+(\S.*)$/.exec(line);
    if (h1 && !word) { word = h1[1].trim(); continue; }
    const h2 = /^##\s+(\w+)/.exec(line);
    if (h2) {
      const name = h2[1].toLowerCase();
      current = name in sections ? name : null;
      continue;
    }
    const meansMatch = /^means:\s*(.+)$/.exec(line);
    if (meansMatch && !current) { means = meansMatch[1].trim(); continue; }
    const hereMatch = /^here:\s*(.+)$/.exec(line);
    if (hereMatch && !current) { here = hereMatch[1].trim(); continue; }
    // Continuation lines for here: (indented prose before any section)
    if (!current && here !== undefined && /^\s{2,}\S/.test(line) && !line.startsWith("#")) {
      here += " " + line.trim();
      continue;
    }
    if (current && /^-\s+/.test(line.trim())) {
      sections[current].push(line.trim().replace(/^-\s+/, ""));
    }
  }

  if (!word) throw new Error(`${path}: no "# <Word>" heading`);
  if (!means) throw new Error(`${path}: missing required "means:" line`);
  return { word, means, here, claims: sections.claims, not: sections.not, traps: sections.traps, path };
}

/** Read one word's entry from the project dictionary. Null if absent. */
export async function getEntry(projectRoot: string, word: string): Promise<DictEntry | null> {
  const p = join(dictionaryDir(projectRoot), `${word}.md`);
  try {
    const src = await readFile(p, "utf8");
    return parseEntry(src, p);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

/** List all words with entries in the project dictionary. */
export async function listWords(projectRoot: string): Promise<string[]> {
  try {
    const entries = await readdir(dictionaryDir(projectRoot));
    return entries
      .filter(f => f.endsWith(".md") && !f.startsWith("README"))
      .map(f => basename(f, ".md"))
      .sort();
  } catch {
    return [];
  }
}

/** Substitute {VAR}-style placeholders in a claim line. */
export function substituteClaim(claim: string, vars: Record<string, string>): string {
  return claim.replace(/\{([A-Z_]+)\}/g, (m, key) => vars[key] ?? m);
}

// ── CLI ────────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const [cmd, arg] = process.argv.slice(2);
  const root = process.cwd();
  if (cmd === "list") {
    const words = await listWords(root);
    if (words.length === 0) {
      process.stderr.write("dictionary: empty — define entries from built code: `node system/library/define.ts <Subassembly>`\n");
      return 0;
    }
    for (const w of words) {
      const e = await getEntry(root, w);
      process.stdout.write(`${w.padEnd(24)} ${e?.means ?? ""}\n`);
    }
    return 0;
  }
  if (cmd === "show" && arg) {
    const e = await getEntry(root, arg);
    if (!e) {
      process.stderr.write(`dictionary: no entry for "${arg}"\n`);
      return 1;
    }
    process.stdout.write(await readFile(e.path, "utf8"));
    return 0;
  }
  process.stderr.write("usage: dictionary.ts list | show <Word>\n");
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
