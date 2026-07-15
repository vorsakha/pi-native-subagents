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
    const loaded = loadRoles(dir, ["reviewer"]);
    assert.deepEqual([...loaded.keys()], ["reviewer"]);
    assert.equal(loaded.get("reviewer")?.access, "readOnly");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
