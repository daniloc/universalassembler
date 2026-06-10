/**
 * upgrade.ts — tool-level integration tests.
 *
 * Strategy: each test seeds a fresh UA project via init.ts, builds a separate
 * "fake canonical" UA core in another tmp dir, rewrites the CANONICAL constant
 * inside the vendored upgrade.ts to point at the fake canonical, then runs
 * upgrade.ts as a child process and asserts on its exit code, stdout/stderr,
 * and the resulting filesystem state.
 *
 * The CANONICAL constant is hardcoded in upgrade.ts at top-level. Rather than
 * shim or env-injection (the tool intentionally doesn't read env), we copy the
 * file with the constant rewritten — exact same code path, controlled inputs.
 */

import test from "node:test";
import assert from "node:assert";
import { mkdtemp, writeFile, mkdir, rm, readFile, stat, copyFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const UA_LIB_DIR = dirname(fileURLToPath(import.meta.url)).replace(/\/test$/, "");
const UA_ROOT = dirname(dirname(UA_LIB_DIR));
const INIT_PATH = join(UA_LIB_DIR, "init.ts");

// ── Helpers ────────────────────────────────────────────────────────────────

function run(cmd: string, args: string[], cwd: string): Promise<{code: number; stdout: string; stderr: string}> {
  return new Promise(resolve => {
    const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", c => stdout += c);
    child.stderr.on("data", c => stderr += c);
    child.on("close", code => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

async function copyTree(src: string, dst: string): Promise<void> {
  let entries: string[];
  try { entries = await readdir(src); } catch { return; }
  await mkdir(dst, { recursive: true });
  for (const name of entries) {
    const s = join(src, name);
    const d = join(dst, name);
    const st = await stat(s);
    if (st.isDirectory()) await copyTree(s, d);
    else await copyFile(s, d);
  }
}

async function pathExists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}

/**
 * Seed a project via init.ts, then build a sibling "fake canonical" UA core
 * by snapshotting the vendored library. Rewrite the CANONICAL constant in
 * the vendored upgrade.ts so the rest of the test drives against the
 * fake-canonical, not the real one (which would make tests non-hermetic).
 *
 * Returns root (the local UA project), canonicalRoot (the fake UA core the
 * project will pull from), and a cleanup function.
 */
async function seedProjectWithFakeCanonical(name: string): Promise<{
  root: string;
  canonicalRoot: string;
  cleanup: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), `ua-upgrade-${name.toLowerCase()}-`));
  const canonicalRoot = await mkdtemp(join(tmpdir(), `ua-upgrade-canonical-${name.toLowerCase()}-`));

  const init = await run("node", [INIT_PATH, name, "--here"], root);
  if (init.code !== 0) throw new Error(`init failed: ${init.stderr}`);

  // Snapshot the vendored library as the "canonical" UA core. Future runs
  // can edit canonicalRoot to simulate upstream changes.
  await copyTree(join(root, "system/library"), canonicalRoot);

  // Rewrite the CANONICAL constant in the project's vendored upgrade.ts
  // so it points at our fake canonical, not the real UA repo on disk.
  const upgradePath = join(root, "system/library/upgrade.ts");
  const upgradeSrc = await readFile(upgradePath, "utf8");
  const patched = upgradeSrc.replace(
    /const CANONICAL = "[^"]+";/,
    `const CANONICAL = ${JSON.stringify(canonicalRoot)};`,
  );
  if (patched === upgradeSrc) {
    throw new Error("failed to rewrite CANONICAL constant in vendored upgrade.ts");
  }
  await writeFile(upgradePath, patched);

  // Mirror the same patch into the fake canonical's own upgrade.ts so that
  // when the local upgrade pulls upgrade.ts itself, the rewrite stays in
  // place (otherwise --apply would clobber it back to the real path).
  await writeFile(join(canonicalRoot, "upgrade.ts"), patched);

  return {
    root,
    canonicalRoot,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
      await rm(canonicalRoot, { recursive: true, force: true });
    },
  };
}

