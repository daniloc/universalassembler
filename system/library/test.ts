/**
 * test.ts — unit tests for the UA core library.
 *
 * Run: node --test system/library/test.ts
 *
 * Uses Node's built-in node:test — zero deps. Convention: each subassembly
 * with non-trivial logic gets a test.ts that registers its tests via test().
 * The `tests pass at every node` predicate runs them all.
 */

import "./test/init.ts";
import "./test/drift.ts";
import "./test/hooks.ts";
import test from "node:test";
import assert from "node:assert";
import { mkdtemp, writeFile, mkdir, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, IS_MAX_CHARS } from "#ua/parser.ts";
import { walk, findSpec, type SpecNode } from "#ua/walker.ts";
import {
  evaluate,
  evaluateSpec,
  verifyTree,
  bootstrapTree,
  primitives,
} from "#ua/primitives.ts";
import { renderTree, render } from "../subassemblies/Documents/system/library/render.ts";

// ── Fixture helpers ───────────────────────────────────────────────────────

/** Write a fixture spec tree to a temp dir, return cleanup. */
async function fixtureTree(layout: Record<string, string>): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "ua-test-"));
  for (const [path, content] of Object.entries(layout)) {
    const full = join(root, path);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, content);
  }
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

/** Minimal spec template — caller supplies just the name + body. */
function spec(name: string, body = ""): string {
  return `spec ${name} {\n  is "${name} fixture"\n  ${body}\n}`;
}


test("parser: minimal spec", () => {
  const s = parse('spec Foo { is "minimal" }');
  assert.equal(s.name, "Foo");
  assert.equal(s.is, "minimal");
  assert.deepEqual(s.worksWhen, []);
  assert.deepEqual(s.subassemblies, []);
  assert.deepEqual(s.verbs, []);
  assert.deepEqual(s.uses, []);
  assert.deepEqual(s.outputs, []);
});

test("parser: rejects spec without spec keyword", () => {
  assert.throws(() => parse('Foo { is "x" }'), /not a spec/);
});

test("parser: enforces is max 140 chars", () => {
  const long = "a".repeat(IS_MAX_CHARS + 1);
  assert.throws(() => parse(`spec X { is "${long}" }`), /max 140/);
});

test("parser: collapses whitespace in is", () => {
  const s = parse('spec X { is "a\n     b\n     c" }');
  assert.equal(s.is, "a b c");
});

test("parser: works when block captures predicate lines verbatim", () => {
  const src = `spec X {
    is "x"
    works when {
      foo exists at every node
      bar absent at root
    }
  }`;
  const s = parse(src);
  assert.deepEqual(s.worksWhen, ["foo exists at every node", "bar absent at root"]);
});

test("parser: subassemblies bare and with roles", () => {
  const s = parse(`spec X {
    is "x"
    subassemblies {
      Bare
      WithRole: "role text"
    }
  }`);
  assert.deepEqual(s.subassemblies, [
    { name: "Bare", role: undefined },
    { name: "WithRole", role: "role text" },
  ]);
});

test("parser: verbs with exports clause", () => {
  const s = parse(`spec X {
    is "x"
    verbs {
      start:     "run it"
      bootstrap: "hook" exports bootstrap
      verify              exports verify
    }
  }`);
  assert.deepEqual(s.verbs, [
    { name: "start", role: "run it", exports: undefined },
    { name: "bootstrap", role: "hook", exports: "bootstrap" },
    { name: "verify", role: undefined, exports: "verify" },
  ]);
});

test("parser: uses block — bare names and dotted paths", () => {
  const s = parse(`spec X {
    is "x"
    uses {
      Runtime
      Packages.Styles
      Apps.NG.Routes.PostDetail
    }
  }`);
  assert.deepEqual(s.uses, ["Runtime", "Packages.Styles", "Apps.NG.Routes.PostDetail"]);
});

test("parser: outputs block — identifiers, dotted, and paths", () => {
  const s = parse(`spec X {
    is "x"
    outputs {
      renderTree:    "(root) => string"
      _tokens.scss:  "design tokens"
      dist/:         "build artifact"
      ENTRIES:       "Array<Entry>"
    }
  }`);
  // Untagged entries default to category "module" (backward compat).
  assert.deepEqual(s.outputs, [
    { name: "renderTree",   category: "module", role: "(root) => string" },
    { name: "_tokens.scss", category: "module", role: "design tokens" },
    { name: "dist/",        category: "module", role: "build artifact" },
    { name: "ENTRIES",      category: "module", role: "Array<Entry>" },
  ]);
});

