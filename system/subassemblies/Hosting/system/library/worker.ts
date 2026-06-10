/**
 * worker.ts — CloudFlare Workers entrypoint for the Hosting subassembly.
 *
 * The spec tree is embedded at build time as tree.json (Workers have no fs).
 * Same Hono routing as WebServer; only the listener differs.
 *
 * Regenerate tree.json before deploying:
 *   node ./treejson.ts > tree.json
 */

import tree from "./tree.json" with { type: "json" };
import type { SpecNode } from "../../../../library/walker.ts";
import { buildApp } from "../../../Documents/system/library/serve.ts";

const app = buildApp(tree as unknown as SpecNode);

export default {
  fetch: app.fetch,
};
