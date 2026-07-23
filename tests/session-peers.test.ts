import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createRealSessionPeerSource } from "../extensions/subagents/index.ts";
import { forkPeerSession, listPeerSessions, MAX_PEER_LIST_LIMIT } from "../src/session-peers.ts";
import type { PeerSessionInfo, SessionPeerSource } from "../src/session-peers.ts";

function fakeSession(overrides: Partial<PeerSessionInfo> = {}): PeerSessionInfo {
  return {
    id: "session",
    path: "/sessions/session.jsonl",
    cwd: "/projects/alpha",
    createdAt: 1_000,
    modifiedAt: 1_000,
    messageCount: 4,
    firstMessage: "investigate the flaky test",
    ...overrides,
  };
}

test("listPeerSessions bounds results, filters by query, and excludes the current session", async (t) => {
  const sessions = [
    fakeSession({ id: "current", name: "Active thread", modifiedAt: 5_000 }),
    fakeSession({ id: "alpha", name: "Refactor plan", cwd: "/projects/alpha", firstMessage: "plan the refactor", modifiedAt: 4_000 }),
    fakeSession({ id: "beta", cwd: "/projects/beta", firstMessage: "investigate flaky auth test", modifiedAt: 3_000 }),
    ...Array.from({ length: 25 }, (_, index) => fakeSession({ id: `bulk-${index}`, firstMessage: `bulk session ${index}`, modifiedAt: index })),
  ];
  const source: Pick<SessionPeerSource, "listAll"> = { listAll: async () => sessions };

  await t.test("excludes the current session and caps at the hard maximum", async () => {
    const peers = await listPeerSessions(source, { excludeSessionId: "current", limit: MAX_PEER_LIST_LIMIT });
    assert.ok(peers.every((peer) => peer.sessionId !== "current"), "current session is never offered");
    assert.equal(peers.length, MAX_PEER_LIST_LIMIT);
    assert.equal(peers[0]!.sessionId, "alpha", "results sort by most recently modified");
  });

  await t.test("an omitted limit defaults to a bounded page, and an oversized limit clamps to the maximum", async () => {
    const defaultBounded = await listPeerSessions(source, { excludeSessionId: "current" });
    assert.equal(defaultBounded.length, 10);
    const overLimit = await listPeerSessions(source, { excludeSessionId: "current", limit: 999 });
    assert.equal(overLimit.length, MAX_PEER_LIST_LIMIT);
  });

  await t.test("query filters across name, first message, and project cwd", async () => {
    const byPreview = await listPeerSessions(source, { excludeSessionId: "current", query: "flaky" });
    assert.deepEqual(byPreview.map((peer) => peer.sessionId), ["beta"]);
    const byName = await listPeerSessions(source, { excludeSessionId: "current", query: "refactor" });
    assert.deepEqual(byName.map((peer) => peer.sessionId), ["alpha"]);
    const byCwd = await listPeerSessions(source, { excludeSessionId: "current", query: "/projects/beta" });
    assert.deepEqual(byCwd.map((peer) => peer.sessionId), ["beta"]);
  });
});

test("forkPeerSession revalidates the id against a fresh listAll snapshot and never trusts a raw path", async () => {
  const known = fakeSession({ id: "alpha", path: "/sessions/alpha.jsonl" });
  let listCalls = 0;
  const forkCalls: Array<{ sourcePath: string; targetCwd: string; sessionDir?: string }> = [];
  const source: SessionPeerSource = {
    listAll: async () => { listCalls++; return [known]; },
    fork: (sourcePath, targetCwd, sessionDir) => {
      forkCalls.push({ sourcePath, targetCwd, sessionDir });
      return { sessionFile: "/forked/new.jsonl", sessionId: "forked-1" };
    },
  };

  await assert.rejects(forkPeerSession(source, { sessionId: "unknown", targetCwd: "/projects/target" }), /Unknown session peer/);
  await assert.rejects(
    forkPeerSession(source, { sessionId: "alpha", targetCwd: "/projects/target", currentSessionId: "alpha" }),
    /Cannot fork the current session/,
  );
  await assert.rejects(forkPeerSession(source, { sessionId: "  ", targetCwd: "/projects/target" }), /must not be empty/);
  assert.equal(forkCalls.length, 0, "no fork side effect happens for a rejected request");

  const duplicated: SessionPeerSource = { listAll: async () => [known, { ...known }], fork: source.fork };
  await assert.rejects(forkPeerSession(duplicated, { sessionId: "alpha", targetCwd: "/projects/target" }), /Ambiguous session peer id/);

  const resolved = await forkPeerSession(source, { sessionId: "alpha", targetCwd: "/projects/target" });
  assert.equal(resolved.sessionFile, "/forked/new.jsonl");
  assert.equal(resolved.sessionId, "forked-1");
  assert.equal(resolved.source.id, "alpha");
  assert.deepEqual(forkCalls, [{ sourcePath: "/sessions/alpha.jsonl", targetCwd: "/projects/target", sessionDir: undefined }]);
  assert.equal(listCalls, 2, "unknown and successful ids are each resolved against a fresh listAll snapshot");
});

test("forkPeerSession forks the active branch via the real SessionManager API without mutating the source", async () => {
  const root = mkdtempSync(join(tmpdir(), "session-peers-"));
  const sourceSessionDir = join(root, "source-sessions");
  const targetSessionDir = join(root, "target-sessions");
  try {
    const sourceManager = SessionManager.create("/projects/alpha", sourceSessionDir);
    sourceManager.appendMessage({ role: "user", content: "what does this endpoint do?", timestamp: Date.now() });
    sourceManager.appendMessage({
      role: "assistant", content: [{ type: "text", text: "It verifies signed requests." }],
      api: "fixture", provider: "fixture", model: "fixture", stopReason: "stop", timestamp: Date.now(),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    });
    sourceManager.appendMessage({ role: "user", content: "and what validates the signature?", timestamp: Date.now() });
    const sourceFile = sourceManager.getSessionFile()!;
    await waitForFile(sourceFile);
    const before = readFileSync(sourceFile, "utf8");
    const beforeMtime = statSync(sourceFile).mtimeMs;

    const peerSource = createRealSessionPeerSource();
    const listed = await listPeerSessions(peerSource, { sessionDir: sourceSessionDir });
    assert.equal(listed.length, 1);
    assert.equal(listed[0]!.messageCount, 3);
    assert.equal(listed[0]!.preview, "what does this endpoint do?");

    const forked = await forkPeerSession(peerSource, {
      sessionId: sourceManager.getSessionId(),
      targetCwd: "/projects/downstream",
      sessionDir: sourceSessionDir,
      forkSessionDir: targetSessionDir,
    });

    assert.notEqual(forked.sessionFile, sourceFile);
    assert.equal(readFileSync(sourceFile, "utf8"), before, "the source session file is never mutated");
    assert.equal(statSync(sourceFile).mtimeMs, beforeMtime, "the source session file is never touched");

    const forkedManager = SessionManager.open(forked.sessionFile);
    const context = forkedManager.buildSessionContext();
    assert.equal(context.messages.length, 3, "the fork preserves the source conversation's active branch");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    try { statSync(path); return; }
    catch { await new Promise((resolve) => setTimeout(resolve, 5)); }
  }
  statSync(path);
}