test("parser: outputs — mixed typed and untyped entries (backward compat)", () => {
  // The whole point of `::`: opt-in. Existing untyped entries coexist with
  // typed ones in the same block, no migration required.
  const s = parse(`spec X {
    is "x"
    outputs {
      legacy
      roleOnly:     "old style"
      typedSchema                                              :: { tables: string[] }
      typedStore:   "query functions"                          :: { listExamples(): Example[]; insertExample(name: string): number }
    }
  }`);
  assert.equal(s.outputs.length, 4);
  assert.deepEqual(s.outputs[0], { name: "legacy",   category: "module", role: undefined });
  assert.deepEqual(s.outputs[1], { name: "roleOnly", category: "module", role: "old style" });
  assert.equal(s.outputs[2].name, "typedSchema");
  assert.equal(s.outputs[2].signature, "{ tables: string[] }");
  assert.equal(s.outputs[3].name, "typedStore");
  assert.equal(s.outputs[3].role, "query functions");
  assert.equal(
    s.outputs[3].signature,
    "{ listExamples(): Example[]; insertExample(name: string): number }",
  );
});

test("parser: outputs — signatures captured verbatim with generics, arrows, structurals", () => {
  // The verifier doesn't parse TS — it holds the string. Verify every shape
  // the substrate is likely to see makes it through untouched.
  const s = parse(`spec X {
    is "x"
    outputs {
      fn                                :: (node: SpecNode, ctx: Ctx) => Promise<BootstrapResult>
      generic                           :: Map<string, Array<number>>
      nested                            :: { inner: { deeper: () => void } }
      withExports: "the hook" exports bootstrap :: (n: SpecNode) => Promise<void>
    }
  }`);
  assert.equal(s.outputs[0].signature, "(node: SpecNode, ctx: Ctx) => Promise<BootstrapResult>");
  assert.equal(s.outputs[1].signature, "Map<string, Array<number>>");
  assert.equal(s.outputs[2].signature, "{ inner: { deeper: () => void } }");
  assert.equal(s.outputs[3].name, "withExports");
  assert.equal(s.outputs[3].role, "the hook");
  assert.equal(s.outputs[3].exports, "bootstrap");
  assert.equal(s.outputs[3].signature, "(n: SpecNode) => Promise<void>");
});

test("parser: outputs — multi-line signature is folded into one entry", () => {
  // Long signatures should wrap. Continuation is driven by unbalanced
  // brackets — a logical entry isn't done until ( { < all close.
  const s = parse(`spec X {
    is "x"
    outputs {
      complex :: {
        listExamples(limit: number): Example[];
        insertExample(name: string): number;
      }
      simple :: () => void
    }
  }`);
  assert.equal(s.outputs.length, 2);
  assert.equal(s.outputs[0].name, "complex");
  assert.match(s.outputs[0].signature ?? "", /listExamples/);
  assert.match(s.outputs[0].signature ?? "", /insertExample/);
  assert.equal(s.outputs[1].name, "simple");
  assert.equal(s.outputs[1].signature, "() => void");
});

test("parser: outputs — untyped block parses identically to pre-:: era (regression)", () => {
  // The exact assertion shape from the existing test, copied to lock in
  // that the new code path is a no-op when no `::` appears anywhere.
  const s = parse(`spec X {
    is "x"
    outputs {
      renderTree:    "(root) => string"
      _tokens.scss:  "design tokens"
      dist/:         "build artifact"
      ENTRIES:       "Array<Entry>"
    }
  }`);
  // signature field absent on every entry — not even undefined-keys leak through.
  for (const o of s.outputs) {
    assert.equal("signature" in o, false, `${o.name} should have no signature key`);
  }
});

// ── outputs: category-tagged grammar (verb | module | file | resource) ───
// Four categories with different resolution strategies in the verifier.
// Backward compat: bare/untagged entries default to "module".

test("parser: outputs — category tags (verb, module, file, resource)", () => {
  const s = parse(`spec X {
    is "x"
    outputs {
      verb start :: (port?: number) => Promise<void>
      verb bootstrap :: (n, c) => Promise<BootstrapResult>
      module loadConfig :: () => Config
      module Store :: { listExamples(): Example[] }
      file dist/
      file _tokens.scss
      resource spec://tree
      resource ua://spec/tree
    }
  }`);
  assert.equal(s.outputs.length, 8);
  assert.equal(s.outputs[0].category, "verb");
  assert.equal(s.outputs[0].name, "start");
  assert.equal(s.outputs[1].category, "verb");
  assert.equal(s.outputs[2].category, "module");
  assert.equal(s.outputs[2].name, "loadConfig");
  assert.equal(s.outputs[3].category, "module");
  assert.equal(s.outputs[4].category, "file");
  assert.equal(s.outputs[4].name, "dist/");
  assert.equal(s.outputs[5].category, "file");
  assert.equal(s.outputs[5].name, "_tokens.scss");
  assert.equal(s.outputs[6].category, "resource");
  assert.equal(s.outputs[6].name, "spec://tree");
  assert.equal(s.outputs[7].category, "resource");
  assert.equal(s.outputs[7].name, "ua://spec/tree");
});

