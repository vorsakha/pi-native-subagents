import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { JsonRpcPeer } from "../src/jsonrpc.ts";
import type { ManagedProcess } from "../src/process-tree.ts";

function fakeManaged() {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  Object.assign(child, { stdin, stdout, stderr, exitCode: null, signalCode: null, pid: 999_999 });
  let terminated = false;
  const managed: ManagedProcess = {
    child,
    async terminate() {
      if (!terminated) {
        terminated = true;
        Object.assign(child, { exitCode: 0 });
        child.emit("close", 0);
      }
    },
  };
  return { managed, child, stdin, stdout, get terminated() { return terminated; } };
}

test("JSON-RPC peer correlates chunked numeric and string-ID responses", async () => {
  const fake = fakeManaged();
  const writes: Record<string, unknown>[] = [];
  fake.stdin.on("data", (chunk) => {
    const message = JSON.parse(chunk.toString());
    writes.push(message);
    if (message.method === "echo") {
      const result = message.params?.value === 1 ? { text: "a b" } : "string-ok";
      const response = `${JSON.stringify({ id: message.id, result })}\n`;
      fake.stdout.write(response.slice(0, 7));
      fake.stdout.write(response.slice(7));
    }
  });
  let activities = 0;
  const peer = new JsonRpcPeer({ process: fake.managed, onActivity: () => { activities++; } });
  assert.deepEqual(await peer.request("echo", { value: 1 }), { text: "a b" });
  assert.equal(writes[0]?.method, "echo");
  assert.equal(activities, 1, "valid JSON-RPC responses count as provider activity");
  await peer.close();
  const stringIdPeer = new JsonRpcPeer({ process: fake.managed, requestId: () => "request-one" });
  assert.equal(await stringIdPeer.request("echo"), "string-ok");
  await stringIdPeer.close();
});

test("JSON-RPC awaits handlers and fails closed for approval requests", async () => {
  const fake = fakeManaged();
  const writes: Record<string, unknown>[] = [];
  fake.stdin.on("data", (chunk) => writes.push(JSON.parse(chunk.toString())));
  const peer = new JsonRpcPeer({
    process: fake.managed,
    onRequest: async () => { await new Promise<void>((resolve) => setTimeout(resolve, 5)); return { decision: "decline" }; },
  });
  fake.stdout.write(`${JSON.stringify({ id: "approval-one", method: "approval", params: {} })}\n`);
  await new Promise<void>((resolve) => setTimeout(resolve, 15));
  assert.deepEqual(writes[0], { id: "approval-one", result: { decision: "decline" } });
  await peer.close();
  const approvalFake = fakeManaged();
  const approvalWrites: Record<string, unknown>[] = [];
  approvalFake.stdin.on("data", (chunk) => approvalWrites.push(JSON.parse(chunk.toString())));
  const approvalPeer = new JsonRpcPeer({ process: approvalFake.managed });
  approvalFake.stdout.write(`${JSON.stringify({ id: 44, method: "item/commandExecution/requestApproval", params: {} })}\n`);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(approvalWrites[0], { id: 44, result: { decision: "decline" } });
  await approvalPeer.close();
});

test("JSON-RPC malformed and oversized frames reject pending work and tear down", async () => {
  for (const [output, options, error] of [
    ["{not-json}\n", {}, /framing failed.*invalid JSON object/],
    ["123456789", { maxFrameBytes: 8 }, /framing failed.*exceeds 8 bytes/],
  ] as const) {
    const fake = fakeManaged();
    const peer = new JsonRpcPeer({ process: fake.managed, ...options });
    const pending = peer.request("never");
    fake.stdout.write(output);
    await assert.rejects(pending, error);
    assert.equal(fake.terminated, true);
  }
});

test("JSON-RPC reports malformed and oversized frame failures to an observer even with no pending request", async () => {
  for (const [output, options, error] of [
    ["{not-json}\n", {}, /framing failed.*invalid JSON object/],
    ["123456789", { maxFrameBytes: 8 }, /framing failed.*exceeds 8 bytes/],
  ] as const) {
    const fake = fakeManaged();
    const observed: Error[] = [];
    const peer = new JsonRpcPeer({ process: fake.managed, ...options, onProtocolError: (err) => observed.push(err) });
    fake.stdout.write(output);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(observed.length, 1, "the observer fires exactly once");
    assert.match(observed[0]!.message, error);
    assert.equal(fake.terminated, true);
    await peer.close();
  }
});

test("JSON-RPC close and stdin failures reject pending requests with teardown", async () => {
  const fake = fakeManaged();
  const peer = new JsonRpcPeer({ process: fake.managed });
  const pending = peer.request("never", {}, 60_000);
  await peer.close();
  await assert.rejects(pending, /peer closed/);
  assert.equal(fake.terminated, true);
  const stdinFake = fakeManaged();
  const stdinPeer = new JsonRpcPeer({ process: stdinFake.managed });
  const stdinPending = stdinPeer.request("never");
  stdinFake.stdin.emit("error", new Error("EPIPE"));
  await assert.rejects(stdinPending, /stdin failed: EPIPE/);
  assert.equal(stdinFake.terminated, true);
});
