/**
 * bootstrap.ts — the crank. Pull it and the entire system runs.
 *
 *   node system/library/bootstrap.ts
 *
 * Steps, in order:
 *   1. Derive system/package.json from the root spec.
 *   2. Walk the spec tree; delegate each elaborated subassembly's bringup to
 *      its own bootstrap.ts (start services, build artifacts, etc.).
 *   3. Run the verifier against the now-live system.
 *   4. Print a status tree + next-step context (deploy commands, prerequisites).
 *
 * Real work happens inside each subassembly. The crank just orchestrates.
 */

import { execSync } from "node:child_process";
import { walk } from "./walker.ts";
import {
  bootstrapTree,
  getDialectManifest,
  getMcpManifest,
  verifyTree,
  type BootstrapResult,
  type DialectManifest,
  type McpManifest,
  type VerifyResult,
} from "./primitives.ts";

console.log("Pulling the crank on UniversalAssembler...\n");

// 1. Derive metadata from the spec.
execSync("node system/library/derive.ts", { stdio: "inherit", cwd: process.cwd() });

// 2. Walk and bring up each subassembly.
const root = await walk(process.cwd());

// 2a. Print the dialect — what grammar, primitives, and aliases this project speaks.
//     Lets a fresh agent onboard without grepping primitives.ts.
const dialect = await getDialectManifest({ root });
console.log("");
printDialect(dialect);

// 2b. Print MCP — UA's opinion is that every project should ship an MCP
//     endpoint, because agents that *operate* a project need to talk to it
//     from inside the conversation. If a server is found, advertise its
//     surface; if not, recommend growing one from the dictionary.
const mcp = await getMcpManifest({ root });
console.log("");
printMcp(mcp);

const bootResult = await bootstrapTree(root, { root });

console.log("\nSubassemblies:");
printBootstrap(bootResult, "", true, true);

// 3. Verify the running system.
console.log("\nVerification:");
const verifyResult = await verifyTree(root, { root });
const totals = printVerify(verifyResult, "", true, true);
console.log(`\n  ${totals.pass} pass, ${totals.fail} fail, ${totals.unverified} unverified`);

// 4. Next steps — collect from all subassemblies.
const next = collectNext(bootResult);
if (next.length > 0) {
  console.log("\nNext steps:");
  for (const n of next) console.log(`  ${n}`);
}

if (totals.fail > 0) process.exit(1);

// ----- printers -----

function printDialect(d: DialectManifest): void {
  console.log("Dialect:");
  console.log(`  grammar:    ${d.grammarBlocks.join(", ")}`);
  console.log("  primitives:");
  for (const p of d.primitives) console.log(`    ${p.name}`);
  const aliases = Object.entries(d.importAliases);
  if (aliases.length > 0) {
    console.log("  aliases:");
    const maxAlias = Math.max(...aliases.map(([a]) => a.length));
    for (const [alias, target] of aliases) {
      const pad = " ".repeat(maxAlias - alias.length);
      console.log(`    ${alias}${pad}  → ${target}`);
    }
  }
  if (d.scaffolding.length > 0) {
    console.log("  scaffolding:");
    for (const w of d.scaffolding) {
      console.log(`    ${w.name}`);
      console.log(`      ${w.describe}`);
      for (const line of w.command.split("\n")) console.log(`      $ ${line}`);
    }
  }
  if (d.dictionary.length > 0) {
    console.log("  dictionary (`node system/library/dictionary.ts show <Word>` to read):");
    const max = Math.max(...d.dictionary.map(e => e.word.length));
    for (const e of d.dictionary) console.log(`    ${e.word.padEnd(max)}  ${e.means}`);
  } else {
    console.log("  dictionary: empty — define words from built code: node system/library/define.ts <Subassembly>");
  }
}