test("parser: outputs — untagged entries default to module (backward compat)", () => {
  // Pre-category specs keep parsing. Every untagged entry carries category=module.
  const s = parse(`spec X {
    is "x"
    outputs {
      schema
      store: "queries"
      typed :: () => void
    }
  }`);
  for (const o of s.outputs) {
    assert.equal(o.category, "module", `${o.name} should default to module`);
  }
});

test("primitives: declared outputs are present — verb category requires file + export", async () => {
  const { root, cleanup } = await fixtureTree({
    "Root.spec": spec("Root", `
      works when { declared outputs are present }
      outputs { verb start :: () => Promise<void> }
    `),
    "system/library/start.ts": `export async function start(): Promise<void> {}`,
  });
  try {
    const node = await walk(root);
    const sigs = await evaluateSpec(node, { root: node });
    assert.equal(sigs[0].kind, "pass", `expected pass, got: ${sigs[0].detail}`);
  } finally { await cleanup(); }
});

test("primitives: declared outputs are present — verb category fails when export missing", async () => {
  const { root, cleanup } = await fixtureTree({
    "Root.spec": spec("Root", `
      works when { declared outputs are present }
      outputs { verb start :: () => Promise<void> }
    `),
    // File exists but doesn't export `start`.
    "system/library/start.ts": `export const other = 1;`,
  });
  try {
    const node = await walk(root);
    const sigs = await evaluateSpec(node, { root: node });
    assert.equal(sigs[0].kind, "fail");
    assert.match(sigs[0].detail ?? "", /missing export start/);
  } finally { await cleanup(); }
});

test("primitives: declared outputs are present — file category checks disk path", async () => {
  const { root, cleanup } = await fixtureTree({
    "Root.spec": spec("Root", `
      works when { declared outputs are present }
      outputs {
        file _tokens.scss
        file dist/
      }
    `),
    "system/library/_tokens.scss": "$x: 1;",
    "dist/index.html": "<html></html>",
  });
  try {
    const node = await walk(root);
    const sigs = await evaluateSpec(node, { root: node });
    assert.equal(sigs[0].kind, "pass", `expected pass, got: ${sigs[0].detail}`);
  } finally { await cleanup(); }
});

test("primitives: declared outputs are present — file category fails when missing", async () => {
  const { root, cleanup } = await fixtureTree({
    "Root.spec": spec("Root", `
      works when { declared outputs are present }
      outputs { file ghost.json }
    `),
  });
  try {
    const node = await walk(root);
    const sigs = await evaluateSpec(node, { root: node });
    assert.equal(sigs[0].kind, "fail");
    assert.match(sigs[0].detail ?? "", /ghost\.json/);
  } finally { await cleanup(); }
});

test("primitives: declared outputs are present — resource category is always satisfied", async () => {
  // resource outputs are runtime URIs. No on-disk check possible — the
  // primitive accepts them and signature shape checks skip them too.
  const { root, cleanup } = await fixtureTree({
    "Root.spec": spec("Root", `
      works when { declared outputs are present }
      outputs { resource ua://spec/tree }
    `),
  });
  try {
    const node = await walk(root);
    const sigs = await evaluateSpec(node, { root: node });
    assert.equal(sigs[0].kind, "pass");
  } finally { await cleanup(); }
});

test("primitives: declared outputs are present — module category locates by export scan", async () => {
  const { root, cleanup } = await fixtureTree({
    "Root.spec": spec("Root", `
      works when { declared outputs are present }
      outputs { module renderTree }
    `),
    // export lives in a differently-named file — the module resolver scans.
    "system/library/render.ts": `export function renderTree() { return ""; }`,
  });
  try {
    const node = await walk(root);
    const sigs = await evaluateSpec(node, { root: node });
    assert.equal(sigs[0].kind, "pass", `expected pass, got: ${sigs[0].detail}`);
  } finally { await cleanup(); }
});

test("primitives: outputs match declared signatures — file/resource entries are skipped", async () => {
  // file and resource categories have no runtime value to introspect, so a
  // signature on either is ignored (not failed). The presence-of-file check
  // covers what we can know.
  const { root, cleanup } = await fixtureTree({
    "Root.spec": spec("Root", `
      works when { outputs match declared signatures }
      outputs {
        file _tokens.scss
        resource ua://spec/tree
      }
    `),
  });
  try {
    const node = await walk(root);
    const sigs = await evaluateSpec(node, { root: node });
    assert.equal(sigs[0].kind, "pass");
  } finally { await cleanup(); }
});

