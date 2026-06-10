/**
 * treejson.ts — emit the spec tree as JSON for runtimes without a filesystem.
 *
 * Hosting bundles the tree into the Worker at build time (Workers have no fs).
 * Walks from cwd, serializes the SpecNode tree to stdout with diskPath stripped
 * so build-machine paths don't leak.
 *
 *   node system/library/treejson.ts > path/to/tree.json
 */

import { walk, type SpecNode } from "../../../../library/walker.ts";

const root = await walk(process.cwd());
process.stdout.write(JSON.stringify(stripDiskPath(root), null, 2));

function stripDiskPath(node: SpecNode): unknown {
  return {
    spec: node.spec,
    subassemblies: node.subassemblies.map(s =>
      "schematic" in s ? s : stripDiskPath(s as SpecNode)
    ),
  };
}
