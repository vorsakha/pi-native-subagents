import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRoles } from "../src/roles.ts";

test("known reviewer/scout roles are forced read-only and process allowlist filters roles", () => {
  const dir = mkdtempSync(join(tmpdir(), "native-roles-"));
  try {
    for (const name of ["reviewer", "worker"]) {
      writeFileSync(join(dir, `${name}.md`), `---\nname: ${name}\naccess: full\n---\nx\n`);
    }
    writeFileSync(join(dir, "adversary.md"), "---\nname: adversary\naccess: full\nbackend: claude\nprovider_strategy: different_from_parent\n---\nx\n");
    const loaded = loadRoles(dir, ["reviewer", "adversary"]);
    assert.deepEqual([...loaded.keys()], ["adversary", "reviewer"]);
    assert.equal(loaded.get("reviewer")?.access, "readOnly");
    assert.equal(loaded.get("adversary")?.access, "readOnly");
    assert.equal(loaded.get("adversary")?.differentProviderFromParent, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