test("parser: tolerates pre-spec comments", () => {
  const src = `// this is a header comment
// even multiple lines

spec Foo { is "x" }`;
  const s = parse(src);
  assert.equal(s.name, "Foo");
});

test("parser: lineage — full block parses every field", () => {
  const src = `// LINEAGE
//   template:     almanac/MCPServerHttp
//   ua_version:   abc1234
//   instantiated: 2026-06-07T19:34:56Z
//   variables:    { "NAME": "ContentMcp", "PORT": "4040" }
//   parent_spec:  ../Parent.spec
//
// Lineage is descriptive metadata; the verifier ignores it.

spec ContentMcp { is "x" }`;
  const s = parse(src);
  assert.ok(s.lineage, "lineage should be set");
  assert.equal(s.lineage!.template, "almanac/MCPServerHttp");
  assert.equal(s.lineage!.ua_version, "abc1234");
  assert.equal(s.lineage!.instantiated, "2026-06-07T19:34:56Z");
  assert.deepEqual(s.lineage!.variables, { NAME: "ContentMcp", PORT: "4040" });
  assert.equal(s.lineage!.parent_spec, "../Parent.spec");
});

test("parser: lineage — partial block keeps present fields, others undefined", () => {
  const src = `// LINEAGE
//   template:    almanac/CLITool
//   instantiated: 2026-06-07T00:00:00Z

spec Foo { is "x" }`;
  const s = parse(src);
  assert.ok(s.lineage);
  assert.equal(s.lineage!.template, "almanac/CLITool");
  assert.equal(s.lineage!.instantiated, "2026-06-07T00:00:00Z");
  assert.equal(s.lineage!.ua_version, undefined);
  assert.equal(s.lineage!.variables, undefined);
  assert.equal(s.lineage!.parent_spec, undefined);
});

test("parser: lineage — absent block leaves lineage undefined", () => {
  const s = parse('spec Foo { is "x" }');
  assert.equal(s.lineage, undefined);
});

test("parser: lineage — malformed block doesn't throw, degrades to undefined", () => {
  // Header present, but no field lines and bad variables JSON — should
  // gracefully degrade without breaking spec parsing.
  const src = `// LINEAGE
//   variables: { not valid json at all }

spec Foo { is "x" }`;
  const s = parse(src);
  assert.equal(s.name, "Foo");
  // No usable fields extracted → undefined.
  assert.equal(s.lineage, undefined);
});

test("parser: empty blocks are valid", () => {
  const s = parse(`spec X {
    is "x"
    works when {}
    subassemblies {}
    verbs {}
    uses {}
    outputs {}
  }`);
  assert.equal(s.name, "X");
});

test("parser: outputs block tolerates braces inside structural signatures", () => {
  // Regression: the prior flat `\{([\s\S]*?)\}` terminated at the first close
  // brace, truncating the outputs block if any signature contained `{ ... }`.
  // Balanced-brace tracking must keep the whole block intact.
  const s = parse(`spec X {
    is "x"
    outputs {
      typedA :: { tables: string[] }
      typedB :: { nested: { deeper: number } }
      plain
    }
    verbs { run: "go" }
  }`);
  assert.equal(s.outputs.length, 3);
  assert.equal(s.outputs[0].name, "typedA");
  assert.equal(s.outputs[1].name, "typedB");
  assert.equal(s.outputs[2].name, "plain");
  // And the verbs block (which comes after) must still be reachable —
  // proving the parser didn't stop at an interior `}` from a signature.
  assert.deepEqual(s.verbs, [{ name: "run", role: "go", exports: undefined }]);
});

test("parser: uses accepts comma-separated single-line form", () => {
  // network-games-svelte and similar projects write `uses` on one line.
  // Both newline AND comma must split entries.
  const s = parse(`spec X {
    is "x"
    uses { Runtime, Packages.OG, Packages.TimelineContent }
  }`);
  assert.deepEqual(s.uses, ["Runtime", "Packages.OG", "Packages.TimelineContent"]);
});

test("parser: subassemblies and verbs accept comma-separated single-line form", () => {
  const s = parse(`spec X {
    is "x"
    subassemblies { Alpha, Beta: "with role", Gamma }
    verbs { start, stop: "halt it", test exports test }
  }`);
  assert.deepEqual(s.subassemblies, [
    { name: "Alpha", role: undefined },
    { name: "Beta", role: "with role" },
    { name: "Gamma", role: undefined },
  ]);
  assert.deepEqual(s.verbs, [
    { name: "start", role: undefined, exports: undefined },
    { name: "stop", role: "halt it", exports: undefined },
    { name: "test", role: undefined, exports: "test" },
  ]);
});

