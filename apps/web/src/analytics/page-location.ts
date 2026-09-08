import { routeTemplate } from "../observability/diagnostics.js";

/**
 * What a measured page is allowed to say about the URL it is.
 *
 * Google Analytics reports the raw `window.location.href` unless it is given something else, and
 * this application's URLs name Agents, Tasks and Computers by uuid, carry a `next` destination
 * through sign-in, and carry provider errors back from OAuth. None of that belongs in a third
 * party's records, and none of it is worth having there: a report grouped by
 * `/agents/:id/tasks/:id` answers which surface people use, while one grouped by every distinct
 * uuid answers nothing at all.
 *
 * Campaign parameters are the deliberate exception. They are the reason a marketing site is
 * measured, they are written by whoever built the link rather than by this application, and they
 * name no one. Everything else in the query string is dropped, so a parameter added later is
 * private until someone chooses otherwise.
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

/**
 * The shortest path segment this treats as opaque.
 *
 * `routeTemplate` reduces uuids and integers, which is what a diagnostic needs. It is not enough
 * here: `/invites/<token>` is a real route this application serves, and its token is a credential —
 * forty-three characters that grant access to an Account. This application's own path segments are
 * short words (`integrations`, the longest, is twelve), so anything at or past this length is not a
 * route name, and reducing it costs a report nothing while a leaked one cannot be taken back.
 */
const OPAQUE_SEGMENT_LENGTH = 16;
const TOKEN_SEGMENT = /^[A-Za-z0-9_-]+$/;

/** The low-cardinality path a report groups by: every identifying segment becomes `:id`. */
export function analyticsPagePath(pathname: string): string {
  return routeTemplate(pathname)
    .split("/")
    .map((segment) => (segment.length >= OPAQUE_SEGMENT_LENGTH && TOKEN_SEGMENT.test(segment) ? ":id" : segment))
    .join("/");
}

/**
 * The absolute location, rebuilt rather than trimmed. Starting from the parts that are allowed to
 * survive means a URL shape nobody anticipated cannot leak through a filter that failed to match.
 */
export function analyticsPageLocation(href: string, base?: string): string | undefined {
  const url = parseUrl(href, base);
  if (!url) return undefined;
  const sanitized = new URL(`${url.origin}${analyticsPagePath(url.pathname)}`);
  for (const [key, value] of url.searchParams) {
    if (CAMPAIGN_PARAMETERS.has(key.toLowerCase())) sanitized.searchParams.append(key, value);
  }
  return sanitized.href;
}

/**
 * The referrer, held to the same rule when it is one of this application's own pages and reduced to
 * a bare origin when it is not. An external referrer's own path is somebody else's data and can
 * carry their identifiers or tokens; the origin is the whole of what attribution needs.
 */
export function analyticsPageReferrer(referrer: string, origin: string): string | undefined {
  const url = parseUrl(referrer);
  if (!url) return undefined;
  return url.origin === origin ? analyticsPageLocation(url.href) : url.origin;
}

function parseUrl(value: string, base?: string): URL | undefined {
  if (!value) return undefined;
  try {
    return new URL(value, base);
  } catch {
    return undefined;
  }
}
