/**
 * primitives.ts — the shared verification vocabulary + propagation helpers.
 *
 * Local verify.ts files own their subtree. They return a VerifyResult tree
 * covering themselves and their descendants. The default propagation —
 * `verifyTree` — evaluates this node's claims with shared primitives and
 * recurses to subassemblies (delegating each via `verifySubassembly`).
 *
 * A local verifier may propagate honestly (call verifyTree), propagate custom
 * (run its own logic and call verifySubassembly per child), or fabricate the
 * subtree entirely (pretend). The orchestrator doesn't enforce honesty —
 * verification at each level is that subassembly's business.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import type { SpecNode } from "./walker.ts";
import { parse } from "./parser.ts";
import { getEntry, substituteClaim } from "./dictionary.ts";

export type Signal = { kind: "pass" | "fail" | "unverified"; predicate: string; detail?: string };

export interface VerifyResult {
  node: SpecNode;
  signals: Signal[];
  children: VerifyResult[];
}

export interface BootstrapResult {
  node: SpecNode;
  status: "ready" | "started" | "skipped" | "failed";
  outputs: string[];      // URLs, file paths, anything brought online
  next?: string[];        // commands the agent might run next (deploy, login, etc.)
  verbs?: Array<{ name: string; role?: string }>;  // declared verbs from the spec
  pid?: number;           // if a detached service was spawned
  detail?: string;        // failure reason or skip rationale
  children: BootstrapResult[];
}

export interface Primitive {
  match: RegExp;
  /** Human-readable label for dialect manifests. Optional for backward-compat. */
  name?: string;
  /** `node` is the spec node whose works-when block contains this predicate, or undefined for predicates evaluated outside a spec context. */
  check: (groups: string[], ctx: Ctx, node?: SpecNode) => Promise<{ pass: boolean; detail?: string }>;
}

export interface Ctx { root: SpecNode; }

/**
 * DialectManifest — a self-describing snapshot of the local UA dialect.
 * Surfaces grammar blocks, primitive vocabulary, import aliases, AND the
 * scaffolding workflows (how to install/extend) so an agent reading bootstrap
 * output can both *speak* and *install* the language without grepping internals.
 */
export interface DialectManifest {
  primitives: Array<{ name: string; pattern: string }>;
  grammarBlocks: string[];                  // is, works when, subassemblies, verbs, uses, outputs
  importAliases: Record<string, string>;    // sourced from package.json `imports`
  scaffolding: ScaffoldingWorkflow[];       // how to grow/maintain this UA project
  dictionary: DictionaryEntrySummary[];     // the project's grown words (means per word)
}

export interface DictionaryEntrySummary {
  word: string;        // e.g. "WebServer"
  means: string;       // the entry's one-line denotation
}

/**
 * McpManifest — the MCP surface of a UA project, walked from the spec tree.
 *
 * UA's opinion: every project should ship an MCP server. Agents that operate
 * a project want to read its verification state, walk its spec tree, and call
 * its actionable verbs — and they want to do that from inside the conversation,
 * not by shelling out. The MCP endpoint is that affordance.
 *
 * Discovery convention: a subassembly named "MCPServer" (or any subassembly
 * that has `start` or `serveHttp` as verbs) is an MCP server. Its child
 * subassemblies whose names end in *Resource or *Tool are the surface; the
 * roles describe what each does. Children named *Transport describe how to
 * reach the server.
 */
export interface McpManifest {
  servers: McpServerEntry[];
}
export interface McpServerEntry {
  name: string;                                       // subassembly name
  resources: Array<{ name: string; role: string }>;   // children with *Resource suffix
  tools: Array<{ name: string; role: string }>;       // children with *Tool suffix
  transports: Array<{ name: string; role: string }>;  // children with *Transport suffix
  verbs: Array<{ name: string; role: string }>;       // start / serveHttp / etc.
}

/**
 * ScaffoldingWorkflow — one named, agent-actionable workflow.
 * Each entry is a `name → command + one-line description` pair. The set is
 * derived from what's actually present in `system/library/` so projects that
 * forked or pruned core files only see workflows that will work.
 */
export interface ScaffoldingWorkflow {
  name: string;        // e.g. "add-subassembly", "upgrade", "seed-new-project"
  command: string;     // exact shell or code snippet the agent runs
  describe: string;    // one sentence on what it does / when to use it
}

