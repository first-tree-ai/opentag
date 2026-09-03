import { parseSemVer } from "./semver.js";

/** Minimum Client release line admitted by Computer connect-code exchange and runtime registration. */
export const MINIMUM_SUPPORTED_CLIENT_VERSION = "0.0.2";

/** Uses SemVer precedence: prereleases of 0.0.2 remain below the supported 0.0.2 floor. */
export function isSupportedClientVersion(value: string): boolean {
  const parsed = parseSemVer(value);
  if (!parsed) return false;
  if (parsed.major > 0) return true;
  if (parsed.minor > 0) return true;
  if (parsed.patch > 2) return true;
  return parsed.patch === 2 && parsed.prerelease.length === 0;
}

export function unsupportedClientVersionMessage(): string {
  return `Client version must be ${MINIMUM_SUPPORTED_CLIENT_VERSION} or newer`;
}