const UPGRADE_REL = "system/library/upgrade.ts";

// ── Tests ─────────────────────────────────────────────────────────────────

test("upgrade: dry-run (no flags) reports zero changes against identical canonical", async () => {
  const { root, cleanup } = await seedProjectWithFakeCanonical("DryRun");
  try {
    const res = await run("node", [UPGRADE_REL], root);
    assert.equal(res.code, 0, `expected exit 0, got ${res.code}: ${res.stderr}`);
    // Structured tail on stdout.
    assert.match(res.stdout, /UPGRADE: added=0 updated=0 forked=0 unchanged=\d+/);
    assert.match(res.stderr, /Dry run/);
    // Confirm no "Apply" wording leaked.
    assert.doesNotMatch(res.stderr, /^Applied/m);
  } finally { await cleanup(); }
});

test("upgrade: --help exits 0 with usage text on stderr", async () => {
  const { root, cleanup } = await seedProjectWithFakeCanonical("Help");
  try {
    const res = await run("node", [UPGRADE_REL, "--help"], root);
    assert.equal(res.code, 0, `expected exit 0, got ${res.code}`);
    // Convention: HELP is written to stderr in this codebase.
    assert.match(res.stderr, /Usage: upgrade\.ts/);
    assert.match(res.stderr, /--apply/);
    assert.match(res.stderr, /--force/);
  } finally { await cleanup(); }
});

test("upgrade: --apply writes a missing file, then a second run reports unchanged", async () => {
  const { root, canonicalRoot, cleanup } = await seedProjectWithFakeCanonical("ApplyAdd");
  try {
    // Delete a vendored file locally to force an "added" outcome.
    const localExtract = join(root, "system/library/extract.ts");
    assert.equal(await pathExists(localExtract), true, "fixture precondition: extract.ts present");
    await rm(localExtract);

    // Dry-run reports added=1 and does NOT restore.
    const dry = await run("node", [UPGRADE_REL], root);
    assert.equal(dry.code, 0);
    assert.match(dry.stdout, /UPGRADE: added=1 updated=0 /);
    assert.equal(await pathExists(localExtract), false, "dry-run must not write");

    // Apply restores it.
    const apply = await run("node", [UPGRADE_REL, "--apply"], root);
    assert.equal(apply.code, 0);
    assert.match(apply.stdout, /UPGRADE: added=1 updated=0 /);
    assert.match(apply.stderr, /^Applied/m);
    assert.equal(await pathExists(localExtract), true, "apply must restore");

    // Second run is a no-op.
    const second = await run("node", [UPGRADE_REL], root);
    assert.equal(second.code, 0);
    assert.match(second.stdout, /UPGRADE: added=0 updated=0 /);

    // Sanity: the restored file matches canonical byte-for-byte.
    const localBytes = await readFile(localExtract);
    const canonicalBytes = await readFile(join(canonicalRoot, "extract.ts"));
    assert.deepEqual(localBytes, canonicalBytes);
  } finally { await cleanup(); }
});

test("upgrade: locally edited file is reported as Updated", async () => {
  const { root, cleanup } = await seedProjectWithFakeCanonical("DetectUpdate");
  try {
    // Append a benign comment to a vendored file so its content drifts from canonical.
    const parserPath = join(root, "system/library/parser.ts");
    const original = await readFile(parserPath, "utf8");
    await writeFile(parserPath, original + "\n// local test edit\n");

    const res = await run("node", [UPGRADE_REL], root);
    assert.equal(res.code, 0);
    assert.match(res.stdout, /UPGRADE: added=0 updated=1 /);
    assert.match(res.stderr, /Updated \(1\)/);
    assert.match(res.stderr, /parser\.ts/);
  } finally { await cleanup(); }
});