export const primitives: Primitive[] = [
  {
    name: "<glob> exists at <scope>",
    match: /^(\S+)\s+exists\s+at\s+(every\s+node|root|this\s+node)$/,
    async check([subject, scope], ctx, node) {
      const missing: string[] = [];
      for (const dir of scopeDirs(scope, ctx, node)) {
        const present = subject.includes("*")
          ? (await glob(dir, subject)).length > 0
          : await pathExists(join(dir, subject));
        if (!present) missing.push(rel(dir, ctx));
      }
      return missing.length === 0
        ? { pass: true }
        : { pass: false, detail: `missing at: ${missing.join(", ")}` };
    },
  },
  {
    // <file> under <N> chars at <scope> — the file exists AND its content is
    // under the cap. The `is` clause philosophy applied to files: a hard
    // length ceiling is a forcing function for clarity. Verbose intent is a
    // smell whether it lives in a clause or a README. Missing file fails
    // (the cap implies the thing exists to be capped).
    name: "<file> under <N> chars at <scope>",
    match: /^(\S+)\s+under\s+(\d+)\s+chars\s+at\s+(every\s+node|root|this\s+node)$/,
    async check([subject, capStr, scope], ctx, node) {
      const cap = Number(capStr);
      const issues: string[] = [];
      for (const dir of scopeDirs(scope, ctx, node)) {
        try {
          const content = await readFile(join(dir, subject), "utf8");
          if (content.length >= cap) issues.push(`${rel(dir, ctx)}/${subject}: ${content.length} chars (cap ${cap})`);
        } catch {
          issues.push(`${rel(dir, ctx)}/${subject}: missing`);
        }
      }
      return issues.length === 0
        ? { pass: true }
        : { pass: false, detail: issues.join("; ") };
    },
  },
  {
    name: "<glob> absent at <scope>",
    match: /^(\S+)\s+absent\s+at\s+(every\s+node|root|this\s+node)$/,
    async check([subject, scope], ctx, node) {
      const present: string[] = [];
      for (const dir of scopeDirs(scope, ctx, node)) {
        if (await pathExists(join(dir, subject))) present.push(rel(dir, ctx));
      }
      return present.length === 0
        ? { pass: true }
        : { pass: false, detail: `present at: ${present.join(", ")}` };
    },
  },
  {
    // verb <name> succeeds at this node — POWER THE MOTOR. Runs the node's
    // verb and asserts exit 0. Resolution: a package.json script with that
    // name at the node (npm run <name>), else system/library/<name>.ts.
    //
    // This is THE membrane primitive under the motor principle: a capsule's
    // lattice-visible contract is current-in/rotation-out — you verify a
    // motor by powering it and watching the shaft turn, not by opening the
    // casing. Builds are pure (inputs -> artifacts), so `verb build succeeds`
    // + artifact-exists claims constitute honest behavioral verification of
    // an entire framework app concealed inside one node. Slow by design:
    // powering the motor IS the verification (cost accepted 2026-06-10).
    name: "verb <name> succeeds at this node",
    match: /^verb\s+([A-Za-z][\w:-]*)\s+succeeds\s+at\s+this\s+node$/,
    async check([verbName], _ctx, node) {
      if (!node) return { pass: false, detail: "verb-succeeds requires node context" };
      const { spawnSync } = await import("node:child_process");
      // Prefer the node's package.json script; fall back to a library verb file.
      let cmd: string[] | null = null;
      try {
        const pkgRaw = await readFile(join(node.diskPath, "package.json"), "utf8");
        const pkg = JSON.parse(pkgRaw) as { scripts?: Record<string, string> };
        if (pkg.scripts && verbName in pkg.scripts) cmd = ["npm", "run", verbName];
      } catch { /* no package.json at node */ }
      if (!cmd) {
        const verbFile = join(node.diskPath, "system", "library", `${verbName}.ts`);
        if (await pathExists(verbFile)) cmd = ["node", verbFile];
      }
      if (!cmd) {
        return { pass: false, detail: `no runnable verb "${verbName}" (no package.json script, no system/library/${verbName}.ts)` };
      }
      const r = spawnSync(cmd[0], cmd.slice(1), {
        cwd: node.diskPath,
        encoding: "utf8",
        timeout: 300_000,
        env: { ...process.env, CI: "1" },
      });
      if (r.status === 0) return { pass: true };
      const tail = ((r.stderr || "") + (r.stdout || "")).split("\n").filter(Boolean).slice(-4).join(" | ");
      return { pass: false, detail: `${cmd.join(" ")} exit ${r.status ?? "signal"}: ${tail.slice(0, 300)}` };
    },
  },
  {
    // <glob> parses at <scope> — the file(s) parse cleanly per the spec grammar
    name: "<glob> parses at <scope>",
    match: /^(\S+)\s+parses\s+at\s+(every\s+node|root)$/,
    async check([subject, scope], ctx) {
      const failures: string[] = [];
      for (const dir of scopeDirs(scope, ctx)) {
        const matches = subject.includes("*") ? await glob(dir, subject) : [subject];
        for (const file of matches) {
          const full = join(dir, file);
          try {
            const source = await readFile(full, "utf8");
            parse(source);
          } catch (e) {
            failures.push(`${rel(dir, ctx)}/${file}: ${(e as Error).message}`);
          }
        }
      }
      return failures.length === 0
        ? { pass: true }
        : { pass: false, detail: failures.join("; ") };
    },
  },
  {
    // spec.tree mirrors directory.tree — no orphan folders under any node's
    // system/subassemblies that aren't declared in its spec.
    //
    // Dotfiles (.DS_Store, .gitkeep, .git, etc.) are skipped by default — they
    // are environmental noise, not declared structure. The optional `--strict`
    // suffix opts back into the original behavior and flags them as orphans.
    name: "spec.tree mirrors directory.tree [--strict]",
    match: /^spec\.tree\s+mirrors\s+directory\.tree(\s+--strict)?$/,
    async check(groups, ctx) {
      const strict = !!groups[0];
      const orphans: string[] = [];
      async function visit(node: SpecNode): Promise<void> {
        const declared = new Set(node.spec.subassemblies.map(s => s.name));
        const subsDir = join(node.diskPath, "system", "subassemblies");
        let folders: string[] = [];
        try { folders = await readdir(subsDir); } catch { /* missing dir; not our concern here */ }
        for (const folder of folders) {
          if (!strict && folder.startsWith(".")) continue;  // dotfiles: env noise, not structure
          if (!declared.has(folder)) orphans.push(`${rel(node.diskPath, ctx)}/system/subassemblies/${folder}`);
        }
        for (const sub of node.subassemblies) {
          if (!("schematic" in sub)) await visit(sub as SpecNode);
        }
      }
      await visit(ctx.root);
      return orphans.length === 0
        ? { pass: true }
        : { pass: false, detail: `orphan folder(s): ${orphans.join(", ")}` };
    },
  },
  {
    // verb exports are present at every node — for each verb declared with an
    // `exports SYMBOL` clause (hook verbs), dynamic-import the verb file and
    // check SYMBOL is an exported function. Script verbs without `exports`
    // are NOT imported (their top-level code would run as a side effect).
    name: "verb exports are present at every node",
    match: /^verb\s+exports\s+are\s+present\s+at\s+every\s+node$/,
    async check(_groups, ctx) {
      const issues: string[] = [];
      async function visit(node: SpecNode): Promise<void> {
        for (const verb of node.spec.verbs) {
          if (!verb.exports) continue;
          const verbFile = join(node.diskPath, "system", "library", `${verb.name}.ts`);
          try {
            const mod = await import(pathToFileURL(verbFile).href);
            const sym = (mod as Record<string, unknown>)[verb.exports];
            if (typeof sym !== "function") {
              issues.push(`${rel(node.diskPath, ctx)}/${verb.name}.ts: export ${verb.exports} missing or not a function`);
            }
          } catch (e) {
            issues.push(`${rel(node.diskPath, ctx)}/${verb.name}.ts: import failed: ${(e as Error).message}`);
          }
        }
        for (const sub of node.subassemblies) {
          if (!("schematic" in sub)) await visit(sub as SpecNode);
        }
      }
      await visit(ctx.root);
      return issues.length === 0
        ? { pass: true }
        : { pass: false, detail: issues.join("; ") };
    },
  },
  {
    // tests pass at every node — for each subassembly declaring a `test` verb,
    // spawn `node --test library/test.ts` and assert exit 0. Uses Node's built-in
    // node:test (zero deps). Unit-style coverage complements works-when's
    // integration-style verification.
    name: "tests pass at every node",
    match: /^tests\s+pass\s+at\s+every\s+node$/,
    async check(_groups, ctx) {
      const { spawn } = await import("node:child_process");
      const failures: string[] = [];
      async function visit(node: SpecNode): Promise<void> {
        const hasTestVerb = node.spec.verbs.some(v => v.name === "test");
        if (hasTestVerb) {
          const testFile = join(node.diskPath, "system", "library", "test.ts");
          let testFileExists = false;
          try { await stat(testFile); testFileExists = true; } catch { /* missing */ }
          if (!testFileExists) {
            failures.push(`${node.spec.name}: declares test verb but library/test.ts missing`);
          } else {
            const result: { code: number | null; stderr: string } = await new Promise(resolve => {
              const child = spawn("node", ["--test", testFile], { cwd: node.diskPath });
              let stderr = "";
              child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
              child.on("close", (code: number | null) => resolve({ code, stderr }));
            });
            if (result.code !== 0) {
              const tail = result.stderr.trim().split("\n").slice(-3).join(" | ");
              failures.push(`${node.spec.name}/test.ts exit ${result.code}: ${tail}`);
            }
          }
        }
        for (const s of node.subassemblies) if (!("schematic" in s)) await visit(s as SpecNode);
      }
      await visit(ctx.root);
      return failures.length === 0
        ? { pass: true }
        : { pass: false, detail: failures.join("; ") };
    },
  },
  {
    // declared outputs are present — for each `outputs { ... }` declaration,
    // verify the named thing is reachable. Category drives the resolver:
    //   verb     → library/<name>.ts exists AND exports <name> (or `exports SYMBOL`)
    //   module   → multi-strategy lookup (preserved for backward compat):
    //              file at libDir/<name>, file at libDir/<name>.ts, export-scan,
    //              file at nodeDir/<name>. The order tries cheapest first.
    //   file     → stat <name> relative to libDir or nodeDir
    //   resource → skipped (runtime URI; no static check)
    // Untagged outputs default to `module` (see parser). Pre-category specs that
    // mixed export names with file paths (`_tokens.scss`, `dist/`) keep passing
    // because module-resolution still falls through to the on-disk checks.
    name: "declared outputs are present",
    match: /^declared\s+outputs\s+are\s+present$/,
    async check(_groups, ctx) {
      const issues: string[] = [];
      async function visit(node: SpecNode): Promise<void> {
        // Conformance is DEFAULT-ON for typed outputs. The component-swap test
        // (2026-06-10) found both Store specs carrying stale template
        // signatures while the implementations had different surfaces — the
        // conformance primitive existed but was opt-in, so nobody opted in
        // and the self-description lied. A node opts OUT with an explicit
        // `outputs unchecked` works-when line; the opt-out is warned loudly.
        const unchecked = (node.spec.worksWhen ?? []).some(p => /^outputs\s+unchecked$/.test(p.trim()));
        if (unchecked) {
          process.stderr.write(
            `warning: ${node.spec.name} declares "outputs unchecked" — typed output signatures are NOT verified for this node\n`,
          );
        }
        for (const out of node.spec.outputs ?? []) {
          const libDir = join(node.diskPath, "system", "library");
          const sym = out.exports ?? out.name;
          let found = false;
          let detail = "";
          let exportValue: unknown;
          let haveValue = false;
          switch (out.category) {
            case "resource":
              found = true;  // runtime concept; nothing to inspect on disk
              break;
            case "file": {
              for (const c of [join(libDir, out.name), join(node.diskPath, out.name)]) {
                try { await stat(c); found = true; break; } catch { /* keep looking */ }
              }
              if (!found) detail = `file "${out.name}" not at library/ or node root`;
              break;
            }
            case "verb": {
              const verbFile = join(libDir, `${out.name}.ts`);
              try {
                await stat(verbFile);
                const mod = await import(pathToFileURL(verbFile).href);
                if (sym in (mod as Record<string, unknown>)) {
                  found = true;
                  exportValue = (mod as Record<string, unknown>)[sym];
                  haveValue = true;
                } else detail = `verb file ${out.name}.ts exists but missing export ${sym}`;
              } catch (e) {
                detail = `verb file ${out.name}.ts missing or unimportable: ${(e as Error).message}`;
              }
              break;
            }
            case "module":
            default: {
              // Multi-strategy resolution mirrors the pre-category behavior so
              // legacy untagged outputs like `_tokens.scss` and `dist/` still pass.
              const candidates = [
                join(libDir, out.name),
                join(libDir, out.name + ".ts"),
                join(node.diskPath, out.name),
              ];
              for (const c of candidates) {
                try { await stat(c); found = true; break; } catch { /* keep looking */ }
              }
              if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(sym)) {
                const located = await locateExport(libDir, sym);
                if (located) { found = true; exportValue = located.value; haveValue = true; }
              }
              if (!found) detail = `not found in library/ or as a node path`;
              break;
            }
          }
          if (!found) {
            issues.push(`${node.spec.name} declares ${out.category} output "${out.name}" — ${detail}`);
            continue;
          }
          // Signature conformance (default-on). Only verb/module outputs have
          // runtime values; only typed (::) outputs declare a shape to check.
          if (
            !unchecked &&
            out.signature &&
            (out.category === "verb" || out.category === "module" || out.category === undefined)
          ) {
            if (!haveValue) {
              issues.push(
                `${node.spec.name}.${out.name}: declares signature "${out.signature}" but export "${sym}" was not importable for conformance check`,
              );
            } else {
              for (const d of checkSignature(exportValue, out.signature)) {
                issues.push(`${node.spec.name}.${out.name}: ${d}`);
              }
            }
          }
        }
        for (const s of node.subassemblies) {
          if (!("schematic" in s)) await visit(s as SpecNode);
        }
      }
      await visit(ctx.root);
      return issues.length === 0
        ? { pass: true }
        : { pass: false, detail: issues.join("; ") };
    },
  },
  {
    // outputs unchecked — explicit, loud opt-out from default-on signature
    // conformance (see "declared outputs are present"). The line itself
    // passes so it doesn't pollute the report as unverified; the warning is
    // emitted where the suppression takes effect.
    name: "outputs unchecked",
    match: /^outputs\s+unchecked$/,
    async check() {
      return { pass: true };
    },
  },
  {
    // outputs match declared signatures — runtime-verifiable shape conformance
    // for outputs that opted into a `:: <type>` suffix.
    //
    // SCOPE — what this primitive does and does NOT check.
    //
    // Does:
    //   - Function signatures `(a, b, ...) => R`:
    //       * the export exists in the subassembly's library
    //       * the export is callable
    //       * its arity matches the param count in the signature
    //       * if R mentions `Promise`, the export is async (AsyncFunction)
    //         OR (when it can be called with no required args) it returns
    //         a thenable on a smoke invocation
    //   - Structural signatures `{ foo(): X; bar: Y }`:
    //       * each named member is present
    //       * a member declared `name(...)` is callable
    //       * a member declared `name:` is non-callable
    //
    // Does NOT:
    //   - Full TypeScript type checking. Parameter types, return-value
    //     shape, and generic instantiations are NOT verified — that's
    //     outside what runtime introspection can know.
    //   - Cross-module ABI. We import the export by name and stop there.
    //
    // Skips outputs without `::` — they remain covered by `declared outputs
    // are present`. The presence check is the floor; this primitive is the
    // opt-in receptor-specificity layer on top of it. Future maintainers:
    // do NOT widen this to deep type inspection. If you need that, generate
    // .d.ts files and run `tsc --noEmit` as a separate check.
    name: "outputs match declared signatures",
    match: /^outputs\s+match\s+declared\s+signatures$/,
    async check(_groups, ctx) {
      const issues: string[] = [];
      async function visit(node: SpecNode): Promise<void> {
        for (const out of node.spec.outputs ?? []) {
          if (!out.signature) continue;  // untyped — not our concern
          // Only verb/module outputs have runtime values to introspect.
          // file outputs are on-disk paths; resource outputs are URI handles —
          // skip signature shape checks for both.
          if (out.category === "file" || out.category === "resource") continue;
          const symbolName = out.exports ?? out.name;
          // Find the export. We scan library/*.ts for the symbol — same
          // discovery rule the `declared outputs are present` primitive uses,
          // so a passing presence check feeds straight into here.
          const libDir = join(node.diskPath, "system", "library");
          const located = await locateExport(libDir, symbolName);
          if (!located) {
            issues.push(`${node.spec.name}.${out.name}: export "${symbolName}" not found in library/`);
            continue;
          }
          const subIssues = checkSignature(located.value, out.signature);
          for (const detail of subIssues) {
            issues.push(`${node.spec.name}.${out.name}: ${detail}`);
          }
        }
        for (const s of node.subassemblies) {
          if (!("schematic" in s)) await visit(s as SpecNode);
        }
      }
      await visit(ctx.root);
      return issues.length === 0
        ? { pass: true }
        : { pass: false, detail: issues.join("; ") };
    },
  },
  {
    // declared uses are satisfied — every `uses { Name }` reference resolves
    // to a real subassembly somewhere in the tree. Captures coupling that
    // subassemblies (containment) doesn't.
    name: "declared uses are satisfied",
    match: /^declared\s+uses\s+are\s+satisfied$/,
    async check(_groups, ctx) {
      const known = new Set<string>();
      (function index(n: SpecNode): void {
        known.add(n.spec.name);
        for (const s of n.subassemblies) {
          if ("schematic" in s) known.add(s.name);
          else { known.add((s as SpecNode).spec.name); index(s as SpecNode); }
        }
      })(ctx.root);
      const unsatisfied: string[] = [];
      (function visit(n: SpecNode): void {
        for (const ref of n.spec.uses ?? []) {
          const last = ref.split(".").pop()!;
          if (!known.has(last)) unsatisfied.push(`${n.spec.name} uses ${ref} — not found in tree`);
        }
        for (const s of n.subassemblies) {
          if (!("schematic" in s)) visit(s as SpecNode);
        }
      })(ctx.root);
      return unsatisfied.length === 0
        ? { pass: true }
        : { pass: false, detail: unsatisfied.join("; ") };
    },
  },
  {
    // declared verbs are present in library — every verb declared in any node's
    // spec must have a matching <name>.ts in that node's system/library/.
    name: "declared verbs are present in library",
    match: /^declared\s+verbs\s+are\s+present\s+in\s+library$/,
    async check(_groups, ctx) {
      const missing: string[] = [];
      async function visit(node: SpecNode): Promise<void> {
        for (const verb of node.spec.verbs) {
          const verbFile = join(node.diskPath, "system", "library", `${verb.name}.ts`);
          try { await stat(verbFile); } catch {
            missing.push(`${rel(node.diskPath, ctx)} declares "${verb.name}" but ${verb.name}.ts missing`);
          }
        }
        for (const sub of node.subassemblies) {
          if (!("schematic" in sub)) await visit(sub as SpecNode);
        }
      }
      await visit(ctx.root);
      return missing.length === 0
        ? { pass: true }
        : { pass: false, detail: missing.join("; ") };
    },
  },
  {
    // <file> imports <module> — file statically imports the module (path is project-relative).
    name: "<file> imports <module>",
    match: /^(\S+)\s+imports\s+(\S+)$/,
    async check([file, mod], ctx) {
      const full = join(ctx.root.diskPath, file);
      try {
        const source = await readFile(full, "utf8");
        const esc = mod.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const pattern = new RegExp(`from\\s+["']${esc}["']|import\\s+["']${esc}["']`);
        return pattern.test(source)
          ? { pass: true }
          : { pass: false, detail: `${file} does not import ${mod}` };
      } catch (e) {
        return { pass: false, detail: `cannot read ${file}: ${(e as Error).message}` };
      }
    },
  },
  {
    // conforms to <Word> — this subassembly satisfies the project dictionary
    // entry for <Word>. Semantic conformance to the CURRENT definition:
    //   1. dictionary/<Word>.md exists and parses
    //   2. every claim in the entry's `## claims` block passes against this
    //      node, with {NAME}/{PORT}-style vars substituted from the node's
    //      LINEAGE variables (NAME defaults to the node's spec name)
    //
    // This is the dictionary-era replacement for `derives from almanac/X`:
    // a dictionary edit propagates to every conforming instance on the next
    // verify — drift detection by definition, not by byte-diff against
    // template code that rots. (R6 template drift went unnoticed for hours
    // under the byte-diff model; under conforms-to it is a red immediately.)
    name: "conforms to <Word>",
    match: /^conforms\s+to\s+(\S+)$/,
    async check([word], ctx, node) {
      if (!node) return { pass: false, detail: "conforms-to requires node context" };
      const entry = await getEntry(ctx.root.diskPath, word);
      if (!entry) {
        return { pass: false, detail: `no dictionary entry for "${word}" (expected dictionary/${word}.md)` };
      }
      const vars: Record<string, string> = {
        NAME: node.spec.name,
        PORT: "3000",  // default; LINEAGE variables override (new.ts records --port)
        ...(node.spec.lineage?.variables ?? {}),
      };
      const issues: string[] = [];
      for (const rawClaim of entry.claims) {
        const claim = substituteClaim(rawClaim, vars);
        // Guard against direct self-reference loops (conforms to <same word>).
        if (new RegExp(`^conforms\\s+to\\s+${word}$`).test(claim)) continue;
        const sig = await evaluate(claim, ctx, undefined, node);
        if (sig.kind === "fail") {
          issues.push(`${word} claim "${claim}" — ${sig.detail ?? "failed"}`);
        } else if (sig.kind === "unverified") {
          issues.push(`${word} claim "${claim}" — no primitive matched (dialect gap?)`);
        }
      }
      return issues.length === 0
        ? { pass: true }
        : { pass: false, detail: issues.join("; ") };
    },
  },
  {
    // Three modes after status:
    //   with "..."   substring match against response body
    //   body "..."   exact-equality match against response body (trimmed)
    //   json .path   JSON.parse(body), walk dotted path, assert truthy
    // The bare form `<url> responds <status>` checks status only.
    name: "<url> responds <status> [with \"...\" | body \"...\" | json .path]",
    match: /^(\S+)\s+responds\s+(\d+)(?:\s+(with|body)\s+"((?:[^"\\]|\\.)*)"|\s+json\s+(\.\S+))?$/,
    async check([url, statusStr, mode, quoted, jsonPath]) {
      const want = Number(statusStr);
      try {
        const res = await fetch(url);
        if (res.status !== want) return { pass: false, detail: `got ${res.status}, wanted ${want}` };
        if (mode === "with") {
          const body = await res.text();
          if (!body.includes(quoted)) return { pass: false, detail: `body missing substring "${quoted}"` };
        } else if (mode === "body") {
          const body = (await res.text()).trim();
          if (body !== quoted) return { pass: false, detail: `body "${body.slice(0, 60)}" ≠ "${quoted}"` };
        } else if (jsonPath) {
          const body = await res.text();
          let parsed: unknown;
          try { parsed = JSON.parse(body); }
          catch (e) { return { pass: false, detail: `body is not JSON: ${(e as Error).message}` }; }
          const segments = jsonPath.slice(1).split(".");  // strip leading "."
          let cur: unknown = parsed;
          for (const seg of segments) {
            if (cur === null || typeof cur !== "object" || !(seg in (cur as Record<string, unknown>))) {
              return { pass: false, detail: `json path ${jsonPath} missing at "${seg}"` };
            }
            cur = (cur as Record<string, unknown>)[seg];
          }
          if (!cur) return { pass: false, detail: `json path ${jsonPath} is falsy (${JSON.stringify(cur)})` };
        }
        return { pass: true };
      } catch (e) {
        return { pass: false, detail: `unreachable: ${(e as Error).message}` };
      }
    },
  },
];

