/**
 * walker.ts — walk the on-disk fractal, parse each node's spec, build the tree.
 *
 * The directory IS the tree: each subassembly declared in a spec corresponds
 * to a sibling folder at system/subassemblies/<Name>/. The spec file inside
 * that folder is named after its content (e.g. WebServer/WebServer.spec) —
 * the walker finds the single *.spec file in each node, no fixed filename.
 * If the folder is absent or has no spec, the subassembly is schematic.
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { parse, type ParsedSpec } from "./parser.ts";

export interface SpecNode {
  diskPath: string;                            // absolute path to this node's folder
  spec: ParsedSpec;
  subassemblies: Array<SpecNode | SchematicSub>;
}

export interface SchematicSub {
  schematic: true;
  name: string;
  role?: string;
}

export async function walk(rootDir: string): Promise<SpecNode> {
  const specFile = await findSpec(rootDir);
  if (!specFile) throw new Error(`no *.spec file in ${rootDir}`);
  const source = await readFile(specFile, "utf8");
  const spec = parse(source);

  const subassemblies: SpecNode["subassemblies"] = [];
  for (const sub of spec.subassemblies) {
    const subDir = join(rootDir, "system", "subassemblies", sub.name);
    if (await findSpec(subDir)) {
      subassemblies.push(await walk(subDir));
    } else {
      subassemblies.push({ schematic: true, name: sub.name, role: sub.role });
    }
  }

  return { diskPath: rootDir, spec, subassemblies };
}

/** Find the single *.spec file in a directory. Returns null if dir is missing or has none. */
export async function findSpec(dir: string): Promise<string | null> {
  let entries: string[];
  try { entries = await readdir(dir); } catch { return null; }
  const specs = entries.filter(f => f.endsWith(".spec"));
  if (specs.length === 0) return null;
  if (specs.length > 1) throw new Error(`expected one *.spec in ${dir}, found: ${specs.join(", ")}`);
  return join(dir, specs[0]);
}
