import test from "node:test";
import assert from "node:assert/strict";
import { tempDir } from "./helpers.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { finishWorkflowWorktree, prepareWorkflowWorktree, reclaimWorkflowWorktree } from "../src/workflows/worktree.ts";

const exec = promisify(execFile);

async function fixture() {
  const parent = await tempDir("workflow-worktree");
  const repo = join(parent, "repo");
  const artifactDir = join(parent, "artifacts", "wf_aaaaaaaa");
  await mkdir(repo);
  await mkdir(artifactDir, { recursive: true });
  await exec("git", ["init", "-q", repo]);
  await exec("git", ["-C", repo, "config", "user.email", "tests@example.invalid"]);
  await exec("git", ["-C", repo, "config", "user.name", "Workflow Tests"]);
  await writeFile(join(repo, "tracked.txt"), "base\n");
  await exec("git", ["-C", repo, "add", "tracked.txt"]);
  await exec("git", ["-C", repo, "commit", "-qm", "base"]);
  return { parent, repo, artifactDir };
}

test("worktree isolation rejects trusted roots nested inside a larger repository", async () => {
  const f = await fixture();
  try {
    const nested = join(f.repo, "nested");
    await mkdir(nested);
    await assert.rejects(prepareWorkflowWorktree({ cwd: nested, artifactDir: f.artifactDir, runId: "wf_aaaaaaaa", agentIndex: 0 }), /Git repository root/);
  } finally { await rm(f.parent, { recursive: true, force: true }); }
});

test("worktree isolation rejects dirty sources rather than omitting uncommitted work", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.repo, "tracked.txt"), "dirty\n");
    await assert.rejects(prepareWorkflowWorktree({ cwd: f.repo, artifactDir: f.artifactDir, runId: "wf_aaaaaaaa", agentIndex: 0 }), /clean source checkout/);
  } finally { await rm(f.parent, { recursive: true, force: true }); }
});

test("worktree artifact symlinks cannot redirect private work or patches", async () => {
  if (process.platform === "win32") return;
  const f = await fixture();
  try {
    const outside = join(f.parent, "outside");
    await mkdir(outside);
    await symlink(outside, join(f.artifactDir, "worktrees"));
    await assert.rejects(prepareWorkflowWorktree({ cwd: f.repo, artifactDir: f.artifactDir, runId: "wf_aaaaaaaa", agentIndex: 0 }), /worktrees path/);
  } finally { await rm(f.parent, { recursive: true, force: true }); }
});

test("worktree isolation detects writes redirected into the source checkout", async () => {
  const f = await fixture();
  try {
    const handle = await prepareWorkflowWorktree({ cwd: f.repo, artifactDir: f.artifactDir, runId: "wf_aaaaaaaa", agentIndex: 0 });
    await writeFile(join(f.repo, "escaped.txt"), "breach\n");
    await assert.rejects(finishWorkflowWorktree(handle, f.artifactDir), /isolation breach/);
  } finally { await rm(f.parent, { recursive: true, force: true }); }
});

test("worktree isolation removes unchanged work and preserves changed work with integration metadata", async () => {
  const f = await fixture();
  try {
    const unchanged = await prepareWorkflowWorktree({ cwd: f.repo, artifactDir: f.artifactDir, runId: "wf_aaaaaaaa", agentIndex: 0 });
    assert.equal((await readFile(join(unchanged.path, "tracked.txt"), "utf8")), "base\n");
    const removed = await finishWorkflowWorktree(unchanged, f.artifactDir);
    assert.deepEqual(removed, { type: "worktree", state: "removed", branch: "pi-workflow/wf_aaaaaaaa/0", changed: false });
    await assert.rejects(stat(unchanged.path), (error: NodeJS.ErrnoException) => error.code === "ENOENT");

    const changed = await prepareWorkflowWorktree({ cwd: f.repo, artifactDir: f.artifactDir, runId: "wf_aaaaaaaa", agentIndex: 1 });
    await writeFile(join(changed.path, "tracked.txt"), "changed\n");
    await writeFile(join(changed.path, "new.txt"), "new\n");
    const preserved = await finishWorkflowWorktree(changed, f.artifactDir);
    assert.equal(preserved.state, "preserved");
    assert.equal(preserved.changed, true);
    assert.equal(preserved.branch, "pi-workflow/wf_aaaaaaaa/1");
    assert.equal(preserved.patchArtifact, "agent-1.patch");
    const patch = await readFile(join(f.artifactDir, "agent-1.patch"), "utf8");
    assert.match(patch, /tracked\.txt[\s\S]*changed/);
    assert.match(patch, /new\.txt/);
    assert.equal((await stat(changed.path)).isDirectory(), true, "changed worktree remains available for explicit integration");
  } finally {
    await rm(f.parent, { recursive: true, force: true });
  }
});

