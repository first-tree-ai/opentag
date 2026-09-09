import { type AnalyticsReporter, analytics, syncAnalyticsSuppression } from "./analytics.js";
import { analyticsLocation, analyticsReferrerOrigin, analyticsRoutePath, NOT_FOUND_PATH } from "./page-location.js";

/**
 * The part of the router this needs, written structurally so the analytics module does not import
 * the router — which imports the generated route tree, which imports most of the application.
 */
export interface ResolvedRouteSubscriber {
  subscribe(event: "onResolved", listener: () => void): () => void;
  readonly state: {
    readonly location: { readonly pathname: string; readonly searchStr: string };
    readonly matches: readonly { readonly fullPath: string }[];
  };
}

/**
 * Report a page view per resolved route.
 *
 * A single-page application navigates without loading a document, so the tag would otherwise record
 * one page view for a whole visit.
 *
 * The reported path is the *matched route's declared path*, never the address. An address cannot be
 * made safe by inspection: routes here declare free-form parameters, so `/agents/<uuid>/settings/…`
 * matches whatever is in that segment, and `/invites/<token>` renders the not-found page rather than
 * failing to match. Projecting the route means a segment reaches a report only because a route file
 * names it. Anything the router did not match is reported as one constant path, so an unrouted URL
 * contributes a count and nothing else.
 *
 * Reporting is keyed on that location, so the first resolve after installation cannot be counted
 * twice, and a re-resolve landing on the same template is not a second page view. That deliberately
 * makes two Agents one page: the report groups them that way, and a per-object count would be a
 * different measurement than the one this exists to give.
 */
export function installRouteAnalytics(
  router: ResolvedRouteSubscriber,
  target: Window = window,
  reporter: AnalyticsReporter = analytics,
): () => void {
  let lastReported: string | undefined;
  let previousLocation: string | undefined;
  const report = () => {
    const { pathname, searchStr } = router.state.location;
    // Kept in step with the route rather than only at install, so a navigation into or out of a
    // preview surface turns the tag off or on before it can raise anything of its own.
    syncAnalyticsSuppression(pathname, target);
    const { matches } = router.state;
    /*
     * The router resolves asynchronously, and until it has it knows the address but not the route —
     * it holds no matches at all. Reporting then would file the very first page of every visit as
     * unrouted, which is both wrong and the shape a genuine miss has. `onResolved` follows.
     */
    if (matches.length === 0) return;
    const matched = matches.at(-1)?.fullPath ?? "/";
    const path = matched === "/" && pathname !== "/" ? NOT_FOUND_PATH : analyticsRoutePath(matched);
    const location = analyticsLocation(target.location.origin, path, searchStr);
    if (location === lastReported) return;
    lastReported = location;
    reporter.page({
      location,
      path,
      // The page actually navigated from, which is already a template. On the first view of a
      // document there is none, so the referring site is named by origin alone.
      referrer: previousLocation ?? analyticsReferrerOrigin(target.document.referrer),
      title: target.document.title,
    });
    previousLocation = location;
  };
  report();
  return router.subscribe("onResolved", report);
}