function printMcp(m: McpManifest): void {
  // The opinion. Every project should ship an MCP endpoint — that's how agents
  // operate the project from inside a conversation. Stated up front so an
  // agent reading the section understands why it's here.
  if (m.servers.length === 0) {
    console.log("MCP (the canonical way to operate this project — none configured):");
    console.log("  No MCPServer subassembly found. Recommended: grow an MCPServer word");
    console.log("  in your dictionary (define one from a built instance, or write the entry).");
    console.log("  Why: agents that operate this project benefit from an endpoint that surfaces");
    console.log("  verification state, the spec tree, and any actionable verbs. Without an MCP");
    console.log("  server they have to shell out and parse text.");
    return;
  }
  console.log("MCP (the canonical way to operate this project):");
  for (const s of m.servers) {
    console.log(`  ${s.name}`);
    // Transports tell the agent HOW to reach the server.
    if (s.transports.length > 0) {
      console.log("    transports:");
      const maxT = Math.max(...s.transports.map(t => t.name.length));
      for (const t of s.transports) console.log(`      ${t.name.padEnd(maxT)}  ${t.role}`);
    }
    // Verbs tell the agent how to START it.
    const startVerbs = s.verbs.filter(v => v.name === "start" || v.name === "serveHttp");
    if (startVerbs.length > 0) {
      console.log("    invoke:");
      const maxV = Math.max(...startVerbs.map(v => v.name.length));
      for (const v of startVerbs) console.log(`      ${v.name.padEnd(maxV)}  ${v.role}`);
    }
    // Resources are the read surface — what agents query.
    if (s.resources.length > 0) {
      console.log("    resources:");
      const maxR = Math.max(...s.resources.map(r => r.name.length));
      for (const r of s.resources) console.log(`      ${r.name.padEnd(maxR)}  ${r.role}`);
    }
    // Tools are the action surface — what agents call.
    if (s.tools.length > 0) {
      console.log("    tools:");
      const maxTl = Math.max(...s.tools.map(t => t.name.length));
      for (const t of s.tools) console.log(`      ${t.name.padEnd(maxTl)}  ${t.role}`);
    }
  }
}

function printBootstrap(r: BootstrapResult, prefix: string, isRoot: boolean, isLast: boolean): void {
  const connector = isRoot ? "" : (isLast ? "└── " : "├── ");
  if (!isRoot) {
    const mark = r.status === "ready" || r.status === "started" ? "✓"
               : r.status === "skipped" ? "·"
               : "✗";
    const detail = r.detail ? `  (${r.detail})` : "";
    const pid = r.pid ? `  (pid ${r.pid})` : "";
    console.log(`${prefix}${connector}${mark} ${r.node.spec.name}${detail}${pid}`);
    const sub = prefix + (isLast ? "    " : "│   ");
    if (r.node.spec.is) console.log(`${sub}    "${r.node.spec.is}"`);
    for (const out of r.outputs) console.log(`${sub}    → ${out}`);
    if (r.verbs && r.verbs.length > 0) {
      console.log(`${sub}    verbs:`);
      const maxName = Math.max(...r.verbs.map(v => v.name.length));
      for (const v of r.verbs) {
        const pad = " ".repeat(maxName - v.name.length);
        const role = v.role ? `  — ${v.role}` : "";
        console.log(`${sub}      ${v.name}${pad}${role}`);
      }
    }
  }
  const childPrefix = prefix + (isRoot ? "" : (isLast ? "    " : "│   "));
  for (let i = 0; i < r.children.length; i++) {
    printBootstrap(r.children[i], childPrefix, false, i === r.children.length - 1);
  }
}

interface Totals { pass: number; fail: number; unverified: number; }

function printVerify(r: VerifyResult, prefix: string, isRoot: boolean, isLast: boolean): Totals {
  const connector = isRoot ? "" : (isLast ? "└── " : "├── ");
  console.log(`${prefix}${connector}${r.node.spec.name}`);
  const childPrefix = prefix + (isRoot ? "" : (isLast ? "    " : "│   "));
  const totals: Totals = { pass: 0, fail: 0, unverified: 0 };
  for (const sig of r.signals) {
    const mark = sig.kind === "pass" ? "✓" : sig.kind === "fail" ? "✗" : "?";
    const tail = sig.detail ? `  — ${sig.detail}` : "";
    console.log(`${childPrefix}  ${mark} ${sig.predicate}${tail}`);
    totals[sig.kind === "pass" ? "pass" : sig.kind === "fail" ? "fail" : "unverified"]++;
  }
  for (let i = 0; i < r.children.length; i++) {
    const sub = printVerify(r.children[i], childPrefix, false, i === r.children.length - 1);
    totals.pass += sub.pass; totals.fail += sub.fail; totals.unverified += sub.unverified;
  }
  return totals;
}

function collectNext(r: BootstrapResult): string[] {
  const out = [...(r.next ?? [])];
  for (const c of r.children) out.push(...collectNext(c));
  return out;
}
