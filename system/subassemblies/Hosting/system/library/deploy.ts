/**
 * deploy.ts — Hosting's deploy verb. One shot: regenerate tree.json, then
 * `wrangler deploy`. Run from project root:
 *
 *   node system/subassemblies/Hosting/system/library/deploy.ts
 *
 * Requires `npx wrangler login` once. That's the only prerequisite this
 * script doesn't handle itself.
 */

import { execSync, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(here, "../../../../..");

// 1. Regenerate the embedded tree.
const treejsonScript = join(here, "treejson.ts");
const extracted = spawnSync("node", [treejsonScript], { cwd: projectRoot });
if (extracted.status !== 0) {
  console.error("extract failed:\n" + extracted.stderr?.toString());
  process.exit(1);
}
writeFileSync(join(here, "tree.json"), extracted.stdout);
console.log("✓ tree.json regenerated");

// 2. Deploy.
execSync("npx wrangler deploy", {
  cwd: here,
  stdio: "inherit",
  env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
});
