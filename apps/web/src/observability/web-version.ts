/**
 * The release identity the Web App stamps into error reports.
 *
 * Image builds pass the commit SHA (or a release tag) through `OPENTAG_WEB_VERSION`; only a plain
 * local build falls back to the manifest version, which is a placeholder rather than a release.
 */
export function resolveWebVersion(env: Record<string, string | undefined>, fallback: string): string {
  const configured = env.OPENTAG_WEB_VERSION?.trim();
  return configured ? configured : fallback;
}
