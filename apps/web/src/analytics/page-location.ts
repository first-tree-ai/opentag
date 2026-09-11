/**
 * What a measured page is allowed to say about the URL it is.
 *
 * Google Analytics reports the raw `window.location.href` unless it is given something else, and
 * this application's URLs name Agents, Tasks and Computers by uuid, carry a `next` destination
 * through sign-in, carry provider errors back from OAuth, and — under `/invites` — carry a token
 * that grants access to an Account.
 *
 * The location is therefore built from the *matched route*, never from the address. Classifying the
 * address by shape was tried and is not sound: a route may declare a free-form parameter, so
 * `/agents/<uuid>/settings/<anything>` matches and renders, and no rule over segment length or
 * character set can tell a section name from a secret. Projecting the declared path instead means a
 * value can only be reported if a route was written to name it, which is a decision somebody makes
 * on purpose rather than a filter that has to anticipate every shape.
 */
const NOT_FOUND_PATH = "/(not-found)";

/**
 * Campaign parameters are the deliberate exception, and even they are not trusted.
 *
 * They are the reason a marketing site is measured and they are written by whoever built the link —
 * which is also why their values are caller-controlled rather than safe. Google's own guidance is
 * that these must not carry personal data, so anything address-shaped or implausibly long is
 * dropped rather than forwarded on the assumption that whoever tagged the link read that guidance.
 */
const CAMPAIGN_PARAMETERS = new Set([
  "dclid",
  "gbraid",
  "gclid",
  "srsltid",
  "utm_campaign",
  "utm_content",
  "utm_id",
  "utm_medium",
  "utm_source",
  "utm_term",
  "wbraid",
]);
const CAMPAIGN_VALUE_MAX_LENGTH = 100;

export { NOT_FOUND_PATH };

/**
 * A matched route's declared path, as the template a report groups by: `/agents/$agentId` becomes
 * `/agents/:agentId`. The parameter keeps its name, which says more than `:id` does and still names
 * nobody, because the name comes from the route file rather than from the address.
 */
export function analyticsRoutePath(fullPath: string): string {
  const trimmed = fullPath.replace(/\/+$/u, "");
  if (!trimmed) return "/";
  return trimmed
    .split("/")
    .map((segment) => (segment.startsWith("$") ? `:${segment.slice(1) || "splat"}` : segment))
    .join("/");
}

/** The absolute location: an origin, a route template, and the campaign parameters that survive. */
export function analyticsLocation(origin: string, path: string, search: string): string {
  const url = new URL(`${origin}${path}`);
  for (const [key, value] of new URLSearchParams(search)) {
    if (CAMPAIGN_PARAMETERS.has(key.toLowerCase()) && isReportableCampaignValue(value)) {
      url.searchParams.append(key, value);
    }
  }
  return url.href;
}

function isReportableCampaignValue(value: string): boolean {
  return value.length > 0 && value.length <= CAMPAIGN_VALUE_MAX_LENGTH && !value.includes("@");
}

/**
 * A referrer, reduced to its origin.
 *
 * Only the origin, because another site's path is that site's data and can carry its identifiers or
 * tokens, and because this application's own paths are reported from the route rather than the
 * address — a referrer read off the document has no route to project onto. An opaque origin, which
 * an Android app or an `about:` document produces, is nothing rather than the string `"null"`.
 */
export function analyticsReferrerOrigin(referrer: string): string | undefined {
  if (!referrer) return undefined;
  try {
    const { origin } = new URL(referrer);
    return origin === "null" ? undefined : origin;
  } catch {
    return undefined;
  }
}