export async function evaluate(
  predicate: string,
  ctx: Ctx,
  primitivesList: Primitive[] = primitives,
  node?: SpecNode,
): Promise<Signal> {
  for (const prim of primitivesList) {
    const m = prim.match.exec(predicate);
    if (m) {
      const { pass, detail } = await prim.check(m.slice(1), ctx, node);
      return { kind: pass ? "pass" : "fail", predicate, detail };
    }
  }
  return { kind: "unverified", predicate };
}

/** Convenience for local verifiers: run every claim in a node's spec.
 *  Passes `node` to evaluate() so predicates with `this node` scope resolve correctly. */
export async function evaluateSpec(node: SpecNode, ctx: Ctx, primitivesList?: Primitive[]): Promise<Signal[]> {
  return Promise.all(node.spec.worksWhen.map(p => evaluate(p, ctx, primitivesList, node)));
}

/**
 * Structural floor: predicates the engine evaluates at the root whether or
 * not the project declared them. A project that hand-writes its specs (no
 * init, no templates) still gets outputs presence + signature conformance —
 * the component-swap test showed self-descriptions silently rot when the
 * floor is opt-in. Projects that already declare a floor predicate at the
 * root don't get a duplicate.
 */
const STRUCTURAL_FLOOR = ["declared outputs are present"];

