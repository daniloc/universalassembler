/**
 * accept.ts — the human attestation layer. Green is not blessed.
 *
 *   node system/library/accept.ts <NodeName> [--note "..."]
 *   node system/library/accept.ts list
 *
 * Verification answers "do the claims hold?" — mechanically, continuously.
 * Acceptance answers the question machines cannot: "are these the right
 * claims — is this what I meant?" The two are deliberately separate tracks:
 *
 *   - Acceptance binds to the MEMBRANE: a node is accepted at a specific
 *     spec-content hash. Implementation churn under an unchanged contract
 *     keeps acceptance; ANY membrane edit makes it STALE — a changed
 *     contract needs re-blessing.
 *   - You cannot accept red. "Is this what I meant?" is only askable once
 *     "does it hold?" is yes.
 *   - Acceptance never gates growth. It is a social track beside the
 *     mechanical one; verify/digest/next surface what awaits blessing.
 *
 * DOCTRINE — FOR AGENTS READING THIS: acceptance is a HUMAN act. Do not run
 * `accept` on your own work. An agent marking its own output accepted is
 * the exact failure this layer exists to prevent (a status system where the
 * catalogue can bless itself). Surface what awaits acceptance; let the
 * human bless it. Every acceptance is a ledgered, auditable event.
 *
 * Ledger: <project>/.ua/acceptance.jsonl — { node, specHash, ts, note? }.
 * Committed: acceptance state is team-visible history, not local mood.
 */

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, relative } from "node:path";
import { walk, type SpecNode } from "./walker.ts";
import { verifyTree } from "./primitives.ts";

export interface AcceptanceEntry {
  node: string;       // node spec name
  path: string;       // repo-relative node dir (disambiguates same-name nodes)
  specHash: string;   // sha256 of the spec file content at acceptance time
  ts: string;
  note?: string;
}

export type AcceptanceState = "accepted" | "stale" | "unaccepted";

export function acceptancePath(projectRoot: string): string {
  return join(projectRoot, ".ua", "acceptance.jsonl");
}

export async function readAcceptance(projectRoot: string): Promise<AcceptanceEntry[]> {
  try {
    const raw = await readFile(acceptancePath(projectRoot), "utf8");
    return raw.split("\n").filter(Boolean).map(l => JSON.parse(l) as AcceptanceEntry);
  } catch { return []; }
}

async function specHashOf(node: SpecNode): Promise<string | null> {
  try {
    const src = await readFile(join(node.diskPath, `${node.spec.name}.spec`), "utf8");
    return createHash("sha256").update(src).digest("hex").slice(0, 16);
  } catch { return null; }
}

export interface NodeAcceptance {
  node: string;
  path: string;
  state: AcceptanceState;
  acceptedAt?: string;   // when state is accepted or stale
}

/**
 * Acceptance status for every node in the tree. The LAST ledger entry for a
 * node wins (re-acceptance supersedes). stale = accepted once, but the spec
 * content has changed since.
 */
export async function acceptanceStatus(projectRoot: string, root?: SpecNode): Promise<NodeAcceptance[]> {
  const tree = root ?? await walk(projectRoot);
  const ledger = await readAcceptance(projectRoot);
  const latest = new Map<string, AcceptanceEntry>();
  for (const e of ledger) latest.set(e.path, e);  // later lines overwrite

  const out: NodeAcceptance[] = [];
  async function visit(node: SpecNode): Promise<void> {
    const path = relative(projectRoot, node.diskPath) || ".";
    const entry = latest.get(path);
    if (!entry) {
      out.push({ node: node.spec.name, path, state: "unaccepted" });
    } else {
      const hash = await specHashOf(node);
      out.push({
        node: node.spec.name,
        path,
        state: hash === entry.specHash ? "accepted" : "stale",
        acceptedAt: entry.ts,
      });
    }
    for (const s of node.subassemblies) {
      if (!("schematic" in s)) await visit(s as SpecNode);
    }
  }
  await visit(tree);
  return out;
}

// ── CLI ────────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const projectRoot = process.cwd();

  if (args[0] === "list" || args.length === 0) {
    const statuses = await acceptanceStatus(projectRoot);
    const max = Math.max(...statuses.map(s => s.node.length));
    for (const s of statuses) {
      const mark = s.state === "accepted" ? "✓" : s.state === "stale" ? "≠" : "·";
      const when = s.acceptedAt ? `  (${s.state === "stale" ? "accepted then changed, " : ""}${s.acceptedAt.slice(0, 10)})` : "";
      process.stdout.write(`${mark} ${s.node.padEnd(max)}  ${s.state}${when}\n`);
    }
    const a = statuses.filter(s => s.state === "accepted").length;
    const st = statuses.filter(s => s.state === "stale").length;
    process.stderr.write(`\n${a}/${statuses.length} accepted${st ? `, ${st} stale (membrane changed since blessing)` : ""}\n`);
    return 0;
  }

  const name = args.find(a => !a.startsWith("--"));
  if (!name) {
    process.stderr.write("usage: accept.ts <NodeName> [--note \"...\"] | accept.ts list\n");
    return 2;
  }
  const noteIdx = args.indexOf("--note");
  const note = noteIdx >= 0 ? args[noteIdx + 1] : undefined;

  const root = await walk(projectRoot);
  let target: SpecNode | null = null;
  (function find(n: SpecNode) {
    if (n.spec.name === name) target = n;
    for (const s of n.subassemblies) if (!("schematic" in s)) find(s as SpecNode);
  })(root);
  if (!target) {
    process.stderr.write(`accept: no node named "${name}" in the tree\n`);
    return 1;
  }
  const node: SpecNode = target;

  // You cannot accept red: blessing presupposes the claims hold.
  const result = await verifyTree(root, { root });
  let nodeRed = false;
  (function check(r: { node: SpecNode; signals: Array<{ kind: string; predicate: string }>; children: unknown[] }) {
    if (r.node === node && r.signals.some(s => s.kind === "fail")) nodeRed = true;
    for (const c of r.children) check(c as never);
  })(result as never);
  if (nodeRed) {
    process.stderr.write(`accept: ${name} has red claims — acceptance presupposes green. Fix first: node system/library/next.ts\n`);
    return 1;
  }

  const hash = await specHashOf(node);
  if (!hash) {
    process.stderr.write(`accept: cannot read ${name}'s spec file\n`);
    return 1;
  }

  process.stderr.write(
    "NOTE: acceptance is a HUMAN attestation — \"these are the right claims;\n" +
    "this is what I meant.\" If you are an agent running this on your own\n" +
    "work, stop: surface it for the human instead.\n",
  );

  const entry: AcceptanceEntry = {
    node: name,
    path: relative(projectRoot, node.diskPath) || ".",
    specHash: hash,
    ts: new Date().toISOString(),
    ...(note ? { note } : {}),
  };
  const p = acceptancePath(projectRoot);
  await mkdir(dirname(p), { recursive: true });
  await appendFile(p, JSON.stringify(entry) + "\n");
  process.stdout.write(`accepted: ${name} @ ${hash}\n`);
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
