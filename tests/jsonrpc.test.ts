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

test("JSON-RPC peer correlates chunked responses and preserves Unicode separators", async () => {
  const fake = fakeManaged();
  const writes: Record<string, unknown>[] = [];
  fake.stdin.on("data", (chunk) => {
    const message = JSON.parse(chunk.toString());
    writes.push(message);
    if (message.method === "echo") {
      const response = `${JSON.stringify({ id: message.id, result: { text: "a b" } })}\n`;
      fake.stdout.write(response.slice(0, 7));
      fake.stdout.write(response.slice(7));
    }
  });
  const peer = new JsonRpcPeer({ process: fake.managed });
  assert.deepEqual(await peer.request("echo", { value: 1 }), { text: "a b" });
  assert.equal(writes[0]?.method, "echo");
  await peer.close();
});

test("JSON-RPC peer supports string request/response IDs", async () => {
  const fake = fakeManaged();
  fake.stdin.on("data", (chunk) => {
    const message = JSON.parse(chunk.toString());
    fake.stdout.write(`${JSON.stringify({ id: message.id, result: "string-ok" })}\n`);
  });
  const peer = new JsonRpcPeer({ process: fake.managed, requestId: () => "request-one" });
  assert.equal(await peer.request("echo"), "string-ok");
  await peer.close();
});

test("JSON-RPC awaits asynchronous server request handlers", async () => {
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
});

test("JSON-RPC server approval requests fail closed", async () => {
  const fake = fakeManaged();
  const writes: Record<string, unknown>[] = [];
  fake.stdin.on("data", (chunk) => writes.push(JSON.parse(chunk.toString())));
  const peer = new JsonRpcPeer({ process: fake.managed });
  fake.stdout.write(`${JSON.stringify({ id: 44, method: "item/commandExecution/requestApproval", params: {} })}\n`);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(writes[0], { id: 44, result: { decision: "decline" } });
  await peer.close();
});

test("JSON-RPC malformed frames reject pending work and tear down", async () => {
  const fake = fakeManaged();
  const peer = new JsonRpcPeer({ process: fake.managed });
  const pending = peer.request("never");
  fake.stdout.write("{not-json}\n");
  await assert.rejects(pending, /framing failed.*invalid JSON object/);
  assert.equal(fake.terminated, true);
});

test("JSON-RPC oversized frames reject pending work and tear down", async () => {
  const fake = fakeManaged();
  const peer = new JsonRpcPeer({ process: fake.managed, maxFrameBytes: 8 });
  const pending = peer.request("never");
  fake.stdout.write("123456789");
  await assert.rejects(pending, /framing failed.*exceeds 8 bytes/);
  assert.equal(fake.terminated, true);
});

test("JSON-RPC close rejects pending requests immediately", async () => {
  const fake = fakeManaged();
  const peer = new JsonRpcPeer({ process: fake.managed });
  const pending = peer.request("never", {}, 60_000);
  await peer.close();
  await assert.rejects(pending, /peer closed/);
  assert.equal(fake.terminated, true);
});

test("JSON-RPC stdin errors reject pending requests and trigger teardown", async () => {
  const fake = fakeManaged();
  const peer = new JsonRpcPeer({ process: fake.managed });
  const pending = peer.request("never");
  fake.stdin.emit("error", new Error("EPIPE"));
  await assert.rejects(pending, /stdin failed: EPIPE/);
  assert.equal(fake.terminated, true);
});