/**
 * Default subtree propagation: evaluate this node's claims, then dispatch
 * each elaborated subassembly to verifySubassembly. Local verifiers call
 * this for honest propagation. At the project root, the structural floor
 * is injected ahead of declared claims.
 */
export async function verifyTree(node: SpecNode, ctx: Ctx, primitivesList?: Primitive[]): Promise<VerifyResult> {
  const signals = await evaluateSpec(node, ctx, primitivesList);
  if (node === ctx.root) {
    const declared = new Set(node.spec.worksWhen.map(p => p.replace(/\s+/g, " ").trim()));
    for (const floor of STRUCTURAL_FLOOR) {
      if (!declared.has(floor)) {
        signals.unshift(await evaluate(floor, ctx, primitivesList, node));
      }
    }
  }
  const subs = node.subassemblies.filter(s => !("schematic" in s)) as SpecNode[];
  const children = await Promise.all(subs.map(sub => verifySubassembly(sub, ctx)));
  return { node, signals, children };
}

/**
 * Dispatch a subassembly: if it has its own verify.ts, hand it the subtree
 * (whatever it returns is what gets reported). Otherwise apply default
 * propagation.
 */
export async function verifySubassembly(node: SpecNode, ctx: Ctx): Promise<VerifyResult> {
  const localPath = join(node.diskPath, "system", "library", "verify.ts");
  if (await fileExists(localPath)) {
    const mod = await import(pathToFileURL(localPath).href);
    return mod.verify(node, ctx);
  }
  return verifyTree(node, ctx);
}