test("parser: mixed newline + comma separators inside a single block", () => {
  const s = parse(`spec X {
    is "x"
    uses {
      Runtime, Packages.OG
      Packages.TimelineContent
    }
  }`);
  assert.deepEqual(s.uses, ["Runtime", "Packages.OG", "Packages.TimelineContent"]);
});

// ── Walker ────────────────────────────────────────────────────────────────

test("walker: walks a single root with no subassemblies", async () => {
  const { root, cleanup } = await fixtureTree({
    "Root.spec": spec("Root"),
  });
  try {
    const node = await walk(root);
    assert.equal(node.spec.name, "Root");
    assert.equal(node.subassemblies.length, 0);
  } finally { await cleanup(); }
});

test("walker: detects schematic subassembly when folder is missing", async () => {
  const { root, cleanup } = await fixtureTree({
    "Root.spec": spec("Root", `subassemblies { Missing: "frontier" }`),
  });
  try {
    const node = await walk(root);
    assert.equal(node.subassemblies.length, 1);
    const sub = node.subassemblies[0];
    assert.ok("schematic" in sub);
    assert.equal((sub as { name: string }).name, "Missing");
  } finally { await cleanup(); }
});

test("walker: recurses into elaborated subassembly", async () => {
  const { root, cleanup } = await fixtureTree({
    "Root.spec": spec("Root", `subassemblies { Child }`),
    "system/subassemblies/Child/Child.spec": spec("Child"),
  });
  try {
    const node = await walk(root);
    assert.equal(node.subassemblies.length, 1);
    const child = node.subassemblies[0] as SpecNode;
    assert.equal(child.spec.name, "Child");
    assert.ok(!("schematic" in child));
  } finally { await cleanup(); }
});

test("walker: findSpec rejects two .spec files in one node", async () => {
  const { root, cleanup } = await fixtureTree({
    "First.spec":  spec("First"),
    "Second.spec": spec("Second"),
  });
  try {
    await assert.rejects(() => findSpec(root), /expected one \*\.spec/);
  } finally { await cleanup(); }
});

test("walker: throws when no .spec in folder", async () => {
  const { root, cleanup } = await fixtureTree({ "irrelevant.txt": "" });
  try {
    await assert.rejects(() => walk(root), /no \*\.spec/);
  } finally { await cleanup(); }
});

// ── Primitives ────────────────────────────────────────────────────────────

test("primitives: evaluate returns 'unverified' for unknown predicate", async () => {
  const { root, cleanup } = await fixtureTree({ "Root.spec": spec("Root") });
  try {
    const node = await walk(root);
    const sig = await evaluate("totally fictional predicate", { root: node });
    assert.equal(sig.kind, "unverified");
  } finally { await cleanup(); }
});

test("primitives: exists at root — passes when file present", async () => {
  const { root, cleanup } = await fixtureTree({
    "Root.spec": spec("Root", `works when { needle exists at root }`),
    "needle": "x",
  });
  try {
    const node = await walk(root);
    const sigs = await evaluateSpec(node, { root: node });
    assert.equal(sigs[0].kind, "pass");
  } finally { await cleanup(); }
});

test("primitives: exists at root — fails when missing, names the path", async () => {
  const { root, cleanup } = await fixtureTree({
    "Root.spec": spec("Root", `works when { missing exists at root }`),
  });
  try {
    const node = await walk(root);
    const sigs = await evaluateSpec(node, { root: node });
    assert.equal(sigs[0].kind, "fail");
    assert.match(sigs[0].detail ?? "", /missing/);
  } finally { await cleanup(); }
});

test("primitives: absent at root — passes when absent", async () => {
  const { root, cleanup } = await fixtureTree({
    "Root.spec": spec("Root", `works when { CLAUDE.md absent at root }`),
  });
  try {
    const node = await walk(root);
    const sigs = await evaluateSpec(node, { root: node });
    assert.equal(sigs[0].kind, "pass");
  } finally { await cleanup(); }
});

test("primitives: exists at this node — resolves to spec's own dir", async () => {
  const { root, cleanup } = await fixtureTree({
    "Root.spec": spec("Root", `subassemblies { Child }`),
    "system/subassemblies/Child/Child.spec": spec("Child", `works when { local.txt exists at this node }`),
    "system/subassemblies/Child/local.txt": "x",
  });
  try {
    const node = await walk(root);
    const tree = await verifyTree(node, { root: node });
    const childSigs = tree.children[0].signals;
    assert.equal(childSigs[0].kind, "pass", `expected pass, got ${childSigs[0].kind}: ${childSigs[0].detail}`);
  } finally { await cleanup(); }
});

