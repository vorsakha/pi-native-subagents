#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeBackend } from "../src/backends/claude.ts";
import { CodexAppServerBackend } from "../src/backends/codex.ts";
import { PiRpcBackend } from "../src/backends/pi-rpc.ts";
import { sanitizeSubscriptionEnv } from "../src/env.ts";
import { JsonRpcPeer } from "../src/jsonrpc.ts";
import { spawnManaged } from "../src/process-tree.ts";

const accessMode = process.argv[2] === "access";
const requested = accessMode ? process.argv[3] : process.argv[2];
const names = requested ? [requested] : accessMode ? ["claude", "codex"] : ["pi", "claude", "codex"];
const live = process.env.PI_NATIVE_SUBAGENTS_LIVE === "1";
const root = mkdtempSync(join(tmpdir(), "pi-native-subagents-smoke-"));

function available(command) {
  try { execFileSync("sh", ["-c", `command -v "$1" >/dev/null`, "sh", command], { stdio: "ignore", timeout: 5_000 }); return true; }
  catch { return false; }
}

function verifyAuth(name) {
  if (name === "claude") {
    const status = JSON.parse(execFileSync("claude", ["auth", "status", "--json"], { encoding: "utf8", timeout: 10_000 }));
    if (!status.loggedIn || status.authMethod !== "claude.ai") throw new Error("Claude subscription login is required");
    return "claude.ai subscription";
  }
  if (name === "codex") {
    const result = spawnSync("codex", ["login", "status"], { encoding: "utf8", timeout: 10_000 });
    const status = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    if (result.error || result.status !== 0 || !/ChatGPT/i.test(status)) throw new Error("Codex ChatGPT login is required");
    return "ChatGPT subscription";
  }
  return "openai-codex subscription route";
}

function policy(name, access = "readOnly") {
  const common = {
    backend: name,
    access,
    thinking: accessMode ? "medium" : "low",
    effort: accessMode ? "medium" : "low",
    piTools: [],
    claudeTools: access === "full"
      ? ["Read", "Write", "Edit", "Bash"]
      : accessMode && name === "claude" ? ["Read", "Glob", "Grep", "Write", "Bash"] : [],
    approvalPolicy: "never",
    codexSandbox: access === "full" ? { type: "dangerFullAccess" } : { type: "readOnly", networkAccess: false },
  };
  return {
    ...common,
    model: name === "pi"
      ? "openai-codex/gpt-5.6-luna"
      : name === "claude"
        ? accessMode ? "sonnet" : "haiku"
        : accessMode && access === "readOnly" ? "gpt-5.6-sol" : access === "full" ? "gpt-5.6-terra" : "gpt-5.6-luna",
  };
}

function backend(name) {
  return name === "pi" ? new PiRpcBackend() : name === "claude" ? new ClaudeBackend() : new CodexAppServerBackend();
}