async function fileExists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}

/**
 * Default bootstrap propagation: dispatch each elaborated subassembly to
 * bootstrapSubassembly. The root itself produces no signals — the work happens
 * at each subassembly. Local bootstrap.ts files own their bringup.
 */
export async function bootstrapTree(node: SpecNode, ctx: Ctx): Promise<BootstrapResult> {
  const subs = node.subassemblies.filter(s => !("schematic" in s)) as SpecNode[];
  const children = await Promise.all(subs.map(sub => bootstrapSubassembly(sub, ctx)));
  return { node, status: "skipped", outputs: [], children };
}

/**
 * Dispatch a subassembly for bringup: invoke its bootstrap.ts if present,
 * else mark as skipped with a rationale. Always attaches discovered verbs.
 */
export async function bootstrapSubassembly(node: SpecNode, ctx: Ctx): Promise<BootstrapResult> {
  const localPath = join(node.diskPath, "system", "library", "bootstrap.ts");
  const verbs = await discoverVerbs(node);
  if (await fileExists(localPath)) {
    const mod = await import(pathToFileURL(localPath).href);
    const result: BootstrapResult = await mod.bootstrap(node, ctx);
    return { ...result, verbs };
  }
  // Container default: propagate to children automatically. A node without its
  // own bootstrap.ts shouldn't block bringup of its descendants. This is the
  // `propagateTree` behavior the migration agents asked for.
  const subs = node.subassemblies.filter(s => !("schematic" in s)) as SpecNode[];
  const children = await Promise.all(subs.map(sub => bootstrapSubassembly(sub, ctx)));
  return {
    node,
    status: "skipped",
    outputs: [],
    detail: subs.length > 0 ? "no bootstrap.ts (default-recursed)" : "no bootstrap.ts",
    verbs,
    children,
  };
}

