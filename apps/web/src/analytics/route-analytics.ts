import { type AnalyticsReporter, analytics } from "./analytics.js";
import { analyticsPageLocation } from "./page-location.js";

/**
 * The part of the router this needs, written structurally so the analytics module does not import
 * the router — which imports the generated route tree, which imports most of the application.
 */
export interface ResolvedRouteSubscriber {
  subscribe(event: "onResolved", listener: () => void): () => void;
}

/**
 * Report a page view per resolved route.
 *
 * A single-page application navigates without loading a document, so the tag would otherwise record
 * one page view for a whole visit. The reported location is the sanitized one, and the referrer of
 * an in-application navigation is the page actually navigated from rather than `document.referrer`,
 * which keeps naming whatever site the visit originally arrived from.
 *
 * Reporting is keyed on the sanitized location rather than on the event, so the first resolve after
 * installation cannot be counted twice, and a re-resolve that lands on the same low-cardinality
 * path — a search parameter changing, a redirect settling — is not a second page view.
 */
export function installRouteAnalytics(
  router: ResolvedRouteSubscriber,
  target: Window = window,
  reporter: AnalyticsReporter = analytics,
): () => void {
  let lastReported: string | undefined;
  let previousHref: string | undefined;
  const report = () => {
    const href = target.location.href;
    const location = analyticsPageLocation(href);
    if (!location || location === lastReported) return;
    lastReported = location;
    reporter.page({
      href,
      origin: target.location.origin,
      referrer: previousHref ?? target.document.referrer,
      title: target.document.title,
    });
    previousHref = href;
  };
  report();
  return router.subscribe("onResolved", report);
}
