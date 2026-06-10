/**
 * start.ts — WebServer's start verb. Walks the spec tree from the project
 * root, hands it to the Node listener, and serves. Run from project root:
 *
 *   node system/subassemblies/WebServer/system/library/start.ts
 *
 * Convention: every subassembly that runs as a service owns a start.ts.
 */

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { walk } from "../../../../library/walker.ts";
import { start } from "./server.ts";

// Re-export so `verb start :: ...` resolves at the canonical start.ts location.
export { start };

// Only run on direct invocation (`node start.ts`), not on import. The
// verifier dynamically imports start.ts to inspect exports; without this
// guard, the import triggers a port bind, and every subsequent verify
// crashes with EADDRINUSE after the first bootstrap. This is the
// root cause of the pre-commit-hook-vs-CLI discrepancy noted earlier.
const invokedDirectly = (() => {
  try {
    const argv1 = process.argv[1];
    if (!argv1) return false;
    const here = fileURLToPath(import.meta.url);
    return realpathSync(argv1) === realpathSync(here);
  } catch { return false; }
})();

if (invokedDirectly) {
  const root = await walk(process.cwd());
  start(root, 3000);
}