/**
 * Verbs come from the spec, not from filename convention. Returns whatever
 * the spec declared in its `verbs { ... }` block — open vocabulary.
 */
async function discoverVerbs(node: SpecNode): Promise<Array<{ name: string; role?: string }>> {
  return node.spec.verbs ?? [];
}

function scopeDirs(scope: string, ctx: Ctx, node?: SpecNode): string[] {
  const normalized = scope.replace(/\s+/g, " ").trim();
  if (normalized === "root") return [ctx.root.diskPath];
  if (normalized === "this node") return node ? [node.diskPath] : [];
  // "every node" — every elaborated subassembly, leaves included. Use this for
  // predicates that describe a node's own state (e.g. `*.spec exists at every
  // node` — every node has its own spec, including leaves).
  const out: string[] = [];
  (function visit(n: SpecNode) {
    out.push(n.diskPath);
    for (const s of n.subassemblies) if (!("schematic" in s)) visit(s as SpecNode);
  })(ctx.root);
  return out;
}

/**
 * getDialectManifest — describe the local UA dialect for agent onboarding.
 * Surfaces the grammar blocks the parser understands, the primitive vocabulary
 * available to `works when`, and the import aliases declared in package.json.
 * Bootstrap prints this; agents read it instead of grepping internals.
 */
export async function getDialectManifest(ctx: Ctx, primitivesList: Primitive[] = primitives): Promise<DialectManifest> {
  const named = primitivesList
    .filter(p => p.name)
    .map(p => ({ name: p.name as string, pattern: p.match.source }));
  const aliases = await readImportAliases(ctx.root.diskPath);
  return {
    primitives: named,
    grammarBlocks: ["is", "works when", "subassemblies", "verbs", "uses", "outputs"],
    importAliases: aliases,
    scaffolding: await getScaffoldingWorkflows(ctx.root.diskPath, aliases),
    dictionary: await getDictionarySummaries(ctx.root.diskPath),
  };
}

/**
 * Walk the spec tree for MCP servers. A subassembly is an MCP server if its
 * name is "MCPServer" or it declares a `start`/`serveHttp` verb. For each,
 * categorize its child subassemblies by suffix (*Resource, *Tool, *Transport).
 *
 * The verbs themselves carry the transport+invocation info; the children
 * carry the surface. Both are surfaced in bootstrap output.
 */
export async function getMcpManifest(ctx: Ctx): Promise<McpManifest> {
  const servers: McpServerEntry[] = [];
  function visit(node: SpecNode): void {
    const verbNames = new Set(node.spec.verbs.map(v => v.name));
    const looksLikeMcp = node.spec.name === "MCPServer"
      || verbNames.has("serveHttp")
      || (verbNames.has("start") && verbNames.has("bootstrap"));
    if (looksLikeMcp) {
      const resources: Array<{ name: string; role: string }> = [];
      const tools: Array<{ name: string; role: string }> = [];
      const transports: Array<{ name: string; role: string }> = [];
      for (const sub of node.spec.subassemblies) {
        const role = sub.role ?? "";
        if (sub.name.endsWith("Resource")) resources.push({ name: sub.name, role });
        else if (sub.name.endsWith("Tool")) tools.push({ name: sub.name, role });
        else if (sub.name.endsWith("Transport")) transports.push({ name: sub.name, role });
      }
      const verbs = node.spec.verbs.map(v => ({ name: v.name, role: v.role ?? "" }));
      servers.push({ name: node.spec.name, resources, tools, transports, verbs });
    }
    for (const sub of node.subassemblies) {
      if (!("schematic" in sub)) visit(sub as SpecNode);
    }
  }
  visit(ctx.root);
  return { servers };
}

