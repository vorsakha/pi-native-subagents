import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadModelRouting } from "../src/model-routing.ts";
import { compilePolicy } from "../src/policy.ts";

const request = { task: "x", cwd: "/tmp", trusted: true } as const;
const valid = { modelTiers: {
  codex: { economy: " codex-e ", balanced: "codex-b", quality: "codex-q" },
  claude: { economy: "claude-e", balanced: "claude-b", quality: "claude-q" },
  pi: { economy: "pi-e", balanced: "pi-b", quality: "pi-q" },
} };

test("global model routing validates atomically and falls back safely", async () => {
  const root = await mkdtemp(join(tmpdir(), "model-routing-"));
  const path = join(root, "subagents.json");
  assert.equal(loadModelRouting(path).source, "built-in", "absent config is quiet and safe");
  await writeFile(path, JSON.stringify(valid));
  const loaded = loadModelRouting(path);
  assert.equal(loaded.source, "global");
  assert.equal(loaded.mappings.codex.economy, "codex-e", "values are trimmed");
  for (const invalid of ["{", JSON.stringify({ modelTiers: { codex: valid.modelTiers.codex } }), JSON.stringify({ ...valid, extra: true }), JSON.stringify({ ...valid, modelTiers: { ...valid.modelTiers, pi: { ...valid.modelTiers.pi, extra: "x" } } }), JSON.stringify({ ...valid, modelTiers: { ...valid.modelTiers, claude: { ...valid.modelTiers.claude, economy: " " } } }), JSON.stringify({ ...valid, modelTiers: { ...valid.modelTiers, codex: { ...valid.modelTiers.codex, quality: "x".repeat(257) } } })]) {
    await writeFile(path, invalid);
    const fallback = loadModelRouting(path);
    assert.equal(fallback.source, "built-in");
    assert.equal(fallback.warnings.length, 1);
    assert.equal(fallback.mappings.codex.balanced, "gpt-5.6-terra", "never retain a partial mapping");
  }
});

test("injected tier mappings resolve each backend without changing policy invariants", () => {
  const mappings = loadModelRoutingFromFixture();
  assert.equal(compilePolicy({ ...request, backend: "codex", modelTier: "quality" }, undefined, mappings).policy.model, "codex-q");
  assert.equal(compilePolicy({ ...request, backend: "claude", modelTier: "economy" }, undefined, mappings).policy.model, "claude-e");
  const pi = compilePolicy({ ...request, backend: "pi", modelTier: "balanced", access: "readOnly" }, undefined, mappings).policy;
  assert.equal(pi.model, "pi-b");
  assert.deepEqual(pi.codexSandbox, { type: "readOnly", networkAccess: false });
});

function loadModelRoutingFromFixture() {
  return {
    codex: { economy: "codex-e", balanced: "codex-b", quality: "codex-q" },
    claude: { economy: "claude-e", balanced: "claude-b", quality: "claude-q" },
    pi: { economy: "pi-e", balanced: "pi-b", quality: "pi-q" },
  };
}
