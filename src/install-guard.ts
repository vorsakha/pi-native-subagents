import { existsSync, realpathSync } from "node:fs";

const INSTALL_KEY = Symbol.for("@vorsakha/pi-native-subagents/active-install");

/** Fail clearly when both the legacy extension and this package are loaded. */
export function claimExtensionInstall(root: string, registry: object = globalThis, legacyRoot?: string): () => void {
  if (legacyRoot && existsSync(legacyRoot) && realpathSync(legacyRoot) !== realpathSync(root)) {
    throw new Error(
      `Pi Native Subagents package at ${root} conflicts with legacy install ${legacyRoot}. `
      + "Move or remove the legacy extension, then restart Pi.",
    );
  }
  const installs = registry as Record<PropertyKey, unknown>;
  const existing = installs[INSTALL_KEY];
  if (existing) {
    throw new Error(
      `Pi Native Subagents is loaded more than once (${existing} and ${root}). `
      + "Remove the legacy ~/.pi/agent/extensions/subagents install or uninstall the duplicate Pi package, then restart Pi.",
    );
  }
  installs[INSTALL_KEY] = root;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (installs[INSTALL_KEY] === root) delete installs[INSTALL_KEY];
  };
}
