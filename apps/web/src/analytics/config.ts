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

/** Hosts that only ever serve a rehearsal: the end-to-end stack, a local preview, a dev server. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"]);

export function isMeasuredHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host.length > 0 && !LOOPBACK_HOSTS.has(host) && !host.endsWith(".localhost");
}

/**
 * Whether this document should be measured at all. A development server is excluded by the build
 * mode, and every loopback origin by the host, so nothing below this point has to ask again.
 */
export function analyticsEnabled(target: Window = window): boolean {
  return import.meta.env.PROD && isMeasuredHost(target.location.hostname);
}