async function getDictionarySummaries(rootDir: string): Promise<DictionaryEntrySummary[]> {
  // The project's grown vocabulary — surfaced in bootstrap output so an agent
  // knows which words exist without grepping. Details: dictionary.ts show <Word>.
  const { listWords, getEntry: getDictEntry } = await import("./dictionary.ts");
  const words = await listWords(rootDir);
  const out: DictionaryEntrySummary[] = [];
  for (const w of words) {
    const e = await getDictEntry(rootDir, w);
    if (e) out.push({ word: w, means: e.means });
  }
  return out;
}

/**
 * Discover which scaffolding workflows are available in this project.
 * Each entry is only surfaced when its backing script exists in system/library/.
 * A first-time agent reading bootstrap output learns from this exactly:
 *   - how to add a subassembly to grow the tree
 *   - how to reference UA core from their own TypeScript
 *   - how to upgrade vendored core when canonical evolves
 *   - how to seed a new UA project elsewhere
 */
async function getScaffoldingWorkflows(
  rootDir: string,
  aliases: Record<string, string>,
): Promise<ScaffoldingWorkflow[]> {
  const libDir = join(rootDir, "system", "library");
  const present = async (f: string) => pathExists(join(libDir, f));

  const flows: ScaffoldingWorkflow[] = [];

  // Adding a subassembly is always available — it's a convention, not a script.
  flows.push({
    name: "grow",
    command: "node system/library/new.ts <Word> [<Name>]   # contract from a dictionary word\nnode system/library/define.ts <Subassembly>     # word from built code",
    describe: "the canonical growth loop: define words from what you build; materialize contracts from words; `next` sequences it all.",
  });

  // Reference UA from your code — only meaningful if an alias is declared.
  const uaAlias = Object.keys(aliases).find(a => /^#ua\//.test(a));
  if (uaAlias) {
    const target = aliases[uaAlias].replace(/\/\*$/, "");
    flows.push({
      name: "reference-ua",
      command: `import { walk } from "${uaAlias.replace(/\*$/, "walker.ts")}"`,
      describe: `the ${uaAlias} alias maps to ${target}/. Use it from any subassembly's library/*.ts to call into UA core without relative paths.`,
    });
  }

  if (await present("upgrade.ts")) {
    flows.push({
      name: "upgrade",
      command: "node system/library/upgrade.ts            # dry-run\nnode system/library/upgrade.ts --apply    # commit",
      describe: "pull canonical UA core into this project. Mark files `// LOCAL FORK — do not auto-upgrade` to keep your edits.",
    });
  }

  if (await present("init.ts")) {
    flows.push({
      name: "seed-new-project",
      command: "node system/library/init.ts <ProjectName>",
      describe: "seed a fresh UA-shaped project elsewhere. Use when starting a new project rather than vendoring into existing.",
    });
  }

  return flows;
}

/**
 * Read the `imports` field from package.json — try root first, then system/.
 * Returns an empty object if no aliases are declared. Single-string targets
 * (the common case) are surfaced verbatim; conditional-exports targets are
 * stringified to a recognizable shape.
 */
async function readImportAliases(rootDir: string): Promise<Record<string, string>> {
  const candidates = [join(rootDir, "package.json"), join(rootDir, "system", "package.json")];
  const merged: Record<string, string> = {};
  for (const path of candidates) {
    try {
      const text = await readFile(path, "utf8");
      const pkg = JSON.parse(text) as { imports?: Record<string, unknown> };
      if (!pkg.imports) continue;
      for (const [alias, target] of Object.entries(pkg.imports)) {
        if (alias in merged) continue;  // earlier (root) wins
        merged[alias] = typeof target === "string" ? target : JSON.stringify(target);
      }
    } catch { /* missing or unreadable; not fatal */ }
  }
  return merged;
}

async function pathExists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}

// ── Signature introspection helpers (for "outputs match declared signatures") ──

/**
 * Find `symbolName` exported from any `*.ts` in `libDir`. Returns the resolved
 * value and the file it came from, or null if not found. Errors importing
 * individual files are swallowed — a single broken file shouldn't mask a
 * symbol that lives in another.
 */
async function locateExport(
  libDir: string,
  symbolName: string,
): Promise<{ value: unknown; file: string } | null> {
  let entries: string[];
  try { entries = await readdir(libDir); } catch { return null; }
  for (const f of entries) {
    if (!f.endsWith(".ts")) continue;
    try {
      const mod = await import(pathToFileURL(join(libDir, f)).href);
      if (symbolName in (mod as Record<string, unknown>)) {
        return { value: (mod as Record<string, unknown>)[symbolName], file: f };
      }
    } catch { /* skip broken modules */ }
  }
  return null;
}

/**
 * Verify a runtime value against a signature string. Returns a list of
 * issues (empty = pass). The signature dispatch is text-shape based:
 *   - leading `(` AND a `=>` later  → function signature
 *   - leading `{`                   → structural signature
 *   - otherwise                     → opaque; only existence is asserted
 */
export function checkSignature(value: unknown, signature: string): string[] {
  const sig = signature.trim();
  if (looksLikeFunction(sig)) return checkFunctionSignature(value, sig);
  if (sig.startsWith("{")) return checkStructuralSignature(value, sig);
  // Opaque signature (e.g. `string[]`, `Example`) — existence is all we can
  // assert here. Presence was already proven by locateExport.
  return [];
}

function looksLikeFunction(sig: string): boolean {
  // `(a: T, b: U) => R` — the leading param list followed by an arrow at
  // top-level depth. We don't require the arrow be the LAST top-level token;
  // a return type with `=>` inside (e.g. a callback) is fine because the
  // FIRST top-level `=>` after `(...)` is the function arrow.
  if (!sig.startsWith("(")) return false;
  // Find the matching close paren for the leading `(`
  const close = matchingClose(sig, 0);
  if (close === -1) return false;
  const tail = sig.slice(close + 1).trimStart();
  return tail.startsWith("=>") || tail.startsWith(":");
  // The `:` variant covers `(args): R` if anyone writes it; we treat both
  // as "function-shaped" because at runtime there's no difference.
}

