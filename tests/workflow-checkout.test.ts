import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { assertWorkflowCheckout, captureWorkflowCheckout } from "../src/workflows/checkout.ts";
import { tempDir } from "./helpers.ts";

const execFileAsync = promisify(execFile);

test("checkout proof detects staged index divergence when status and worktree bytes are unchanged", async () => {
  const parent = await tempDir("workflow-checkout-index");
  const cwd = join(parent, "repo");
  const stagedSource = join(parent, "staged-source.txt");
  try {
    await mkdir(cwd);
    const tracked = join(cwd, "tracked.txt");
    await writeFile(tracked, "base\n");
    await execFileAsync("git", ["init", "-q"], { cwd });
    await execFileAsync("git", ["config", "user.email", "workflow-tests@example.invalid"], { cwd });
    await execFileAsync("git", ["config", "user.name", "Workflow Tests"], { cwd });
    await execFileAsync("git", ["add", "tracked.txt"], { cwd });
    await execFileAsync("git", ["commit", "-qm", "fixture"], { cwd });

    await writeFile(tracked, "staged-a\n");
    await execFileAsync("git", ["add", "tracked.txt"], { cwd });
    await writeFile(tracked, "same-worktree\n");
    const proof = await captureWorkflowCheckout(cwd);
    const statusBefore = (await execFileAsync("git", ["status", "--porcelain=v1", "--no-renames"], { cwd })).stdout;

    await writeFile(stagedSource, "staged-b\n");
    const blob = (await execFileAsync("git", ["hash-object", "-w", stagedSource], { cwd })).stdout.trim();
    await execFileAsync("git", ["update-index", "--cacheinfo", `100644,${blob},tracked.txt`], { cwd });
    const statusAfter = (await execFileAsync("git", ["status", "--porcelain=v1", "--no-renames"], { cwd })).stdout;
    assert.equal(statusAfter, statusBefore);

    await assert.rejects(assertWorkflowCheckout(proof), /checkout is missing or diverged/);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

for (const flag of ["--assume-unchanged", "--skip-worktree"] as const) {
  test(`checkout proof rejects ${flag.slice(2)} entries that can hide worktree divergence`, async () => {
    const parent = await tempDir("workflow-checkout-hidden");
    const cwd = join(parent, "repo");
    try {
      await mkdir(cwd);
      const tracked = join(cwd, "tracked.txt");
      await writeFile(tracked, "base\n");
      await execFileAsync("git", ["init", "-q"], { cwd });
      await execFileAsync("git", ["config", "user.email", "workflow-tests@example.invalid"], { cwd });
      await execFileAsync("git", ["config", "user.name", "Workflow Tests"], { cwd });
      await execFileAsync("git", ["add", "tracked.txt"], { cwd });
      await execFileAsync("git", ["commit", "-qm", "fixture"], { cwd });

      await execFileAsync("git", ["update-index", flag, "tracked.txt"], { cwd });
      await writeFile(tracked, "hidden divergence\n");
      const status = (await execFileAsync("git", ["status", "--porcelain=v1"], { cwd })).stdout;
      assert.equal(status, "", "the index flag hides the changed worktree bytes from status");
      await assert.rejects(captureWorkflowCheckout(cwd), /index flags that hide worktree changes/);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
}

test("checkout proof observes an already-cancelled signal before invoking Git", async () => {
  const controller = new AbortController();
  controller.abort(new Error("operator cancelled"));
  await assert.rejects(captureWorkflowCheckout("/path/that/does/not/exist", controller.signal), /operator cancelled/);
});

test("checkout proof rejects fsmonitor-valid entries that can hide worktree divergence", async () => {
  const parent = await tempDir("workflow-checkout-fsmonitor");
  const cwd = join(parent, "repo");
  try {
    await mkdir(cwd);
    const tracked = join(cwd, "tracked.txt");
    await writeFile(tracked, "base\n");
    await execFileAsync("git", ["init", "-q"], { cwd });
    await execFileAsync("git", ["config", "user.email", "workflow-tests@example.invalid"], { cwd });
    await execFileAsync("git", ["config", "user.name", "Workflow Tests"], { cwd });
    await execFileAsync("git", ["add", "tracked.txt"], { cwd });
    await execFileAsync("git", ["commit", "-qm", "fixture"], { cwd });
    await execFileAsync("git", ["config", "core.fsmonitor", "true"], { cwd });
    await execFileAsync("git", ["update-index", "--fsmonitor"], { cwd });
    await execFileAsync("git", ["update-index", "--fsmonitor-valid", "tracked.txt"], { cwd });
    const flags = (await execFileAsync("git", ["ls-files", "-f"], { cwd })).stdout;
    assert.match(flags, /^h tracked\.txt$/m, "Git exposes fsmonitor-valid state only through ls-files -f");
    await assert.rejects(captureWorkflowCheckout(cwd), /fsmonitor-valid index entries/);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
