/**
 * define.ts — define a dictionary word from a built subassembly.
 *
 *   node system/library/define.ts <SubassemblyName> [--word <Word>]
 *
 * The verb pair: `define` compresses (built instance -> named definition);
 * `new` expands (word -> materialized contract). Patterns are GROWN from
 * the project's own code, then enforced — never imported from a shipped
 * canon. Build a subassembly on bare lattice; when it recurs, define it as
 * a word with commitments. From then on it's an attractor: `new <Word>`
 * materializes the contract, and `conforms to <Word>` keeps every instance
 * honest against the CURRENT definition.
 *
 * What define distills (mechanically — the agent refines the prose):
 *   means  <- the spec's `is` clause
 *   here   <- the library files + their exported surfaces (one line)
 *   claims <- the node's works-when lines, generalized: the node's own name
 *             becomes {NAME}; a port in LINEAGE variables becomes {PORT}
 *   traps  <- seeded empty with a prompt comment
 *
 * Output: dictionary/<Word>.md (refuses to overwrite without --force).
 */

import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { walk, type SpecNode } from "./walker.ts";
import { dictionaryDir } from "./dictionary.ts";
import { growthGate } from "./debt.ts";

function findNode(root: SpecNode, name: string): SpecNode | null {
  if (root.spec.name === name) return root;
  for (const s of root.subassemblies) {
    if ("schematic" in s) continue;
    const hit = findNode(s as SpecNode, name);
    if (hit) return hit;
  }
  return null;
}

/** Generalize a works-when line into a claim: node-specifics become {VARS}. */
function generalizeClaim(line: string, nodeName: string, vars: Record<string, string>): string {
  let claim = line;
  // The node's own name (path segments, identifiers) -> {NAME}
  claim = claim.replaceAll(nodeName, "{NAME}");
  // Known variable values -> their {KEY}
  for (const [k, v] of Object.entries(vars)) {
    if (v && v.length >= 2 && claim.includes(v)) claim = claim.replaceAll(v, `{${k}}`);
  }
  return claim;
}

async function exportSurface(libDir: string): Promise<string[]> {
  const lines: string[] = [];
  let files: string[] = [];
  try { files = (await readdir(libDir)).filter(f => f.endsWith(".ts")); } catch { return lines; }
  for (const f of files.sort()) {
    try {
      const src = await readFile(join(libDir, f), "utf8");
      const exports = [...src.matchAll(/^export\s+(?:async\s+)?(?:function|const|class)\s+([A-Za-z_][A-Za-z0-9_]*)/gm)]
        .map(m => m[1]);
      lines.push(`${f}${exports.length ? ` (exports ${exports.join(", ")})` : ""}`);
    } catch { lines.push(f); }
  }
  return lines;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const subName = args.find(a => !a.startsWith("--"));
  if (!subName) {
    process.stderr.write("usage: define.ts <SubassemblyName> [--word <Word>] [--force]\n");
    return 2;
  }
  const wordFlagIdx = args.indexOf("--word");
  const word = wordFlagIdx >= 0 ? args[wordFlagIdx + 1] : subName;
  const force = args.includes("--force");
  const projectRoot = process.cwd();

  // The governor: defining a word is growth; growth is rationed to green.
  // (--force here covers both the gate and entry overwrite.)
  const gate = await growthGate(projectRoot, { force, action: `define ${subName}` });
  if (!gate.allowed) return 1;

  const root = await walk(projectRoot);
  const node = findNode(root, subName);
  if (!node) {
    process.stderr.write(`define: no subassembly named "${subName}" in the tree\n`);
    return 1;
  }

  const outPath = join(dictionaryDir(projectRoot), `${word}.md`);
  try {
    await stat(outPath);
    if (!force) {
      process.stderr.write(`define: ${outPath} already exists — refine it in place, or pass --force to redefine\n`);
      return 1;
    }
  } catch { /* fresh */ }

  const vars = node.spec.lineage?.variables ?? {};
  const claims = (node.spec.worksWhen ?? [])
    .map(l => generalizeClaim(l, node.spec.name, vars))
    .filter(c => !/^conforms\s+to\s+/.test(c));  // don't define a word in terms of itself
  const surface = await exportSurface(join(node.diskPath, "system", "library"));

  const entry = `# ${word}

means: ${node.spec.is ?? "(describe what this word denotes)"}
here: ${surface.length ? surface.join("; ") : "(pin this project's choices: stack, shapes, env)"}

## claims
${claims.length ? claims.map(c => `- ${c}`).join("\n") : "- (add works-when lines anything called a " + word + " must satisfy)"}

## not
- (when NOT to use this word; what to use instead)

## traps
- (project-discovered gotchas accumulate here)
`;

  await mkdir(dictionaryDir(projectRoot), { recursive: true });
  await writeFile(outPath, entry);
  process.stdout.write(`${outPath}\n`);
  process.stderr.write(
    `defined ${subName} -> ${word}. Refine means/here, prune claims to the\n` +
    `essential contract, fill not/traps. Then instances declare\n` +
    `"conforms to ${word}" and \`new ${word} <Name>\` materializes the contract.\n`,
  );
  return 0;
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
