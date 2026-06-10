/**
 * test/init.ts — tool-level integration tests for init.ts
 *
 * Each test exercises the CLI by spawning `node system/library/init.ts` against
 * a fresh tmp dir. These are slow-ish (real filesystem writes + child process
 * spawn), but they're the only way to assert the seed actually produces a
 * project that bootstrap can verify.
 */

import test from "node:test";
import assert from "node:assert";
import { mkdtemp, writeFile, mkdir, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const UA_ROOT = new URL("../../..", import.meta.url).pathname.replace(/\/$/, "");
const INIT_TS = join(UA_ROOT, "system/library/init.ts");

/** Run a CLI verb, capture { code, stdout, stderr }. */
function run(cmd: string, args: string[], cwd: string): Promise<{code: number; stdout: string; stderr: string}> {
  return new Promise(resolve => {
    const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", c => stdout += c);
    child.stderr.on("data", c => stderr += c);
    child.on("close", code => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

async function pathExists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}

async function freshTmp(label: string): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), `ua-init-${label}-`));
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

// ── Happy path ────────────────────────────────────────────────────────────

test("init: creates ./Foo/ with spec + system/library + system/subassemblies + package.json + tsconfig", async () => {
  const { root, cleanup } = await freshTmp("happy-create");
  try {
    const result = await run("node", [INIT_TS, "Foo"], root);
    assert.equal(result.code, 0, `init failed: ${result.stderr}`);
    const proj = join(root, "Foo");
    assert.ok(await pathExists(proj), "project dir not created");
    assert.ok(await pathExists(join(proj, "Foo.spec")), "Foo.spec missing");
    assert.ok(await pathExists(join(proj, "system/library")), "system/library missing");
    assert.ok(await pathExists(join(proj, "system/subassemblies")), "system/subassemblies missing");
    assert.ok(await pathExists(join(proj, "package.json")), "package.json missing");
    assert.ok(await pathExists(join(proj, "tsconfig.json")), "tsconfig.json missing");
  } finally { await cleanup(); }
});

test("init: seed is self-verifying — bootstrap exits 0 (slow)", async () => {
  const { root, cleanup } = await freshTmp("happy-bootstrap");
  try {
    const init = await run("node", [INIT_TS, "Foo"], root);
    assert.equal(init.code, 0, `init failed: ${init.stderr}`);
    const proj = join(root, "Foo");
    const boot = await run("node", [join(proj, "system/library/bootstrap.ts")], proj);
    assert.equal(boot.code, 0, `bootstrap failed (code ${boot.code}): ${boot.stderr}\n--- stdout ---\n${boot.stdout}`);
  } finally { await cleanup(); }
});

test("init: writes Foo.spec with a parseable spec", async () => {
  const { root, cleanup } = await freshTmp("happy-parse");
  try {
    const result = await run("node", [INIT_TS, "Foo"], root);
    assert.equal(result.code, 0, `init failed: ${result.stderr}`);
    const specPath = join(root, "Foo", "Foo.spec");
    const content = await readFile(specPath, "utf8");
    // Dynamic import of parser via the vendored copy in the new project (avoids
    // mixing UA-internal alias resolution into a fresh-seed assertion).
    const { parse } = await import("#ua/parser.ts");
    const s = parse(content);
    assert.equal(s.name, "Foo");
    assert.ok(s.is && s.is.length > 0, "spec should have an `is`");
  } finally { await cleanup(); }
});

test("init: seeds the dictionary (empty, with README)", async () => {
  const { root, cleanup } = await freshTmp("happy-almanac");
  try {
    const result = await run("node", [INIT_TS, "Foo"], root);
    assert.equal(result.code, 0, `init failed: ${result.stderr}`);
    const almanacDir = join(root, "Foo", "dictionary/README.md");
    assert.ok(await pathExists(almanacDir), "dictionary/README.md not seeded");
  } finally { await cleanup(); }
});

// ── --here mode ────────────────────────────────────────────────────────────

test("init --here: works in empty dir; refuses non-empty with code 2", async () => {
  const { root: emptyRoot, cleanup: cleanupEmpty } = await freshTmp("here-empty");
  try {
    const ok = await run("node", [INIT_TS, "Foo", "--here"], emptyRoot);
    assert.equal(ok.code, 0, `init --here in empty dir failed: ${ok.stderr}`);
    assert.ok(await pathExists(join(emptyRoot, "Foo.spec")), "Foo.spec missing");
  } finally { await cleanupEmpty(); }

  const { root: dirtyRoot, cleanup: cleanupDirty } = await freshTmp("here-dirty");
  try {
    await writeFile(join(dirtyRoot, "existing.txt"), "stuff");
    const bad = await run("node", [INIT_TS, "Foo", "--here"], dirtyRoot);
    assert.equal(bad.code, 2, `expected code 2 in non-empty dir, got ${bad.code}: ${bad.stderr}`);
  } finally { await cleanupDirty(); }
});

test("init --here: allows a dir with only .git/ or .DS_Store", async () => {
  const { root, cleanup } = await freshTmp("here-git");
  try {
    await mkdir(join(root, ".git"), { recursive: true });
    await writeFile(join(root, ".DS_Store"), "noise");
    const result = await run("node", [INIT_TS, "Foo", "--here"], root);
    assert.equal(result.code, 0, `--here should tolerate .git/ + .DS_Store: ${result.stderr}`);
    assert.ok(await pathExists(join(root, "Foo.spec")), "Foo.spec missing");
  } finally { await cleanup(); }
});

// ── --catalogue mode ───────────────────────────────────────────────────────

test("init --catalogue: works in a non-empty dir", async () => {
  const { root, cleanup } = await freshTmp("cat-nonempty");
  try {
    // Pre-existing user project files
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "preexisting" }));
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src/app.ts"), "export {};");

    const result = await run("node", [INIT_TS, "Foo", "--catalogue"], root);
    assert.equal(result.code, 0, `--catalogue in non-empty dir failed: ${result.stderr}`);
    assert.ok(await pathExists(join(root, "Foo.spec")), "Foo.spec missing");
    assert.ok(await pathExists(join(root, "system/library")), "system/library missing");
    // Catalogue mode does NOT create the fractal subassemblies dir.
    assert.equal(
      await pathExists(join(root, "system/subassemblies")),
      false,
      "--catalogue should NOT create system/subassemblies/",
    );
    // Existing files preserved
    assert.ok(await pathExists(join(root, "src/app.ts")), "user file clobbered");
    // package.json preserved (left alone since pre-existing)
    const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    assert.equal(pkg.name, "preexisting", "user package.json was overwritten");
  } finally { await cleanup(); }
});

