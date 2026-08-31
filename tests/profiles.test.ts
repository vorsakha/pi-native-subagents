import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProfiles } from "../src/profiles.ts";

test("profiles load from global and trusted project directories with project precedence and bounded validation", () => {
  const root = mkdtempSync(join(tmpdir(), "native-profiles-"));
  const global = join(root, "global");
  const project = join(root, "project");
  mkdirSync(global);
  mkdirSync(project);
  try {
    writeFileSync(join(global, "audit.md"), "---\nname: audit\ndescription: global\naccess: readOnly\nharness: claude\neffort: high\n---\nglobal instructions\n");
    writeFileSync(join(project, "audit.md"), "---\nname: audit\ndescription: project\naccess: full\nharness: codex\nspeed: fast\nindependent: false\n---\nproject instructions\n");
    writeFileSync(join(project, "bad.md"), "---\nname: bad\naccess: root\n---\ninvalid\n");
    writeFileSync(join(project, "stale-model.md"), "---\nname: stale-model\nmodelTier: quality\n---\ninvalid\n");
    writeFileSync(join(project, "stale-backend.md"), "---\nname: stale-backend\nbackend: codex\n---\ninvalid\n");
    writeFileSync(join(project, "bad-speed.md"), "---\nname: bad-speed\nspeed: turbo\n---\ninvalid\n");
    const loaded = loadProfiles(global, project);
    assert.equal(loaded.profiles.size, 1);
    assert.equal(loaded.profiles.get("audit")?.origin, "project");
    assert.equal(loaded.profiles.get("audit")?.systemPrompt, "project instructions");
    assert.equal(loaded.profiles.get("audit")?.speed, "fast", "the loader retains speed policy without treating it as request authorization");
    assert.equal(loaded.warnings.length, 4);
    assert.ok(loaded.warnings.some((warning) => /Invalid speed/.test(warning.message)));
    assert.ok(loaded.warnings.some((warning) => /Invalid access/.test(warning.message)));
    assert.equal(loaded.warnings.filter((warning) => /obsolete routing field/.test(warning.message)).length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
