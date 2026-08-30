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
