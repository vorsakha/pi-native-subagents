import test from "node:test";
import assert from "node:assert/strict";
import { tempDir } from "./helpers.ts";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { listSavedWorkflows, loadSavedWorkflow, loadWorkflowScriptPath } from "../src/workflows/saved.ts";

async function fixture() {
  const parent = await tempDir("workflow-saved");
  const cwd = join(parent, "project");
  const globalRoot = join(parent, "global");
  await mkdir(join(cwd, ".pi", "workflows"), { recursive: true });
  await mkdir(globalRoot, { recursive: true });
  return { parent, cwd, globalRoot };
}

test("project saved workflow directories cannot escape through symlinks", async () => {
  if (process.platform === "win32") return;
  const f = await fixture();
  try {
    const outside = join(f.parent, "outside-definitions");
    await mkdir(outside);
    await writeFile(join(outside, "review.js"), "export default 'outside';");
    await rm(join(f.cwd, ".pi", "workflows"), { recursive: true });
    await symlink(outside, join(f.cwd, ".pi", "workflows"));
    await assert.rejects(listSavedWorkflows({ cwd: f.cwd, trusted: true, globalRoot: f.globalRoot }), /escapes the trusted project/);
  } finally { await rm(f.parent, { recursive: true, force: true }); }
});

test("saved workflows use trusted project precedence and script paths stay contained", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.globalRoot, "review.js"), "export default 'global';");
    await writeFile(join(f.globalRoot, "global-only.mjs"), "export default 'global-only';");
    await writeFile(join(f.cwd, ".pi", "workflows", "review.js"), "export default 'project';");
    await writeFile(join(f.cwd, "local.js"), "export default 'local';");
    await writeFile(join(f.parent, "outside.js"), "export default 'outside';");

    const listed = await listSavedWorkflows({ cwd: f.cwd, trusted: true, globalRoot: f.globalRoot });
    assert.deepEqual(listed.map((item) => [item.name, item.origin]), [["global-only", "global"], ["review", "project"]]);
    assert.equal((await loadSavedWorkflow({ cwd: f.cwd, trusted: true, globalRoot: f.globalRoot, name: "review" })).script, "export default 'project';");
    await assert.rejects(loadSavedWorkflow({ cwd: f.cwd, trusted: false, globalRoot: f.globalRoot, name: "review" }), /untrusted/);
    assert.equal((await loadWorkflowScriptPath({ cwd: f.cwd, trusted: true, scriptPath: "local.js" })).script, "export default 'local';");
    await assert.rejects(loadWorkflowScriptPath({ cwd: f.cwd, trusted: true, scriptPath: "../outside.js" }), /escapes/);
    await assert.rejects(loadWorkflowScriptPath({ cwd: f.cwd, trusted: false, scriptPath: "local.js" }), /untrusted/);

    if (process.platform !== "win32") {
      await symlink(join(f.parent, "outside.js"), join(f.cwd, "escape.js"));
      await assert.rejects(loadWorkflowScriptPath({ cwd: f.cwd, trusted: true, scriptPath: "escape.js" }), /escapes/);
    }
  } finally { await rm(f.parent, { recursive: true, force: true }); }
});
