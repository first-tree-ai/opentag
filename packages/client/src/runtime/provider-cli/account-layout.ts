import { userInfo } from "node:os";
import { isAbsolute, join, posix, resolve, win32 } from "node:path";
import type { ProviderCliCatalogArtifact } from "./catalog.js";
import type { ProviderCliProvider } from "./types.js";

/**
 * Account-global Provider CLI layout.
 *
 * The root is derived from the operating-system account record (`userInfo().homedir`),
 * never from caller environment variables or `OPENTAG_HOME`, so every OpenTag Home and
 * the daemon for one OS account observe the same installation. Windows paths are
 * reserved by the schema but are not a supported P0 platform.
 *
 * ```text
 * POSIX:   <account-home>/.opentag/provider-cli/
 * Windows: <account-local-app-data>/OpenTag/provider-cli/   (reserved, not P0)
 * ```
 */
export interface ProviderCliAccountLayout {
  readonly accountHome: string;
  readonly root: string;
  /** Authoritative OpenTag Runtime command directory. */
  readonly bin: string;
  readonly versions: string;
  readonly state: string;
  readonly staging: string;
  /** Reserved for exact-target Turn plans (Provider CLI integration lands separately). */
  readonly plans: string;
  /** OpenTag-owned public shim directory shared with the portable installer. */
  readonly publicBinDir: string;
}

export class ProviderCliAccountError extends Error {
  override readonly name = "ProviderCliAccountError";
}

/**
 * Resolve the operating-system account home from the account record. Injectable so
 * tests and the CLI can point at an isolated account root without touching the real
 * account home.
 */
export function resolveAccountHome(account: { homedir: string } = userInfo()): string {
  if (typeof account.homedir !== "string" || account.homedir.length === 0 || !isAbsolute(account.homedir)) {
    throw new ProviderCliAccountError("The operating-system account record has no usable home directory");
  }
  return resolve(account.homedir);
}

export function resolveProviderCliAccountLayout(
  accountHome: string,
  platform: NodeJS.Platform = process.platform,
): ProviderCliAccountLayout {
  const platformPath = platform === "win32" ? win32 : posix;
  if (accountHome.length === 0 || !platformPath.isAbsolute(accountHome)) {
    throw new ProviderCliAccountError("The Provider CLI account home must be an absolute path");
  }
  const home = platformPath.resolve(accountHome);
  const root =
    platform === "win32"
      ? platformPath.join(home, "AppData", "Local", "OpenTag", "provider-cli")
      : join(home, ".opentag", "provider-cli");
  return {
    accountHome: home,
    root,
    bin: platformPath.join(root, "bin"),
    versions: platformPath.join(root, "versions"),
    state: platformPath.join(root, "state"),
    staging: platformPath.join(root, "staging"),
    plans: platformPath.join(root, "plans"),
    publicBinDir: platformPath.join(home, ".local", "bin"),
  };
}

export function providerCliStateFilePath(layout: ProviderCliAccountLayout, provider: ProviderCliProvider): string {
  return join(layout.state, `${provider}.json`);
}

export function providerCliLockFilePath(layout: ProviderCliAccountLayout, provider: ProviderCliProvider): string {
  return join(layout.state, `${provider}.lock`);
}

export function providerCliLauncherPath(layout: ProviderCliAccountLayout, command: string): string {
  return join(layout.bin, command);
}

export function providerCliStagingDirPath(
  layout: ProviderCliAccountLayout,
  provider: ProviderCliProvider,
  operationId: string,
): string {
  return join(layout.staging, provider, operationId);
}

/**
 * The digest-addressed immutable version directory for one managed artifact:
 * `versions/<provider>/<version>/<platform>-<arch>/<archive-sha256>/`.
 */
export function providerCliArtifactId(artifact: ProviderCliCatalogArtifact, version: string): string {
  return `${version}/${artifact.platform}-${artifact.arch}/${artifact.sha256}`;
}

export function providerCliVersionDirPath(
  layout: ProviderCliAccountLayout,
  provider: ProviderCliProvider,
  artifactId: string,
): string {
  return join(layout.versions, provider, artifactId);
}