test("primitives: spec.tree mirrors directory.tree — ignores dotfiles", async () => {
  const { root, cleanup } = await fixtureTree({
    "Root.spec": spec("Root", `works when { spec.tree mirrors directory.tree }`),
    "system/subassemblies/.DS_Store": "noise",  // would have failed before #5
  });
  try {
    const node = await walk(root);
    const sigs = await evaluateSpec(node, { root: node });
    assert.equal(sigs[0].kind, "pass", `dotfile leaked: ${sigs[0].detail}`);
  } finally { await cleanup(); }
});

test("primitives: spec.tree mirrors directory.tree — flags real orphan folder", async () => {
  const { root, cleanup } = await fixtureTree({
    "Root.spec": spec("Root", `works when { spec.tree mirrors directory.tree }`),
    "system/subassemblies/Orphan/something.txt": "undeclared",
  });
  try {
    const node = await walk(root);
    const sigs = await evaluateSpec(node, { root: node });
    assert.equal(sigs[0].kind, "fail");
    assert.match(sigs[0].detail ?? "", /Orphan/);
  } finally { await cleanup(); }
});

test("primitives: spec.tree mirrors directory.tree --strict — dotfiles count as orphans", async () => {
  // Opt-in strict mode preserves the pre-tolerance behavior. Useful for
  // projects that want zero tolerance under system/subassemblies.
  const { root, cleanup } = await fixtureTree({
    "Root.spec": spec("Root", `works when { spec.tree mirrors directory.tree --strict }`),
    "system/subassemblies/.DS_Store": "noise",
  });
  try {
    const node = await walk(root);
    const sigs = await evaluateSpec(node, { root: node });
    assert.equal(sigs[0].kind, "fail", "strict mode should flag dotfiles");
    assert.match(sigs[0].detail ?? "", /\.DS_Store/);
  } finally { await cleanup(); }
});

test("primitives: declared uses are satisfied — passes when ref exists", async () => {
  const { root, cleanup } = await fixtureTree({
    "Root.spec": `spec Root {
  is "fixture"
  works when {
    declared uses are satisfied
  }
  subassemblies {
    A
    B
  }
  uses {
    B
  }
}`,
    "system/subassemblies/A/A.spec": spec("A"),
    "system/subassemblies/B/B.spec": spec("B"),
  });
  try {
    const node = await walk(root);
    const sigs = await evaluateSpec(node, { root: node });
    assert.equal(sigs[0].kind, "pass", `expected pass, got ${sigs[0].kind}: ${sigs[0].detail}`);
  } finally { await cleanup(); }
});

test("primitives: declared uses are satisfied — fails on phantom reference", async () => {
  const { root, cleanup } = await fixtureTree({
    "Root.spec": spec("Root", `works when { declared uses are satisfied } uses { Phantom }`),
  });
  try {
    const node = await walk(root);
    const sigs = await evaluateSpec(node, { root: node });
    assert.equal(sigs[0].kind, "fail");
    assert.match(sigs[0].detail ?? "", /Phantom/);
  } finally { await cleanup(); }
});

test("primitives: declared outputs are present — passes for existing file", async () => {
  const { root, cleanup } = await fixtureTree({
    "Root.spec": spec("Root", `works when { declared outputs are present } outputs { config.json: "settings" }`),
    "system/library/config.json": "{}",
  });
  try {
    const node = await walk(root);
    const sigs = await evaluateSpec(node, { root: node });
    assert.equal(sigs[0].kind, "pass");
  } finally { await cleanup(); }
});

test("primitives: declared outputs are present — fails on phantom output", async () => {
  const { root, cleanup } = await fixtureTree({
    "Root.spec": spec("Root", `works when { declared outputs are present } outputs { GhostFunc }`),
  });
  try {
    const node = await walk(root);
    const sigs = await evaluateSpec(node, { root: node });
    assert.equal(sigs[0].kind, "fail");
    assert.match(sigs[0].detail ?? "", /GhostFunc/);
  } finally { await cleanup(); }
});

// ── outputs match declared signatures ────────────────────────────────────
// One pair per shape we claim to verify: function arity, missing export,
// async mismatch, structural members. The negative cases prove the
// primitive can actually catch violations — without them the primitive
// could vacuously "pass" and we'd never notice.

test("primitives: outputs match declared signatures — function with matching arity passes", async () => {
  const { root, cleanup } = await fixtureTree({
    "Root.spec": spec("Root", `
      works when { outputs match declared signatures }
      outputs { greet :: (name: string) => string }
    `),
    "system/library/greet.ts": `export function greet(name: string): string { return "hi " + name; }`,
  });
  try {
    const node = await walk(root);
    const sigs = await evaluateSpec(node, { root: node });
    assert.equal(sigs[0].kind, "pass", `expected pass, got: ${sigs[0].detail}`);
  } finally { await cleanup(); }
});

