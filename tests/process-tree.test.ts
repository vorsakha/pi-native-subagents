import test from "node:test";
import assert from "node:assert/strict";
import { spawnManaged } from "../src/process-tree.ts";

function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

async function readPid(managed: ReturnType<typeof spawnManaged>): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    let output = "";
    managed.child.stdout.on("data", (chunk) => {
      output += chunk.toString();
      const match = output.match(/\d+/);
      if (match) resolve(Number(match[0]));
    });
    managed.child.once("error", reject);
  });
}

test("managed process teardown terminates the spawned process group", { skip: process.platform === "win32", timeout: 10_000 }, async () => {
  const script = `const {spawn}=require('node:child_process'); const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); console.log(c.pid); setInterval(()=>{},1000);`;
  const managed = spawnManaged(process.execPath, ["-e", script]);
  const grandchildPid = await readPid(managed);
  await managed.terminate(100);
  assert.equal(processExists(grandchildPid), false, "terminate resolves only after the descendant is gone");
  assert.equal(processExists(managed.child.pid!), false, "terminate resolves only after the process-group leader is gone");
});
