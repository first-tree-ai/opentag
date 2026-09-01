import { basename, dirname, isAbsolute } from "node:path";

/**
 * How this OpenTag CLI was installed. The portable shim exports `OPENTAG_INSTALL_MODE=portable`
 * with the install root and shim directory; anything else is an npm-global install. Detection is
 * fail-closed: a malformed portable environment disables automatic upgrades rather than upgrading
 * an install whose layout is unknown.
 */
export type InstallMode = { mode: "portable"; root: string; binDir: string } | { mode: "npm-global" };

export function detectInstallMode(environment: NodeJS.ProcessEnv = process.env): InstallMode {
  if (environment.OPENTAG_INSTALL_MODE === "portable") {
    const root = environment.OPENTAG_PORTABLE_ROOT;
    const binDir = environment.OPENTAG_PORTABLE_BIN_DIR;
    if (root && isAbsolute(root) && binDir && isAbsolute(binDir)) {
      // The managed installer shim historically exports its stable `<prefix>/current` path. Keep
      // that environment contract while normalizing the updater's layout root to `<prefix>`.
      return { mode: "portable", root: basename(root) === "current" ? dirname(root) : root, binDir };
    }
  }
  return { mode: "npm-global" };
}
