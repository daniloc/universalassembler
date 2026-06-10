/**
 * derive.ts — derive system/package.json from the root Specification.spec.
 *
 * The spec is the source of truth for the DERIVED fields (name, type, private,
 * description). All OTHER fields in the existing package.json — dependencies,
 * devDependencies, imports, workspaces, scripts, exports, anything an agent
 * added by hand — are preserved verbatim.
 *
 * Preserving-by-default (not an allowlist) was Phase B's research finding:
 * the original allowlist silently wiped manually-added fields like `imports`
 * on every bootstrap, causing the #ua/* alias to mysteriously stop working.
 *
 * Run from the project root:
 *
 *   node system/library/derive.ts
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "./parser.ts";
import { findSpec } from "./walker.ts";

/** Fields derive.ts OWNS (rewrites on every run). Anything else passes through. */
const DERIVED_FIELDS = new Set(["name", "type", "private", "description"]);

const rootDir = process.cwd();
const specPath = await findSpec(rootDir);
if (!specPath) throw new Error(`no *.spec file at ${rootDir}`);
const pkgPath = join(rootDir, "system", "package.json");

const spec = parse(await readFile(specPath, "utf8"));

let existing: Record<string, unknown> = {};
try {
  existing = JSON.parse(await readFile(pkgPath, "utf8"));
} catch { /* no existing package.json; start fresh */ }

// Start with everything from existing EXCEPT the fields we own, then write our
// derived values back on top. Field order in JSON output reflects this: derived
// fields come first, user fields follow.
const preserved = Object.fromEntries(
  Object.entries(existing).filter(([k]) => !DERIVED_FIELDS.has(k))
);

const derived: Record<string, unknown> = {
  name: kebab(spec.name),
  type: "module",
  private: true,
  description: spec.is,
  ...preserved,
};

await writeFile(pkgPath, JSON.stringify(derived, null, 2) + "\n");
console.log(`derived ${pkgPath} from ${specPath} (preserved ${Object.keys(preserved).length} field(s))`);

function kebab(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}
