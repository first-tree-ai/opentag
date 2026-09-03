import { readdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { createLogger } from "../observability/logger.js";
import { protectedRoots, type ReadLink, resolveOutsideProtectedRoots } from "./protected-paths.js";

/** Injectable directory listing so tests need no real version-manager install. */
export type ReadDirNames = (path: string) => string[];

/**
 * What the login shell reported about the version manager it had active.
 * `nvmBin` names the selected version outright; `fnmDir` names only the root it
 * was selected from, leaving the version still to be determined.
 */
export type ActiveVersionManager = { fnmDir?: string; nvmBin?: string };

/** Injectable seams so tests need neither a real install nor a real filesystem. */
export type VersionManagerDirDeps = {
  active?: ActiveVersionManager;
  readDir?: ReadDirNames;
  readLink?: ReadLink;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
};

type RootScan = { kind: "skip" } | { kind: "ambiguous" } | { kind: "one"; dir: string };
const logger = createLogger("runtime-install-locations");

/**
 * The `bin` dir to fall back to when a version manager's per-session `$PATH`
 * entry is gone, or nothing when the selected version cannot be established.
 *
 * The answer must never be a guess. Resolving a version the user did not select
 * silently swaps the executable and its context, which is worse than reporting
 * the provider as not found, so the decision is made across the complete state
 * rather than per root:
 *
 *   - The login shell reported exactly one manager. Only that is used.
 *     `$NVM_BIN` names the selected version outright and is authoritative,
 *     replacing any nvm enumeration. `$FNM_DIR` names only the active root, so
 *     that root — and no other — is consulted, and it answers only if it holds
 *     exactly one version. Default roots are not scanned at all: if we know
 *     which manager is active and it cannot answer, an unrelated installation
 *     is not a better answer.
 *   - The login shell reported BOTH managers. Which one was active was decided
 *     by the live `$PATH` order, which is exactly what is no longer available,
 *     so neither answers.
 *   - The login shell reported nothing. The default roots are scanned and the
 *     result is used only when there is exactly ONE safe candidate in total.
 *     Any safe root holding more than one version, or two single-version roots,
 *     is globally ambiguous.
 *
 * It is a FALLBACK, not a preference: callers search it only after the
 * login-shell dirs, so a live selection always wins.
 *
 * Every root is vetted with the injected platform/home protected roots before
 * it is listed, and every candidate before it is returned. Nothing is trusted
 * for being spelled like a version manager.
 */
export function versionManagerBinDirs(home: string, deps: VersionManagerDirDeps = {}): string[] {
  const readDir = deps.readDir ?? ((path: string) => readdirSync(path));
  const readLink = deps.readLink;
  const env = deps.env ?? process.env;
  const active = deps.active ?? {};
  const platform = deps.platform ?? process.platform;
  const rootsHome = deps.home ?? home;
  const protectedRootList = protectedRoots(platform, rootsHome);

  const safe = (path: string): string | null => {
    if (!isAbsolute(path)) return null;
    if (protectedRootList.length === 0) return path;
    return resolveOutsideProtectedRoots(path, protectedRootList, readLink);
  };

  const scanRoot = (root: string, layout: (versionsRoot: string, version: string) => string): RootScan => {
    const vetted = safe(root);
    if (vetted === null) return { kind: "skip" };
    let entries: string[];
    try {
      entries = readDir(vetted);
    } catch (error) {
      logger.debug(
        { code: "version_manager_scan_failed", error: String(error) },
        "Version manager directory scan failed",
      );
      return { kind: "skip" };
    }
    if (entries.length === 0) return { kind: "skip" };
    if (entries.length !== 1 || entries[0] === undefined) return { kind: "ambiguous" };
    const candidate = layout(vetted, entries[0]);
    const vettedCandidate = safe(candidate);
    if (vettedCandidate === null) return { kind: "skip" };
    return { kind: "one", dir: vettedCandidate };
  };

  const nvmLayout = (versionsRoot: string, version: string): string => join(versionsRoot, version, "bin");
  const fnmLayout = (versionsRoot: string, version: string): string =>
    join(versionsRoot, version, "installation", "bin");

  if (active.nvmBin !== undefined || active.fnmDir !== undefined) {
    if (active.nvmBin !== undefined && active.fnmDir !== undefined) return [];
    if (active.nvmBin !== undefined) {
      const vetted = safe(active.nvmBin);
      return vetted === null ? [] : [vetted];
    }
    const scanned = scanRoot(join(active.fnmDir ?? "", "node-versions"), fnmLayout);
    return scanned.kind === "one" ? [scanned.dir] : [];
  }

  const defaultRoots: Array<[string, (versionsRoot: string, version: string) => string]> = [
    [join(home, ".nvm", "versions", "node"), nvmLayout],
    ...[
      env.FNM_DIR,
      join(home, ".local", "share", "fnm"),
      join(home, "Library", "Application Support", "fnm"),
      join(home, ".fnm"),
    ]
      .filter((root): root is string => typeof root === "string" && root.length > 0)
      .map((root): [string, (versionsRoot: string, version: string) => string] => [
        join(root, "node-versions"),
        fnmLayout,
      ]),
  ];

  const seen = new Set<string>();
  const scans: RootScan[] = [];
  for (const [root, layout] of defaultRoots) {
    if (seen.has(root)) continue;
    seen.add(root);
    scans.push(scanRoot(root, layout));
  }
  if (scans.some((scan) => scan.kind === "ambiguous")) return [];
  const ones = scans.filter((scan): scan is { kind: "one"; dir: string } => scan.kind === "one");
  const only = ones.length === 1 ? ones[0] : undefined;
  return only ? [only.dir] : [];
}