test("upgrade: canonical file removed leaves local file in place (additive only)", async () => {
  // Documented behavior: upgrade is additive. It pulls canonical files INTO
  // the local copy, but never removes a local file just because canonical
  // no longer has it. This is the safer default for vendored projects.
  const { root, canonicalRoot, cleanup } = await seedProjectWithFakeCanonical("CanonicalRemoval");
  try {
    const localOrphan = join(root, "system/library/derive.ts");
    assert.equal(await pathExists(localOrphan), true, "precondition: derive.ts present locally");
    // Remove derive.ts from the fake canonical to simulate upstream deletion.
    await rm(join(canonicalRoot, "derive.ts"));

    const res = await run("node", [UPGRADE_REL, "--apply"], root);
    assert.equal(res.code, 0);
    // The local file MUST still exist after apply.
    assert.equal(await pathExists(localOrphan), true,
      "upgrade should not delete local files missing from canonical (additive only)");
    // And it should not show up as added/updated/forked, since canonical
    // simply doesn't iterate it.
    assert.doesNotMatch(res.stderr, /derive\.ts/);
  } finally { await cleanup(); }
});

test("upgrade: file marked // LOCAL FORK is skipped when canonical differs", async () => {
  const { root, canonicalRoot, cleanup } = await seedProjectWithFakeCanonical("ForkSkip");
  try {
    // Mark parser.ts as a local fork AND make it differ from canonical.
    const parserPath = join(root, "system/library/parser.ts");
    const original = await readFile(parserPath, "utf8");
    await writeFile(parserPath, `// LOCAL FORK — do not auto-upgrade\n${original}\n// local divergence\n`);

    // Also nudge canonical so the diff trigger fires.
    const canonicalParser = join(canonicalRoot, "parser.ts");
    await writeFile(canonicalParser, (await readFile(canonicalParser, "utf8")) + "\n// upstream change\n");

    const res = await run("node", [UPGRADE_REL], root);
    assert.equal(res.code, 0);
    assert.match(res.stdout, /forked=1/);
    assert.match(res.stderr, /Skipped — local fork \(1\)/);
    assert.match(res.stderr, /parser\.ts/);
    // Should NOT appear in Updated.
    assert.doesNotMatch(res.stderr, /Updated \(\d/);
  } finally { await cleanup(); }
});

test("upgrade: --force overwrites a LOCAL FORK file", async () => {
  const { root, canonicalRoot, cleanup } = await seedProjectWithFakeCanonical("ForkForce");
  try {
    const parserPath = join(root, "system/library/parser.ts");
    const original = await readFile(parserPath, "utf8");
    await writeFile(parserPath, `// LOCAL FORK — do not auto-upgrade\n${original}\n// local divergence\n`);

    // Make canonical differ so the upgrade has something to push.
    const canonicalParser = join(canonicalRoot, "parser.ts");
    const canonicalContent = original + "\n// upstream change\n";
    await writeFile(canonicalParser, canonicalContent);

    const res = await run("node", [UPGRADE_REL, "--apply", "--force"], root);
    assert.equal(res.code, 0);
    assert.match(res.stdout, /updated=1/);
    assert.match(res.stdout, /forked=0/);

    // The file on disk now matches canonical — fork marker stripped.
    const after = await readFile(parserPath, "utf8");
    assert.equal(after, canonicalContent, "--force should overwrite the fork");
    assert.doesNotMatch(after, /LOCAL FORK/);
  } finally { await cleanup(); }
});

test("upgrade: refuses to run from within the UA reference repo itself", async () => {
  // Bonus guard: when LOCAL === CANONICAL, the tool exits 2 with a clear
  // message. We exercise the real, un-rewritten upgrade.ts here — its
  // CANONICAL points at UA_LIB_DIR, and we run it from UA_LIB_DIR.
  const res = await run("node", [join(UA_LIB_DIR, "upgrade.ts")], UA_ROOT);
  assert.equal(res.code, 2, `expected exit 2, got ${res.code}: ${res.stderr}`);
  assert.match(res.stderr, /cannot upgrade UA reference repo from itself/);
});
