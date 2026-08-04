import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

interface PackageManifest {
  files?: string[];
  pi?: { skills?: string[] };
}

test("publishes the package-owned native subagents skill", async () => {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as PackageManifest;
  assert.deepEqual(manifest.pi?.skills, ["./skills"]);
  assert.ok(manifest.files?.includes("skills"));

  const skill = await readFile(new URL("../skills/pi-native-subagents/SKILL.md", import.meta.url), "utf8");
  for (const required of [
    "name: pi-native-subagents",
    "subagent_capabilities",
    "parallel",
    "deferred parallel tasks are mandatory",
    "independent: true",
    "maxTurns",
  ]) {
    assert.ok(skill.toLowerCase().includes(required.toLowerCase()), `skill must document ${required}`);
  }
});
