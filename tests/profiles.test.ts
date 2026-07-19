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
    writeFileSync(join(global, "audit.md"), "---\nname: audit\ndescription: global\naccess: readOnly\nbackend: claude\nmodelTier: quality\neffort: high\n---\nglobal instructions\n");
    writeFileSync(join(project, "audit.md"), "---\nname: audit\ndescription: project\naccess: full\nbackend: codex\nindependent: false\n---\nproject instructions\n");
    writeFileSync(join(project, "bad.md"), "---\nname: bad\naccess: root\n---\ninvalid\n");
    const loaded = loadProfiles(global, project);
    assert.equal(loaded.profiles.size, 1);
    assert.equal(loaded.profiles.get("audit")?.origin, "project");
    assert.equal(loaded.profiles.get("audit")?.systemPrompt, "project instructions");
    assert.equal(loaded.warnings.length, 1);
    assert.match(loaded.warnings[0]?.message ?? "", /Invalid access/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
