/**
 * dev.ts — Hosting's dev verb. One shot: regenerate tree.json, then
 * `wrangler dev` (Workers preview at http://localhost:8787/). Run from
 * project root:
 *
 *   node system/subassemblies/Hosting/system/library/dev.ts
 *
 * Symmetric with deploy.ts — same prep, different terminal.
 */

import { execSync, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(here, "../../../../..");

const treejsonScript = join(here, "treejson.ts");
const extracted = spawnSync("node", [treejsonScript], { cwd: projectRoot });
if (extracted.status !== 0) {
  console.error("extract failed:\n" + extracted.stderr?.toString());
  process.exit(1);
}
writeFileSync(join(here, "tree.json"), extracted.stdout);
console.log("✓ tree.json regenerated");

execSync("npx wrangler dev --port 8787 --ip 127.0.0.1", {
  cwd: here,
  stdio: "inherit",
  env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
});
