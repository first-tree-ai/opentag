import { analyticsRoutePath, NOT_FOUND_PATH } from "../analytics/page-location.js";
import type { ResolvedRouteSubscriber } from "../analytics/route-analytics.js";
import { setErrorReportRoute } from "./error-reporting.js";

/**
 * Keep every error report naming the route it happened on.
 *
 * The report already carries a URL, but an address names objects: `/agents/<uuid>/settings` is a
 * different string for every Agent, so the same defect arrives as a different page each time and
 * groups as nothing. The matched route's declared path is the template those addresses share, which
 * is both what a reader of the tracker wants and the projection this application already trusts for
 * measurement — a segment reaches a report only because a route file names it.
 *
 * Installed beside the route analytics rather than inside it: the two answer to different concerns
 * and one being turned off must not silently take the other with it.
 */
export function installRouteErrorContext(router: ResolvedRouteSubscriber): () => void {
  const record = () => {
    const { matches } = router.state;
    /*
     * The router resolves asynchronously and holds no matches until it has. A failure during that
     * window belongs to no route yet, and saying so is better than attributing it to the root.
     */
    if (matches.length === 0) {
      setErrorReportRoute(undefined);
      return;
    }
    const matched = matches.at(-1)?.fullPath ?? "/";
    const unrouted = matched === "/" && router.state.location.pathname !== "/";
    setErrorReportRoute(unrouted ? NOT_FOUND_PATH : analyticsRoutePath(matched));
  };
  record();
  return router.subscribe("onResolved", record);
}
