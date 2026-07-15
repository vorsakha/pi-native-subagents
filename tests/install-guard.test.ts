import test from "node:test";
import assert from "node:assert/strict";
import { claimExtensionInstall } from "../src/install-guard.ts";

test("duplicate extension installs fail with migration guidance", () => {
  const registry = {};
  const release = claimExtensionInstall("/new/package", registry);
  assert.throws(
    () => claimExtensionInstall("/legacy/extension", registry),
    /loaded more than once.*Remove the legacy/s,
  );
  release();
  assert.doesNotThrow(() => claimExtensionInstall("/new/package", registry));
});