function checkFunctionSignature(value: unknown, sig: string): string[] {
  const issues: string[] = [];
  if (typeof value !== "function") {
    issues.push(`signature declares function but export is ${typeof value}`);
    return issues;
  }
  // Arity check
  const close = matchingClose(sig, 0);
  const paramList = sig.slice(1, close);
  const declaredArity = countTopLevelParams(paramList);
  const actualArity = (value as Function).length;
  if (declaredArity !== actualArity) {
    issues.push(`arity mismatch: signature declares ${declaredArity} param(s), function has ${actualArity}`);
  }
  // Async check
  const returnText = sig.slice(close + 1);
  const looksAsync = /\bPromise\s*</.test(returnText);
  if (looksAsync) {
    const isAsyncFn = (value as Function).constructor?.name === "AsyncFunction";
    if (!isAsyncFn) {
      // Fallback: a non-async function is OK IF it returns a thenable. We
      // can't safely call arbitrary functions (side effects, required args)
      // — only attempt the smoke call when arity is 0.
      if (actualArity === 0) {
        try {
          const r = (value as () => unknown)();
          if (!isThenable(r)) {
            issues.push(`signature declares Promise return but function is sync (no .then on result)`);
          }
        } catch {
          // Threw on call — we can't tell. Don't claim a violation we
          // can't prove. The async-ness check stays unverified.
        }
      } else {
        issues.push(`signature declares Promise return but function is not AsyncFunction (arity ${actualArity} prevents safe smoke call)`);
      }
    }
  }
  return issues;
}

function isThenable(x: unknown): boolean {
  return x !== null && typeof x === "object" && typeof (x as { then?: unknown }).then === "function";
}

function checkStructuralSignature(value: unknown, sig: string): string[] {
  const issues: string[] = [];
  if (value === null || typeof value !== "object" && typeof value !== "function") {
    issues.push(`signature declares structural type but export is ${typeof value}`);
    return issues;
  }
  const close = matchingClose(sig, 0);
  if (close === -1) {
    issues.push(`unparseable structural signature: ${sig}`);
    return issues;
  }
  const body = sig.slice(1, close);
  const members = parseStructuralMembers(body);
  const v = value as Record<string, unknown>;
  for (const m of members) {
    if (!(m.name in v)) {
      issues.push(`structural member "${m.name}" missing on export`);
      continue;
    }
    if (m.callable && typeof v[m.name] !== "function") {
      issues.push(`structural member "${m.name}" declared as method but is ${typeof v[m.name]}`);
    }
    if (m.callable === false && typeof v[m.name] === "function") {
      issues.push(`structural member "${m.name}" declared as property but is a function`);
    }
  }
  return issues;
}

/**
 * Parse the body of a `{ ... }` structural type into its top-level members.
 * Each member is either `name(...)` (method) or `name:` / `name?:` (property).
 * Members are separated by `;`, `,`, or newlines at top-level depth.
 */
function parseStructuralMembers(body: string): Array<{ name: string; callable: boolean }> {
  const out: Array<{ name: string; callable: boolean }> = [];
  const chunks = splitTopLevel(body, [";", ",", "\n"]);
  for (const raw of chunks) {
    const chunk = raw.trim();
    if (!chunk) continue;
    // method: ident(...)
    const method = /^([A-Za-z_$][A-Za-z0-9_$]*)\s*[?!]?\s*\(/.exec(chunk);
    if (method) { out.push({ name: method[1], callable: true }); continue; }
    // property: ident: ...   or   ident?: ...
    const prop = /^([A-Za-z_$][A-Za-z0-9_$]*)\s*[?!]?\s*:/.exec(chunk);
    if (prop) {
      // Property could still be a function-typed property like `fn: () => void`.
      // We tag as "not callable" only when the type clearly isn't a function.
      // To keep this conservative, treat `: (...) =>` as callable too.
      const typeText = chunk.slice(prop[0].length).trim();
      const callable = /^\(/.test(typeText) && /=>/.test(typeText);
      out.push({ name: prop[1], callable });
      continue;
    }
    // bare ident — assume property
    const bare = /^([A-Za-z_$][A-Za-z0-9_$]*)\s*[?!]?$/.exec(chunk);
    if (bare) out.push({ name: bare[1], callable: false });
  }
  return out;
}

/** Split `s` on any of `delims` but only at top-level (paren/brace/angle depth 0). */
function splitTopLevel(s: string, delims: string[]): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  const delimSet = new Set(delims);
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "(" || c === "{" || c === "<") depth++;
    else if (c === ")" || c === "}" || c === ">") depth--;
    else if (depth === 0 && delimSet.has(c)) {
      parts.push(s.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(s.slice(start));
  return parts;
}

/** Count top-level params in a `(a, b, c)` list (just the inner text). */
function countTopLevelParams(paramList: string): number {
  const trimmed = paramList.trim();
  if (trimmed === "") return 0;
  return splitTopLevel(trimmed, [","]).filter(p => p.trim() !== "").length;
}

/** Return the index of the close bracket matching the open at `openIdx`, or -1. */
function matchingClose(s: string, openIdx: number): number {
  const open = s[openIdx];
  const close = open === "(" ? ")" : open === "{" ? "}" : open === "<" ? ">" : "";
  if (!close) return -1;
  let depth = 0;
  for (let i = openIdx; i < s.length; i++) {
    if (s[i] === open) depth++;
    else if (s[i] === close) { depth--; if (depth === 0) return i; }
  }
  return -1;
}

async function glob(dir: string, pattern: string): Promise<string[]> {
  const m = /^\*\.(.+)$/.exec(pattern);
  if (!m) return [];
  try {
    return (await readdir(dir)).filter(e => e.endsWith("." + m[1]));
  } catch { return []; }
}

function rel(dir: string, ctx: Ctx): string {
  const r = relative(ctx.root.diskPath, dir);
  return r === "" ? "." : r;
}
