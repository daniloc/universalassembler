/**
 * digest.ts — the human-metabolism surface.
 *
 *   node system/library/digest.ts [--since <git-ref>]
 *
 * Humans cannot read sixty commits a day; they can read claims. The digest
 * renders change at the claim level — structure, dictionary, attention —
 * trustworthy because every line is machine-verified underneath (verify /
 * drift / debt run live; git supplies the deltas). No LLM calls: pure
 * mechanical synthesis, under ~40 lines for a typical day.
 *
 * The mark: .ua/last-digest stores the commit hash of the last digest run;
 * the next run reports everything since. --since <ref> overrides.
 *
 * Output: markdown to stdout (pipeable). Diagnostics to stderr.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { walk } from "./walker.ts";
import { verifyTree, type VerifyResult } from "./primitives.ts";
import { collectDrift, driftTotal } from "./drift.ts";
import { readDebt } from "./debt.ts";

function git(projectRoot: string, args: string): string {
  try {
    return execSync(`git ${args}`, { cwd: projectRoot, stdio: ["ignore", "pipe", "ignore"] })
      .toString().trimEnd();
  } catch { return ""; }
}

function markPath(projectRoot: string): string {
  return join(projectRoot, ".ua", "last-digest");
}

async function readMark(projectRoot: string): Promise<string | null> {
  try { return (await readFile(markPath(projectRoot), "utf8")).trim() || null; }
  catch { return null; }
}

interface Totals { pass: number; fail: number; unverified: number; }
function tally(r: VerifyResult, t: Totals = { pass: 0, fail: 0, unverified: 0 }): Totals {
  for (const s of r.signals) t[s.kind === "pass" ? "pass" : s.kind === "fail" ? "fail" : "unverified"]++;
  for (const c of r.children) tally(c, t);
  return t;
}

function reds(r: VerifyResult, out: string[] = []): string[] {
  for (const s of r.signals) if (s.kind === "fail") out.push(`${r.node.spec.name} — ${s.predicate}${s.detail ? ` (${s.detail.slice(0, 120)})` : ""}`);
  for (const c of r.children) reds(c, out);
  return out;
}

async function main(): Promise<number> {
  const projectRoot = process.cwd();
  const args = process.argv.slice(2);
  const sinceIdx = args.indexOf("--since");
  const explicitSince = sinceIdx >= 0 ? args[sinceIdx + 1] : null;
  const since = explicitSince ?? (await readMark(projectRoot));
  const head = git(projectRoot, "rev-parse HEAD");
  const range = since ? `${since}..HEAD` : "HEAD";

  // git deltas
  const commits = since ? git(projectRoot, `log --oneline ${range}`).split("\n").filter(Boolean) : [];
  const sinceDate = since ? git(projectRoot, `log -1 --format=%ci ${since}`).split(" ")[0] : "(no mark)";
  const changedFiles = since ? git(projectRoot, `diff --name-only ${range}`).split("\n").filter(Boolean) : [];

  // spec-level structure deltas
  const specChanges: string[] = [];
  const dictChanges: string[] = [];
  if (since) {
    for (const f of changedFiles) {
      // Almanac/recipe template specs are catalog content, not project
      // structure — a deleted pattern is not a removed subassembly.
      if (f.includes("/almanac/")) continue;
      if (f.endsWith(".spec")) {
        const status = git(projectRoot, `diff --name-status ${range} -- "${f}"`).split("\t")[0];
        const name = f.split("/").pop()!.replace(".spec", "");
        if (status === "A") { specChanges.push(`+${name} (new subassembly)`); continue; }
        if (status === "D") { specChanges.push(`-${name} (removed)`); continue; }
        // claims delta: count works-when lines added/removed
        const diff = git(projectRoot, `diff ${range} -- "${f}"`);
        const added = (diff.match(/^\+(?!\+\+).*\b(exists at|responds|parses|mirrors|pass at|conforms to|absent at|exports|contains|omits)\b/gm) ?? []).length;
        const removed = (diff.match(/^-(?!--).*\b(exists at|responds|parses|mirrors|pass at|conforms to|absent at|exports|contains|omits)\b/gm) ?? []).length;
        if (added || removed) specChanges.push(`${name}: ${added ? `+${added} claim${added > 1 ? "s" : ""}` : ""}${added && removed ? ", " : ""}${removed ? `-${removed} claim${removed > 1 ? "s" : ""}` : ""}`);
      }
      if (/^dictionary\/[^/]+\.md$/.test(f) && !/README\.md$/.test(f)) {
        const status = git(projectRoot, `diff --name-status ${range} -- "${f}"`).split("\t")[0];
        const word = f.split("/").pop()!.replace(".md", "");
        dictChanges.push(status === "A" ? `+${word} (new word)` : status === "D" ? `-${word} (retired)` : `${word} (revised)`);
      }
    }
  }

  // live state
  let frontier = "";
  const attention: string[] = [];
  try {
    const root = await walk(projectRoot);
    const result = await verifyTree(root, { root });
    const t = tally(result);
    const debtAll = await readDebt(projectRoot);
    const debtOpen = debtAll.filter(e => !e.cleared);
    const debtClearedRecently = since
      ? debtAll.filter(e => e.cleared && (!since || e.cleared > (git(projectRoot, `log -1 --format=%cI ${since}`) || ""))).length
      : 0;
    frontier = `frontier: ${t.pass + t.fail + t.unverified} claims, ${t.pass} green, ${t.fail} red, ${t.unverified} unverified | debt ${debtOpen.length} open${debtClearedRecently ? ` (${debtClearedRecently} cleared)` : ""}`;
    for (const r of reds(result).slice(0, 5)) attention.push(`RED: ${r}`);
    for (const e of debtOpen.slice(0, 5)) attention.push(`DEBT: [${e.kind}] ${e.detail.slice(0, 140)} (since ${e.ts.slice(0, 10)})`);
    const drift = await collectDrift(projectRoot);
    if (driftTotal(drift) > 0) attention.push(`DRIFT: ${driftTotal(drift)} finding(s) — node system/library/drift.ts`);
    // Green is not blessed: surface what awaits the human.
    const { acceptanceStatus } = await import("./accept.ts");
    const acc = await acceptanceStatus(projectRoot, root);
    const stale = acc.filter(a => a.state === "stale");
    const unaccepted = acc.filter(a => a.state === "unaccepted");
    for (const a of stale.slice(0, 3)) attention.push(`STALE ACCEPTANCE: ${a.node} — membrane changed since blessed (${a.acceptedAt?.slice(0, 10)})`);
    if (unaccepted.length > 0 && t.fail === 0) {
      attention.push(`AWAITING ACCEPTANCE: ${unaccepted.length} green node(s) never blessed — node system/library/accept.ts list`);
    }
  } catch (e) {
    frontier = `frontier: (no spec tree: ${(e as Error).message})`;
  }

  // emit
  const projectName = git(projectRoot, "rev-parse --show-toplevel").split("/").pop() ?? "project";
  const out: string[] = [];
  out.push(`# ${projectName} digest — since ${sinceDate}${commits.length ? ` (${commits.length} commit${commits.length > 1 ? "s" : ""})` : ""}`);
  out.push(frontier);
  if (specChanges.length) {
    out.push(`## structure`);
    for (const s of specChanges) out.push(`- ${s}`);
  }
  if (dictChanges.length) {
    out.push(`## dictionary`);
    for (const d of dictChanges) out.push(`- ${d}`);
  }
  if (attention.length) {
    out.push(`## attention`);
    for (const a of attention) out.push(`- ${a}`);
  }
  if (!specChanges.length && !dictChanges.length && !attention.length && commits.length === 0) {
    out.push(`no changes since the last digest.`);
  }
  process.stdout.write(out.join("\n") + "\n");

  // advance the mark
  if (head) {
    await mkdir(dirname(markPath(projectRoot)), { recursive: true });
    await writeFile(markPath(projectRoot), head + "\n");
    process.stderr.write(`digest mark advanced to ${head.slice(0, 7)}\n`);
  }
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
