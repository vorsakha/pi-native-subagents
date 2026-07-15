import test from "node:test";
import assert from "node:assert/strict";
import { spawnManaged } from "../src/process-tree.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function assertGone(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt++) {
    try { process.kill(pid, 0); await sleep(50); }
    catch { return; }
  }
  assert.fail(`descendant ${pid} survived process-tree teardown`);
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
  await assertGone(grandchildPid);
});

test("an immediate terminate call escalates teardown already in progress", { skip: process.platform === "win32", timeout: 10_000 }, async () => {
  const stubborn = `process.on('SIGTERM',()=>{}); console.log(process.pid); setInterval(()=>{},1000)`;
  const managed = spawnManaged(process.execPath, ["-e", stubborn]);
  const childPid = await readPid(managed);
  const started = Date.now();
  const graceful = managed.terminate(5_000);
  await sleep(25);
  await managed.terminate(0);
  await graceful;
  assert.ok(Date.now() - started < 1_000, "forced escalation reused the original grace deadline");
  await assertGone(childPid);
});

test("teardown escalates after the group leader exits but a descendant ignores SIGTERM", { skip: process.platform === "win32", timeout: 10_000 }, async () => {
  const stubborn = `process.on('SIGTERM',()=>{}); console.log('ready'); setInterval(()=>{},1000)`;
  const leader = `const {spawn}=require('node:child_process'); const c=spawn(process.execPath,['-e',${JSON.stringify(stubborn)}],{stdio:['ignore','pipe','ignore']}); c.stdout.once('data',()=>console.log(c.pid)); setInterval(()=>{},1000);`;
  const managed = spawnManaged(process.execPath, ["-e", leader]);
  const descendantPid = await readPid(managed);
  await managed.terminate(100);
  await assertGone(descendantPid);
});