test("primitives: outputs match declared signatures — missing export fails", async () => {
  const { root, cleanup } = await fixtureTree({
    "Root.spec": spec("Root", `
      works when { outputs match declared signatures }
      outputs { greet :: (name: string) => string }
    `),
    // No greet.ts at all — and library/ exists but is empty
    "system/library/other.ts": `export const other = 1;`,
  });
  try {
    const node = await walk(root);
    const sigs = await evaluateSpec(node, { root: node });
    assert.equal(sigs[0].kind, "fail");
    assert.match(sigs[0].detail ?? "", /not found/);
  } finally { await cleanup(); }
});

test("primitives: outputs match declared signatures — wrong arity fails", async () => {
  const { root, cleanup } = await fixtureTree({
    "Root.spec": spec("Root", `
      works when { outputs match declared signatures }
      outputs { greet :: (first: string, second: string) => string }
    `),
    "system/library/greet.ts": `export function greet(name: string): string { return name; }`,
  });
  try {
    const node = await walk(root);
    const sigs = await evaluateSpec(node, { root: node });
    assert.equal(sigs[0].kind, "fail");
    assert.match(sigs[0].detail ?? "", /arity/);
  } finally { await cleanup(); }
});

test("primitives: outputs match declared signatures — async signature, sync export fails", async () => {
  const { root, cleanup } = await fixtureTree({
    "Root.spec": spec("Root", `
      works when { outputs match declared signatures }
      outputs { fetchIt :: () => Promise<string> }
    `),
    // Synchronous function returning a plain string — should fail the
    // Promise-return assertion. Arity 0 so the smoke call path runs.
    "system/library/fetchIt.ts": `export function fetchIt(): string { return "nope"; }`,
  });
  try {
    const node = await walk(root);
    const sigs = await evaluateSpec(node, { root: node });
    assert.equal(sigs[0].kind, "fail");
    assert.match(sigs[0].detail ?? "", /Promise|sync/i);
  } finally { await cleanup(); }
});

test("primitives: outputs match declared signatures — async signature, async export passes", async () => {
  const { root, cleanup } = await fixtureTree({
    "Root.spec": spec("Root", `
      works when { outputs match declared signatures }
      outputs { fetchIt :: () => Promise<string> }
    `),
    "system/library/fetchIt.ts": `export async function fetchIt(): Promise<string> { return "ok"; }`,
  });
  try {
    const node = await walk(root);
    const sigs = await evaluateSpec(node, { root: node });
    assert.equal(sigs[0].kind, "pass", `expected pass, got: ${sigs[0].detail}`);
  } finally { await cleanup(); }
});

test("primitives: outputs match declared signatures — structural members verified", async () => {
  const { root, cleanup } = await fixtureTree({
    "Root.spec": spec("Root", `
      works when { outputs match declared signatures }
      outputs {
        store :: { listExamples(): unknown[]; insertExample(name: string): number }
      }
    `),
    "system/library/store.ts": `
      export const store = {
        listExamples() { return []; },
        insertExample(name: string) { return 1; },
      };
    `,
  });
  try {
    const node = await walk(root);
    const sigs = await evaluateSpec(node, { root: node });
    assert.equal(sigs[0].kind, "pass", `expected pass, got: ${sigs[0].detail}`);
  } finally { await cleanup(); }
});

test("primitives: outputs match declared signatures — structural member missing fails", async () => {
  const { root, cleanup } = await fixtureTree({
    "Root.spec": spec("Root", `
      works when { outputs match declared signatures }
      outputs {
        store :: { listExamples(): unknown[]; insertExample(name: string): number }
      }
    `),
    "system/library/store.ts": `
      export const store = { listExamples() { return []; } };
    `,
  });
  try {
    const node = await walk(root);
    const sigs = await evaluateSpec(node, { root: node });
    assert.equal(sigs[0].kind, "fail");
    assert.match(sigs[0].detail ?? "", /insertExample/);
  } finally { await cleanup(); }
});

test("primitives: outputs match declared signatures — untyped outputs are skipped", async () => {
  // The default-untyped path. Nothing to check; nothing to fail. The
  // existing `declared outputs are present` primitive carries the floor.
  const { root, cleanup } = await fixtureTree({
    "Root.spec": spec("Root", `
      works when { outputs match declared signatures }
      outputs { somethingUntyped: "no signature" }
    `),
    // somethingUntyped doesn't even exist — but it shouldn't matter, since
    // this primitive only verifies entries with `::`.
  });
  try {
    const node = await walk(root);
    const sigs = await evaluateSpec(node, { root: node });
    assert.equal(sigs[0].kind, "pass");
  } finally { await cleanup(); }
});