async function within(promise, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

async function probeCodexReadOnlySandbox(cwd, deniedFile) {
  const managed = spawnManaged("codex", ["app-server", "--stdio"], {
    cwd,
    env: sanitizeSubscriptionEnv(process.env, "codex"),
  });
  const peer = new JsonRpcPeer({
    process: managed,
    onRequest: () => ({ decision: "decline" }),
  });
  try {
    await within(peer.request("initialize", { clientInfo: { name: "pi-native-subagents-smoke", version: "0.1.0" } }, 10_000), 15_000, "Codex probe initialize");
    peer.notify("initialized");
    let denied = false;
    try {
      const result = await peer.request("command/exec", {
        command: [process.execPath, "-e", `require("node:fs").writeFileSync(${JSON.stringify(deniedFile)}, "DENIED_WRITE")`],
        cwd,
        sandboxPolicy: { type: "readOnly", networkAccess: false },
        timeoutMs: 10_000,
        outputBytesCap: 4_096,
      }, 20_000);
      const record = result && typeof result === "object" ? result : {};
      if (!Number.isInteger(record.exitCode)) throw new Error("Codex command/exec returned no exit code");
      denied = record.exitCode !== 0;
    } catch (error) {
      if (!/sandbox|denied|read.?only|permission|operation not permitted/i.test(String(error?.message ?? error))) throw error;
      denied = true;
    }
    if (!denied) throw new Error("Codex read-only command/exec write unexpectedly exited zero");
  } finally {
    try { await within(peer.close(), 10_000, "Codex probe close"); }
    catch { await within(managed.terminate(0), 5_000, "Codex probe forced cleanup").catch(() => undefined); }
  }
  if (existsSync(deniedFile)) throw new Error("Codex read-only command/exec sandbox allowed a controlled write");
}

async function execute(name, cwd, task, systemPrompt, access) {
  const terminal = [];
  const startupController = new AbortController();
  const run = await backend(name).start({
    jobId: `smoke-${name}-${access}`, name: `smoke-${access}`, task, systemPrompt, cwd,
    policy: policy(name, access), env: name === "pi" ? sanitizeSubscriptionEnv(process.env, "codex") : process.env,
    signal: startupController.signal,
  }, (event) => {
    if (["completed", "failed", "cancelled"].includes(event.type)) terminal.push(event);
  });
  try {
    await within(run.completed, 120_000, `${name} live run`);
  } catch (error) {
    try { await within(run.cancel(`${name} live smoke timed out or failed`), 10_000, `${name} cancellation`); }
    catch { if (run.forceClose) await within(run.forceClose(), 5_000, `${name} forced cleanup`).catch(() => undefined); }
    throw error;
  } finally {
    try { await within(run.close(), 10_000, `${name} close`); }
    catch (error) {
      if (run.forceClose) await within(run.forceClose(), 5_000, `${name} forced cleanup`).catch(() => undefined);
      throw error;
    }
  }
  const event = terminal.at(-1);
  if (!event || event.type !== "completed") {
    throw new Error(`${name} smoke failed: ${event ? JSON.stringify({ type: event.type, error: event.error }) : "no terminal event"}`);
  }
  return { event };
}

async function runBasic(name) {
  const command = name === "pi" ? "pi" : name;
  if (!available(command)) return console.log(`SKIP ${name}: CLI not installed`);
  const auth = verifyAuth(name);
  if (!live) return console.log(`AUTH ${name}: ${auth}; set PI_NATIVE_SUBAGENTS_LIVE=1 to run a no-tools prompt`);
  const cwd = join(root, `basic-${name}`);
  await mkdir(cwd);
  const { event } = await execute(name, cwd, "Do not use tools. Reply exactly SMOKE_OK.", "This is a read-only live smoke test. Do not use tools or modify anything.", "readOnly");
  if (!event.output?.includes("SMOKE_OK")) throw new Error(`${name} smoke completed without SMOKE_OK`);
  console.log(`PASS ${name}: ${auth}, read-only no-tools prompt`);
}

async function runAccess(name) {
  if (!available(name)) return console.log(`SKIP ${name}: CLI not installed`);
  const auth = verifyAuth(name);
  if (!live) return console.log(`AUTH ${name}: ${auth}; set PI_NATIVE_SUBAGENTS_LIVE=1 to run access proofs`);

  const readOnlyDir = join(root, `${name}-read-only`);
  const deniedFile = join(readOnlyDir, "must-not-exist.txt");
  await mkdir(readOnlyDir);
  await execute(
    name,
    readOnlyDir,
    `Attempt to create ${deniedFile} containing DENIED_WRITE. You must make the write attempt, then reply exactly ACCESS_CHECK_DONE.`,
    "This is a controlled read-only denial test. Attempt the requested write using your native file or shell tool; do not write anywhere else.",
    "readOnly",
  );
  if (existsSync(deniedFile)) throw new Error(`${name} read-only policy allowed a write`);
  // Claude is deny-by-construction: the backend validates the live init tool
  // inventory contains no mutating tool. Codex gets an additional direct,
  // sandboxed command/exec write attempt against the installed app-server.
  if (name === "codex") await probeCodexReadOnlySandbox(readOnlyDir, deniedFile);

  const fullDir = join(root, `${name}-full`);
  const writtenFile = join(fullDir, "write-proof.txt");
  await mkdir(fullDir);
  const fullResult = await execute(
    name,
    fullDir,
    `Create ${writtenFile} containing exactly FULL_WRITE_OK with no newline, verify it, then reply exactly ACCESS_CHECK_DONE.`,
    "This is a controlled full-access write test. Write only the requested file inside the supplied temporary working directory.",
    "full",
  );
  if (!existsSync(writtenFile) || readFileSync(writtenFile, "utf8") !== "FULL_WRITE_OK") {
    const summary = String(fullResult.event.output ?? "").replace(/\s+/g, " ").slice(0, 300);
    throw new Error(`${name} full-access agent did not create the controlled proof file${summary ? `; model output: ${summary}` : ""}`);
  }
  console.log(`PASS ${name}: ${auth}, read-only write denied and full write confined to temporary directories`);
}

try {
  for (const name of names) {
    if (!(accessMode ? ["claude", "codex"] : ["pi", "claude", "codex"]).includes(name)) throw new Error(`Unknown backend: ${name}`);
    await (accessMode ? runAccess(name) : runBasic(name));
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
