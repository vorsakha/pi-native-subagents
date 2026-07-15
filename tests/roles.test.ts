import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadRoles, parseAllowedRoles } from "../src/roles.ts";

test("role loader parses routes, prompts, and legacy nested allowlists", () => {
  const dir = mkdtempSync(join(tmpdir(), "native-roles-"));
  try {
    writeFileSync(join(dir, "worker.md"), `---\nname: worker\ndescription: test\naccess: full\nbackend: pi\nsubagent_agents: scout, researcher\npi_tools: read, write\nclaude_tools: Read, Write\npi_model: p\nclaude_model: c\ncodex_model: x\n---\nPrompt body\n`);
    const loaded = loadRoles(dir);
    const worker = loaded.get("worker")!;
    assert.equal(worker.defaultBackend, "pi");
    assert.deepEqual(worker.nestedAgents, ["scout", "researcher"]);
    assert.equal(worker.routes.claude.model, "c");
    assert.equal(worker.systemPrompt, "Prompt body");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("known reviewer/scout roles are forced read-only and process allowlist filters roles", () => {
  const dir = mkdtempSync(join(tmpdir(), "native-roles-"));
  try {
    for (const name of ["reviewer", "worker"]) {
      writeFileSync(join(dir, `${name}.md`), `---\nname: ${name}\naccess: full\n---\nx\n`);
    }
    const loaded = loadRoles(dir, ["reviewer"]);
    assert.deepEqual([...loaded.keys()], ["reviewer"]);
    assert.equal(loaded.get("reviewer")?.access, "readOnly");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("shipped roles preserve routing, access, tiers, and worker nested allowlist", () => {
  const directory = resolve(dirname(fileURLToPath(import.meta.url)), "../agents");
  const roles = loadRoles(directory);
  assert.deepEqual([...roles.keys()].sort(), ["adversary", "brainstormer", "claudio", "researcher", "reviewer", "scout", "worker"]);
  assert.equal(roles.get("scout")?.defaultBackend, "codex");
  assert.equal(roles.get("scout")?.routes.codex.model, "gpt-5.6-luna");
  assert.equal(roles.get("reviewer")?.routes.codex.model, "gpt-5.6-sol");
  assert.equal(roles.get("reviewer")?.routes.codex.thinking, "medium");
  assert.equal(roles.get("reviewer")?.routes.codex.effort, "medium");
  assert.equal(roles.get("reviewer")?.routes.pi.thinking, "medium");
  assert.equal(roles.get("brainstormer")?.routes.claude.model, "sonnet");
  assert.equal(roles.get("adversary")?.lockedBackend, "claude");
  assert.deepEqual(roles.get("worker")?.nestedAgents, ["scout", "researcher"]);
  for (const name of ["scout", "researcher", "reviewer", "brainstormer", "claudio", "adversary"]) {
    assert.equal(roles.get(name)?.access, "readOnly", name);
  }
});

test("allowlist environment supports standalone and legacy variable names", () => {
  assert.deepEqual(parseAllowedRoles({ PI_NATIVE_SUBAGENTS_ALLOWED: "scout, researcher" }), ["scout", "researcher"]);
  assert.deepEqual(parseAllowedRoles({ PI_SUBAGENT_ALLOWED: "worker" }), ["worker"]);
  assert.equal(parseAllowedRoles({}), undefined);
});
