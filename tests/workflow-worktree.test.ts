import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finishWorkflowWorktree, prepareWorkflowWorktree } from "../src/workflows/worktree.ts";

const exec = promisify(execFile);

async function fixture() {
  const parent = await mkdtemp(join(tmpdir(), "workflow-worktree-"));
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
