/**
 * The one switch that decides whether this application reports to Google Analytics, and the one
 * property it reports to.
 *
 * The measurement id is a constant rather than configuration because a single image is built per
 * commit and promoted unchanged to every environment: a build-time variable could not differ
 * between them, and a runtime one would have to travel through the Server for a value that never
 * changes. The consequence is accepted rather than hidden — staging and production report into the
 * same property, and are told apart in Google Analytics by hostname.
 *
 * The host guard is what keeps that property honest. A production bundle is also what the
 * end-to-end suite serves from `apps/web/dist` over loopback and what a local preview serves;
 * measuring either would file rehearsals as traffic. It is also a correctness requirement rather
 * than only a hygiene one: the end-to-end fixture fails a test on any request that fails, and a
 * gtag.js request from an offline or egress-restricted runner is exactly such a request.
 */
export const ANALYTICS_MEASUREMENT_ID = "G-RMDF361W1B";

/**
 * The only site this measures: OpenTag's own, and its subdomains.
 *
 * An allowlist rather than a loopback exclusion, because OpenTag is open source and meant to be
 * self-hosted. Excluding only loopback would mean every self-hosted deployment quietly reported its
 * operators' and their readers' activity into this property — data nobody asked to send and nobody
 * here wants to hold. It also fails in the safe direction: a host nobody listed is not measured,
 * which is a silent gap rather than a silent leak.
 *
 * It covers the end-to-end stack and local previews for free, since neither runs on this domain.
 */
const MEASURED_HOST_SUFFIX = "opentag.build";

export function isMeasuredHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === MEASURED_HOST_SUFFIX || host.endsWith(`.${MEASURED_HOST_SUFFIX}`);
}

/**
 * Whether this document should be measured at all. A development server is excluded by the build
 * mode, and every loopback origin by the host, so nothing below this point has to ask again.
 */
export function analyticsEnabled(target: Window = window): boolean {
  return import.meta.env.PROD && isMeasuredHost(target.location.hostname);
}