test("primitives: outputs match declared signatures — exports clause re-targets the symbol", async () => {
  // Output named X, but `exports realName` means the verifier should look up
  // realName, not X. Mirrors the verb hook pattern.
  const { root, cleanup } = await fixtureTree({
    "Root.spec": spec("Root", `
      works when { outputs match declared signatures }
      outputs { bootstrap: "ensure schema" exports doBootstrap :: () => Promise<void> }
    `),
    "system/library/bootstrap.ts": `export async function doBootstrap(): Promise<void> {}`,
  });
  try {
    const node = await walk(root);
    const sigs = await evaluateSpec(node, { root: node });
    assert.equal(sigs[0].kind, "pass", `expected pass, got: ${sigs[0].detail}`);
  } finally { await cleanup(); }
});

test("primitives: registry shape — every primitive has match + check", () => {
  for (const p of primitives) {
    assert.ok(p.match instanceof RegExp, "match should be RegExp");
    assert.equal(typeof p.check, "function", "check should be a function");
  }
  assert.ok(primitives.length >= 10, `expected ≥10 primitives, got ${primitives.length}`);
});

// ── Bootstrap orchestrator ────────────────────────────────────────────────

test("bootstrap: container without bootstrap.ts default-recurses to children", async () => {
  const { root, cleanup } = await fixtureTree({
    "Root.spec": spec("Root", `subassemblies { Child }`),
    "system/subassemblies/Child/Child.spec": spec("Child"),
  });
  try {
    const node = await walk(root);
    const result = await bootstrapTree(node, { root: node });
    // Children should be reached even though Root has no bootstrap.ts.
    assert.equal(result.children.length, 1);
    assert.equal(result.children[0].node.spec.name, "Child");
    // Root status is "skipped" but children are populated — that's propagateTree.
    assert.equal(result.status, "skipped");
  } finally { await cleanup(); }
});

test("bootstrap: schematic children are NOT recursed into", async () => {
  const { root, cleanup } = await fixtureTree({
    "Root.spec": spec("Root", `subassemblies { NotYet: "schematic" }`),
  });
  try {
    const node = await walk(root);
    const result = await bootstrapTree(node, { root: node });
    assert.equal(result.children.length, 0);
  } finally { await cleanup(); }
});

// ── Renderer ──────────────────────────────────────────────────────────────

test("render: renderTree emits valid HTML with root name", async () => {
  const { root, cleanup } = await fixtureTree({
    "Root.spec": spec("Root"),
  });
  try {
    const node = await walk(root);
    const html = renderTree(node);
    assert.match(html, /<!doctype html>/i);
    assert.match(html, /<h1>Root<\/h1>/);
    assert.match(html, /Root fixture/);
  } finally { await cleanup(); }
});

test("render: schematic subassembly gets ✎ glyph CSS class", async () => {
  const { root, cleanup } = await fixtureTree({
    "Root.spec": spec("Root", `subassemblies { Stub: "frontier" }`),
  });
  try {
    const node = await walk(root);
    const html = renderTree(node);
    assert.match(html, /class="schematic"/);
    assert.match(html, /Stub/);
    assert.match(html, /frontier/);
  } finally { await cleanup(); }
});

test("render: per-node render() includes is and breadcrumbs for child", async () => {
  const { root, cleanup } = await fixtureTree({
    "Root.spec": spec("Root", `subassemblies { Child }`),
    "system/subassemblies/Child/Child.spec": spec("Child"),
  });
  try {
    const node = await walk(root);
    const child = node.subassemblies[0] as SpecNode;
    const html = render(child, "/Child");
    assert.match(html, /<h1>Child<\/h1>/);
    assert.match(html, /<nav class="crumbs"/);
    assert.match(html, /Child fixture/);
  } finally { await cleanup(); }
});

test("render: escapes HTML in spec content", async () => {
  const { root, cleanup } = await fixtureTree({
    "Root.spec": `spec Root {\n  is "<script>alert(1)</script>"\n}`,
  });
  try {
    const node = await walk(root);
    const html = renderTree(node);
    assert.doesNotMatch(html, /<script>alert/);  // not present literal
    assert.match(html, /&lt;script&gt;/);          // escaped
  } finally { await cleanup(); }
});

// ── Drift ─────────────────────────────────────────────────────────────────

import drift from "#ua/drift.ts";

test("drift: clean fixture reports no drift (exit 0)", async () => {
  const { root, cleanup } = await fixtureTree({ "Root.spec": spec("Root") });
  try { assert.equal(await drift({ at: root, json: true }), 0); } finally { await cleanup(); }
});
