/** Minimum Client release line admitted by Computer connect-code exchange and runtime registration. */
export const MINIMUM_SUPPORTED_CLIENT_VERSION = "0.0.2";

const SEMVER_VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

/** Uses SemVer precedence: prereleases of 0.0.2 remain below the supported 0.0.2 floor. */
export function isSupportedClientVersion(value: string): boolean {
  const match = SEMVER_VERSION.exec(value);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (major > 0) return true;
  if (minor > 0) return true;
  if (patch > 2) return true;
  return patch === 2 && match[4] === undefined;
}

export function unsupportedClientVersionMessage(): string {
  return `Client version must be ${MINIMUM_SUPPORTED_CLIENT_VERSION} or newer`;
}
