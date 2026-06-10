/**
 * test/hooks.ts — integration tests for the pre-commit hook and its installer.
 *
 * The hook is a shell script (system/library/hooks/pre-commit). We exercise it
 * end-to-end by seeding a fresh UA project (via init.ts --here) in a temp dir,
 * mutating its state to reflect the scenario under test, and invoking the hook
 * directly via `bash <fixture>/.git/hooks/pre-commit`. This catches contract
 * drift between the hook and bootstrap.ts that unit tests miss.
 *
 * install.ts gets its own group: hooks must land in the git common dir (not
 * the per-worktree dir), --force must be respected, and re-installing the
 * same content must be a no-op.
 */

import test from "node:test";
import assert from "node:assert";
import { mkdtemp, writeFile, mkdir, rm, readFile, stat, unlink, chmod, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, execFileSync } from "node:child_process";

const UA_ROOT = new URL("../../..", import.meta.url).pathname.replace(/\/$/, "");
const INIT = join(UA_ROOT, "system/library/init.ts");
const INSTALL = join(UA_ROOT, "system/library/hooks/install.ts");

function run(cmd: string, args: string[], cwd: string): Promise<{code: number; stdout: string; stderr: string}> {
  return new Promise(resolve => {
    const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", c => stdout += c);
    child.stderr.on("data", c => stderr += c);
    child.on("close", code => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

/**
 * Seed a fresh UA project in a fresh git repo. Uses init.ts --here, which
 * vendors UA core + writes the root spec + auto-installs the pre-commit hook
 * because .git/ already exists.
 */
async function seedProject(name: string): Promise<{ root: string; cleanup: () => Promise<void> }> {
  // macOS aliases /tmp → /private/tmp and /var/folders → /private/var/folders.
  // mkdtemp returns the non-canonical path; canonicalize so that scripts'
  // `import.meta.url === pathToFileURL(argv[1]).href` CLI-entrypoint guard
  // matches when we spawn them by absolute path. Without realpath, install.ts
  // and friends are imported as modules but skip their CLI body — silent no-op.
  const raw = await mkdtemp(join(tmpdir(), `ua-hooks-${name.toLowerCase()}-`));
  const root = await realpath(raw);
  // git init first so init.ts's auto-hook-install can find a .git/.
  execFileSync("git", ["init", "-q"], { cwd: root });
  // Required for any later commit calls in worktree tests.
  execFileSync("git", ["config", "user.email", "test@ua.local"], { cwd: root });
  execFileSync("git", ["config", "user.name", "UA Test"], { cwd: root });
  const r = await run("node", [INIT, name, "--here"], root);
  if (r.code !== 0) {
    await rm(root, { recursive: true, force: true });
    throw new Error(`init failed (code ${r.code}): ${r.stderr}`);
  }
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

// ── Hook behavior ─────────────────────────────────────────────────────────

test("hooks: pre-commit exits 0 on clean fixture (slow)", async () => {
  const { root, cleanup } = await seedProject("CleanHook");
  try {
    const r = await run("bash", [join(root, ".git/hooks/pre-commit")], root);
    assert.equal(r.code, 0, `expected exit 0, got ${r.code}; stderr: ${r.stderr}`);
  } finally { await cleanup(); }
});

test("hooks: pre-commit exits 1 when bootstrap fails (slow)", async () => {
  // Break bootstrap by deleting system/library/parser.ts — bootstrap.ts
  // imports it transitively (via walker/primitives), so removing it makes
  // `node bootstrap.ts` exit non-zero on module resolution, which the hook
  // surfaces as exit 1 with its guidance message.
  const { root, cleanup } = await seedProject("BrokenHook");
  try {
    await unlink(join(root, "system/library/parser.ts"));
    const r = await run("bash", [join(root, ".git/hooks/pre-commit")], root);
    assert.equal(r.code, 1, `expected exit 1, got ${r.code}`);
    assert.match(r.stdout, /bootstrap failed/, "user-facing message should mention bootstrap");
    assert.match(r.stdout, /--no-verify/, "should mention the bypass escape hatch");
  } finally { await cleanup(); }
});

test("hooks: pre-commit is a silent no-op when bootstrap.ts is absent (slow)", async () => {
  // Simulates the hook being vendored into a non-UA project (e.g. a submodule
  // that imported UA's hooks dir but has no library/). The hook's first guard
  // returns 0 with zero output so it never blocks unrelated commits.
  const { root, cleanup } = await seedProject("NoBootstrapHook");
  try {
    await unlink(join(root, "system/library/bootstrap.ts"));
    const r = await run("bash", [join(root, ".git/hooks/pre-commit")], root);
    assert.equal(r.code, 0, `expected silent exit 0, got ${r.code}`);
    assert.equal(r.stdout, "", "stdout should be empty (silent no-op)");
    assert.equal(r.stderr, "", "stderr should be empty (silent no-op)");
  } finally { await cleanup(); }
});

// ── install.ts ────────────────────────────────────────────────────────────

test("hooks install: writes pre-commit to .git/hooks/ and chmods +x (slow)", async () => {
  const { root, cleanup } = await seedProject("InstallBasic");
  try {
    // init.ts already ran install once. Remove the installed hook and re-run
    // to assert the installer's contract in isolation.
    await unlink(join(root, ".git/hooks/pre-commit"));
    const r = await run("node", [join(root, "system/library/hooks/install.ts")], root);
    assert.equal(r.code, 0, `install failed: ${r.stderr}`);
    const st = await stat(join(root, ".git/hooks/pre-commit"));
    // 0o111 = any execute bit set (owner/group/other). chmod 0o755 sets all three.
    assert.ok((st.mode & 0o111) !== 0, `pre-commit should be executable; mode = ${st.mode.toString(8)}`);
    // Content must match the vendored source verbatim.
    const installed = await readFile(join(root, ".git/hooks/pre-commit"), "utf8");
    const source = await readFile(join(root, "system/library/hooks/pre-commit"), "utf8");
    assert.equal(installed, source, "installed hook should match vendored source");
  } finally { await cleanup(); }
});

test("hooks install: targets git-common-dir, not per-worktree git-dir (slow)", async () => {
  // Regression guard: if install.ts ever swapped `--git-common-dir` for
  // `--git-dir`, hooks would land in .git/worktrees/<name>/hooks/ — which
  // git ignores. We assert hooks end up in the shared .git/hooks/ that
  // every worktree uses.
  const { root, cleanup } = await seedProject("InstallWorktree");
  const wtRaw = await mkdtemp(join(tmpdir(), "ua-hooks-wt-"));
  // mkdtemp creates the dir; git worktree add refuses non-empty targets.
  await rm(wtRaw, { recursive: true, force: true });
  // We can't realpath() a path that doesn't exist; replicate the canonicalization
  // mkdtemp's parent dir already underwent so install.ts's CLI guard matches.
  const wtRoot = wtRaw.startsWith("/var/folders/") ? "/private" + wtRaw : wtRaw;
  try {
    // Need a commit before adding a worktree.
    execFileSync("git", ["add", "-A"], { cwd: root });
    execFileSync("git", ["commit", "-q", "--no-verify", "-m", "seed"], { cwd: root });
    execFileSync("git", ["worktree", "add", "-q", wtRoot], { cwd: root });

    // Remove the hook from the common dir so we can prove install puts it back there.
    await unlink(join(root, ".git/hooks/pre-commit"));

    // Run install from inside the worktree.
    const r = await run("node", [join(wtRoot, "system/library/hooks/install.ts")], wtRoot);
    assert.equal(r.code, 0, `install failed: ${r.stderr}`);

    // Hook should appear in the COMMON dir (root/.git/hooks), not the per-worktree dir.
    await assert.doesNotReject(stat(join(root, ".git/hooks/pre-commit")),
      "hook should land in shared .git/hooks/");
    await assert.rejects(stat(join(root, ".git/worktrees")).then(async () => {
      // If a worktrees/<name>/hooks/pre-commit ever exists, that's the bug.
      const wtName = wtRoot.split("/").pop()!;
      await stat(join(root, ".git/worktrees", wtName, "hooks/pre-commit"));
    }), "hook must NOT land in per-worktree hooks dir");
  } finally {
    // Best-effort cleanup. Remove worktree first, then both trees.
    try { execFileSync("git", ["worktree", "remove", "--force", wtRoot], { cwd: root, stdio: "ignore" }); } catch {}
    await rm(wtRoot, { recursive: true, force: true });
    await cleanup();
  }
});

test("hooks install: --force overwrites a divergent existing hook (slow)", async () => {
  const { root, cleanup } = await seedProject("InstallForce");
  try {
    // Stomp on the installed hook with custom content. Without --force, install
    // should refuse and skip; with --force it should overwrite.
    await writeFile(join(root, ".git/hooks/pre-commit"), "#!/bin/sh\necho custom\nexit 0\n");
    await chmod(join(root, ".git/hooks/pre-commit"), 0o755);

    // Without --force: skipped.
    const refused = await run("node", [join(root, "system/library/hooks/install.ts")], root);
    assert.equal(refused.code, 0, "install should still exit 0 even when skipping");
    assert.match(refused.stderr, /skip pre-commit/, "should announce the skip");
    const stillCustom = await readFile(join(root, ".git/hooks/pre-commit"), "utf8");
    assert.match(stillCustom, /echo custom/, "user hook should be untouched without --force");

    // With --force: overwritten.
    const forced = await run("node", [join(root, "system/library/hooks/install.ts"), "--force"], root);
    assert.equal(forced.code, 0, `--force install failed: ${forced.stderr}`);
    assert.match(forced.stderr, /installed pre-commit/, "should announce the overwrite");
    const overwritten = await readFile(join(root, ".git/hooks/pre-commit"), "utf8");
    const source = await readFile(join(root, "system/library/hooks/pre-commit"), "utf8");
    assert.equal(overwritten, source, "after --force, hook should match vendored source");
  } finally { await cleanup(); }
});

test("hooks install: second install is a silent no-op (slow)", async () => {
  // Idempotency contract: re-running install when the on-disk hook already
  // matches the vendored source must NOT print an "installed" or "overwriting"
  // line. It should just report "unchanged/skipped" and exit 0.
  const { root, cleanup } = await seedProject("InstallIdem");
  try {
    // First install ran inside init.ts. Run a second time — should be a no-op.
    const r = await run("node", [join(root, "system/library/hooks/install.ts")], root);
    assert.equal(r.code, 0, `second install failed: ${r.stderr}`);
    assert.doesNotMatch(r.stderr, /installed pre-commit/,
      "second install should not re-write an unchanged file");
    assert.match(r.stderr, /0 installed/, "should report zero installs on the second run");
  } finally { await cleanup(); }
});