test("init --catalogue: refuses to overwrite existing Foo.spec or system/library/", async () => {
  // Pre-existing Foo.spec
  const { root: rootSpec, cleanup: cleanupSpec } = await freshTmp("cat-conflict-spec");
  try {
    await writeFile(join(rootSpec, "Foo.spec"), "spec Foo { is \"x\" }");
    const bad = await run("node", [INIT_TS, "Foo", "--catalogue"], rootSpec);
    assert.equal(bad.code, 2, `should refuse existing Foo.spec: ${bad.stderr}`);
    assert.match(bad.stderr, /Foo\.spec/, "should mention the conflict");
  } finally { await cleanupSpec(); }

  // Pre-existing system/library/
  const { root: rootLib, cleanup: cleanupLib } = await freshTmp("cat-conflict-lib");
  try {
    await mkdir(join(rootLib, "system/library"), { recursive: true });
    await writeFile(join(rootLib, "system/library/marker.ts"), "// preexisting");
    const bad = await run("node", [INIT_TS, "Foo", "--catalogue"], rootLib);
    assert.equal(bad.code, 2, `should refuse existing system/library/: ${bad.stderr}`);
    assert.match(bad.stderr, /system\/library/, "should mention the conflict");
    // Pre-existing marker untouched
    assert.ok(await pathExists(join(rootLib, "system/library/marker.ts")), "user lib clobbered");
  } finally { await cleanupLib(); }
});

// ── Error cases ────────────────────────────────────────────────────────────

test("init: lowercase name returns code 2", async () => {
  const { root, cleanup } = await freshTmp("err-lower");
  try {
    const result = await run("node", [INIT_TS, "foo"], root);
    assert.equal(result.code, 2, `expected code 2, got ${result.code}: ${result.stderr}`);
    assert.match(result.stderr, /uppercase/i);
  } finally { await cleanup(); }
});

test("init: name starting with digit returns code 2", async () => {
  const { root, cleanup } = await freshTmp("err-digit");
  try {
    const result = await run("node", [INIT_TS, "9Foo"], root);
    assert.equal(result.code, 2, `expected code 2, got ${result.code}: ${result.stderr}`);
    assert.match(result.stderr, /uppercase/i);
  } finally { await cleanup(); }
});