test("reclaiming a preserved worktree removes the checkout, branch, and Git registration but keeps the patch", async () => {
  const f = await fixture();
  try {
    const handle = await prepareWorkflowWorktree({ cwd: f.repo, artifactDir: f.artifactDir, runId: "wf_aaaaaaaa", agentIndex: 1 });
    await writeFile(join(handle.path, "tracked.txt"), "changed\n");
    const preserved = await finishWorkflowWorktree(handle, f.artifactDir);
    assert.equal(preserved.state, "preserved");

    const reclamation = await reclaimWorkflowWorktree({
      cwd: f.repo,
      artifactDir: f.artifactDir,
      runId: "wf_aaaaaaaa",
      agentIndex: 1,
      branch: preserved.branch,
      state: "preserved",
      patchArtifact: preserved.patchArtifact,
    });
    assert.deepEqual(reclamation, { removedRegistration: true, removedCheckout: true, deletedBranch: true, warnings: [] });

    await assert.rejects(stat(handle.path), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
    const worktreeList = await exec("git", ["-C", f.repo, "worktree", "list", "--porcelain"]);
    assert.doesNotMatch(worktreeList.stdout, /agent-1/);
    const branches = await exec("git", ["-C", f.repo, "branch", "--list", preserved.branch]);
    assert.equal(branches.stdout.trim(), "");
    assert.equal((await readFile(join(f.artifactDir, "agent-1.patch"), "utf8")).length > 0, true, "reclaiming never deletes the patch artifact");
  } finally { await rm(f.parent, { recursive: true, force: true }); }
});

test("reclaiming an orphaned worktree with no patch refuses unless forced", async () => {
  const f = await fixture();
  try {
    const handle = await prepareWorkflowWorktree({ cwd: f.repo, artifactDir: f.artifactDir, runId: "wf_aaaaaaaa", agentIndex: 2 });
    await writeFile(join(handle.path, "tracked.txt"), "changed\n");
    const branch = handle.branch;

    await assert.rejects(reclaimWorkflowWorktree({
      cwd: f.repo,
      artifactDir: f.artifactDir,
      runId: "wf_aaaaaaaa",
      agentIndex: 2,
      branch,
      state: "orphaned",
    }), /patch/i);
    assert.equal((await stat(handle.path)).isDirectory(), true, "refused reclamation leaves the only copy of changed work intact");
    const branches = await exec("git", ["-C", f.repo, "branch", "--list", branch]);
    assert.notEqual(branches.stdout.trim(), "");

    const forced = await reclaimWorkflowWorktree({
      cwd: f.repo,
      artifactDir: f.artifactDir,
      runId: "wf_aaaaaaaa",
      agentIndex: 2,
      branch,
      state: "orphaned",
      force: true,
    });
    assert.equal(forced.removedCheckout, true);
    assert.equal(forced.warnings.length, 1);
    await assert.rejects(stat(handle.path), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
  } finally { await rm(f.parent, { recursive: true, force: true }); }
});

test("reclamation throws when a locked missing checkout keeps its Git registration", async () => {
  const f = await fixture();
  let handle: Awaited<ReturnType<typeof prepareWorkflowWorktree>> | undefined;
  try {
    handle = await prepareWorkflowWorktree({ cwd: f.repo, artifactDir: f.artifactDir, runId: "wf_aaaaaaaa", agentIndex: 3 });
    await exec("git", ["-C", f.repo, "worktree", "lock", "--reason", "release-test", handle.path]);
    await rm(handle.path, { recursive: true, force: true });

    await assert.rejects(reclaimWorkflowWorktree({
      cwd: f.repo,
      artifactDir: f.artifactDir,
      runId: "wf_aaaaaaaa",
      agentIndex: 3,
      branch: handle.branch,
      state: "orphaned",
      force: true,
    }), /registration remains/);

    const worktreeList = await exec("git", ["-C", f.repo, "worktree", "list", "--porcelain"]);
    assert.ok(worktreeList.stdout.includes(`worktree ${handle.path}`), "the failed reclamation leaves the protected registration intact");
    const branches = await exec("git", ["-C", f.repo, "branch", "--list", handle.branch]);
    assert.notEqual(branches.stdout.trim(), "", "the failed reclamation leaves the branch intact");
  } finally {
    if (handle) {
      await exec("git", ["-C", f.repo, "worktree", "unlock", handle.path]).catch(() => undefined);
      await exec("git", ["-C", f.repo, "worktree", "prune"]).catch(() => undefined);
      await exec("git", ["-C", f.repo, "branch", "-D", handle.branch]).catch(() => undefined);
    }
    await rm(f.parent, { recursive: true, force: true });
  }
});

test("reclamation throws when the isolated branch remains checked out elsewhere", async () => {
  const f = await fixture();
  let handle: Awaited<ReturnType<typeof prepareWorkflowWorktree>> | undefined;
  const elsewhere = join(f.parent, "elsewhere");
  try {
    handle = await prepareWorkflowWorktree({ cwd: f.repo, artifactDir: f.artifactDir, runId: "wf_aaaaaaaa", agentIndex: 4 });
    await exec("git", ["-C", f.repo, "worktree", "remove", "--force", handle.path]);
    await exec("git", ["-C", f.repo, "worktree", "add", "-q", elsewhere, handle.branch]);

    await assert.rejects(reclaimWorkflowWorktree({
      cwd: f.repo,
      artifactDir: f.artifactDir,
      runId: "wf_aaaaaaaa",
      agentIndex: 4,
      branch: handle.branch,
      state: "orphaned",
      force: true,
    }), /branch remains/);

    const branches = await exec("git", ["-C", f.repo, "branch", "--list", handle.branch]);
    assert.notEqual(branches.stdout.trim(), "", "the failed reclamation leaves the branch checked out elsewhere");
    const worktreeList = await exec("git", ["-C", f.repo, "worktree", "list", "--porcelain"]);
    assert.ok(worktreeList.stdout.includes(`worktree ${elsewhere}`), "the other registration remains protected");
  } finally {
    await exec("git", ["-C", f.repo, "worktree", "remove", "--force", elsewhere]).catch(() => undefined);
    if (handle) await exec("git", ["-C", f.repo, "branch", "-D", handle.branch]).catch(() => undefined);
    await rm(f.parent, { recursive: true, force: true });
  }
});

test("reclamation rejects a branch or path that does not match the run and agent identity", async () => {
  const f = await fixture();
  try {
    const handle = await prepareWorkflowWorktree({ cwd: f.repo, artifactDir: f.artifactDir, runId: "wf_aaaaaaaa", agentIndex: 0 });
    await assert.rejects(reclaimWorkflowWorktree({
      cwd: f.repo,
      artifactDir: f.artifactDir,
      runId: "wf_aaaaaaaa",
      agentIndex: 0,
      branch: "pi-workflow/wf_bbbbbbbb/0",
      state: "preserved",
      patchArtifact: "agent-0.patch",
    }), /identity/);
    assert.equal((await stat(handle.path)).isDirectory(), true, "a mismatched branch is rejected before any Git mutation");
  } finally { await rm(f.parent, { recursive: true, force: true }); }
});
