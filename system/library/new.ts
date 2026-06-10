/**
 * new.ts — materialize a CONTRACT from the dictionary. No code is copied.
 *
 *   node system/library/new.ts <Word> [<Name>] [--port <n>]
 *
 * The dictionary-era replacement for `almanac add`. Where the almanac copied
 * skeleton code (which the model can one-shot anyway, and which rots), `new`
 * issues a contract:
 *
 *   - <Name>.spec with: is <- the entry's means, works when { conforms to
 *     <Word> } plus the entry's claims inlined as comments for the
 *     implementing agent, LINEAGE recording word + dialect + variables
 *   - an EMPTY system/library/ — the model writes the implementation;
 *     `next` routes there (empty library on a worded spec = "implement me")
 *
 * Verification then holds the instance to the CURRENT dictionary definition
 * forever (`conforms to <Word>` re-reads the entry on every verify), which
 * is semantic drift-detection — a dictionary edit propagates to every
 * instance as a red until they conform.
 */

import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { getEntry, listWords } from "./dictionary.ts";
import { growthGate } from "./debt.ts";
import { findSpec } from "./walker.ts";

function uaVersion(): string {
  try { return execSync("git rev-parse HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); }
  catch { return "unknown"; }
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const positional = args.filter(a => !a.startsWith("--"));

  // --bare <Name>: scaffold an empty subassembly node with no word — the
  // bare-lattice first instance. The loop is: build it bare, prove it,
  // then `define` it into a word so the next instance has a contract.
  // (Cold-start probe, 2026-06-10: there was no command for this; users
  // had to read walker.ts to learn the fractal convention.)
  if (args.includes("--bare")) {
    const bareName = positional[0];
    if (!bareName || !/^[A-Z][A-Za-z0-9]*$/.test(bareName)) {
      process.stderr.write("usage: new.ts --bare <Name>   (PascalCase)\n");
      return 2;
    }
    const projectRoot = process.cwd();
    const gate = await growthGate(projectRoot, { force: args.includes("--force"), action: `new --bare ${bareName}` });
    if (!gate.allowed) return 1;
    const target = join(projectRoot, "system", "subassemblies", bareName);
    const specPath = join(target, `${bareName}.spec`);
    try { await stat(specPath); process.stderr.write(`new: ${specPath} already exists\n`); return 1; }
    catch { /* fresh */ }
    await mkdir(join(target, "system", "library"), { recursive: true });
    await mkdir(join(target, "system", "subassemblies"), { recursive: true });
    await writeFile(specPath, `spec ${bareName} {\n\n  is "(one honest line — what this is)"\n\n  works when {\n  }\n\n  subassemblies {\n  }\n}\n`);
    process.stdout.write(`${specPath}\n`);
    process.stderr.write(
      `bare node scaffolded: ${bareName}.\n` +
      `Next:\n` +
      `  1. Add "${bareName}" to the parent spec's subassemblies block.\n` +
      `  2. Fill the is clause; add works-when claims as the body grows.\n` +
      `  3. When it recurs, press it into a word: node system/library/define.ts ${bareName}\n`,
    );
    return 0;
  }

  const [word, nameArg] = positional;
  if (!word) {
    process.stderr.write("usage: new.ts <Word> [<Name>] [--port <n>]  |  new.ts --bare <Name>\n");
    const words = await listWords(process.cwd());
    if (words.length) process.stderr.write(`dictionary words: ${words.join(", ")}\n`);
    return 2;
  }
  const name = nameArg ?? word;
  const portIdx = args.indexOf("--port");
  const port = portIdx >= 0 ? args[portIdx + 1] : "3000";
  const projectRoot = process.cwd();

  // The governor: growth is rationed to verified-green.
  const gate = await growthGate(projectRoot, { force: args.includes("--force"), action: `new ${word} ${name}` });
  if (!gate.allowed) return 1;

  const entry = await getEntry(projectRoot, word);
  if (!entry) {
    const words = await listWords(projectRoot);
    process.stderr.write(
      `new: no dictionary entry for "${word}".\n` +
      (words.length
        ? `Known words: ${words.join(", ")}\n`
        : `The dictionary is empty — build the first instance on bare lattice,\nthen define it: node system/library/define.ts <Subassembly> --word ${word}\n`),
    );
    return 1;
  }

  // Naming hint (R5 lineage): canonical word unless disambiguating.
  if (name !== word) {
    process.stderr.write(
      `note: you named this "${name}" instead of the canonical "${word}".\n` +
      `Convention: use the canonical word unless your project has multiple\n` +
      `instances (then qualify: Admin${word} vs Public${word}).\n`,
    );
  }

  const parentSpec = await findSpec(projectRoot);
  if (!parentSpec) {
    process.stderr.write(
      `warning: no parent *.spec at ${projectRoot} — UA is spec-first; declare\n` +
      `your root spec so the parent reference lands in lineage. (Proceeding.)\n`,
    );
  }

  const target = join(projectRoot, "system", "subassemblies", name);
  const specPath = join(target, `${name}.spec`);
  try {
    await stat(specPath);
    process.stderr.write(`new: ${specPath} already exists — refusing to overwrite\n`);
    return 1;
  } catch { /* fresh */ }

  const vars: Record<string, string> = { NAME: name, PORT: port };
  // Comments must stay OUTSIDE the works-when block — the parser captures
  // every line inside the block verbatim as a predicate.
  const claimComments = entry.claims.length
    ? "// The word's claims (what `conforms to " + word + "` will verify):\n" +
      entry.claims.map(c => `//   - ${c}`).join("\n") + "\n"
    : "";
  const trapComments = entry.traps.length
    ? entry.traps.map(t => `// trap: ${t}`).join("\n") + "\n"
    : "";

  const spec = `// LINEAGE
//   word:         ${word}
//   dialect:      core
//   ua_version:   ${uaVersion()}
//   instantiated: ${new Date().toISOString()}
//   variables:    ${JSON.stringify(vars)}
${parentSpec ? `//   parent_spec:  ${parentSpec.split("/").pop()}\n` : ""}//
// Materialized as a CONTRACT from dictionary/${word}.md — no code copied.
// The model implements; \`conforms to ${word}\` holds the instance to the
// CURRENT definition on every verify.
${claimComments}${trapComments}spec ${name} {

  is "${entry.means}"

  works when {
    conforms to ${word}
  }
}
`;

  await mkdir(join(target, "system", "library"), { recursive: true });
  await mkdir(join(target, "system", "subassemblies"), { recursive: true });
  await writeFile(specPath, spec);

  process.stdout.write(`${specPath}\n`);
  process.stderr.write(
    `contract issued: ${name} (word: ${word}).\n` +
    `Next:\n` +
    `  1. Add "${name}" to the parent spec's subassemblies block.\n` +
    `  2. Implement system/library/ per the claims (the model's job — read\n` +
    `     dictionary/${word}.md "here:" for this project's pinned choices).\n` +
    `  3. node system/library/verify.ts — conforms-to goes green when done.\n`,
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
