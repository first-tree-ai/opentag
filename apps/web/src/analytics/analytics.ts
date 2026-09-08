import { ANALYTICS_MEASUREMENT_ID, analyticsEnabled, analyticsTrafficType } from "./config.js";
import { ANALYTICS_EVENT } from "./events.js";
import { type AnalyticsParams, type AnalyticsSink, appendGtagScript, dataLayerSink } from "./gtag.js";

/**
 * The preview surfaces. Everything under `/internal` is a staging-only lab that drives the real
 * components against in-memory adapters, so an Agent "created" there is not an Agent and a Computer
 * "connected" there is nobody's Computer. Rehearsals are refused here, once, rather than at each of
 * the call sites that a lab and a reader share.
 */
const PREVIEW_PATH_PREFIX = "/internal";

export function isPreviewPath(pathname: string): boolean {
  return pathname.startsWith(PREVIEW_PATH_PREFIX);
}

/**
 * Turn the tag itself off while a preview surface is on screen, and on again when it is not.
 *
 * Refusing this application's own calls is not the same as reporting nothing. Enhanced Measurement
 * is on by default and raises scroll, outbound-click, file-download and form events of the tag's
 * own accord; `send_page_view: false` does not touch them. So the exclusion is enforced where the
 * tag decides whether to send at all — Google's documented `ga-disable-<id>` flag, which is read at
 * hit time, so keeping it in step with the route covers a direct entry and a later navigation
 * alike.
 */
export function syncAnalyticsSuppression(pathname: string, target: Window = window): void {
  Reflect.set(target, `ga-disable-${ANALYTICS_MEASUREMENT_ID}`, isPreviewPath(pathname));
}

export interface AnalyticsReporterOptions {
  /** Where the reporter reads the current path from, so a test can place itself on a route. */
  readonly location?: () => { readonly pathname: string };
}

/**
 * Reports product milestones to whichever sink is installed, and to nothing at all until one is.
 *
 * Inert by default is what makes this safe to import from anywhere: a unit test that renders a page
 * gets a reporter that records nothing, without mocking the module, and a test that wants to assert
 * on events arms it with a sink of its own. Installation is a separate, explicit step that happens
 * once, in `main.tsx`, and only where measurement is allowed at all.
 */
export class AnalyticsReporter {
  #sink: AnalyticsSink | undefined;
  readonly #location: () => { readonly pathname: string };

  constructor(options: AnalyticsReporterOptions = {}) {
    this.#location = options.location ?? (() => window.location);
  }

  get active(): boolean {
    return this.#sink !== undefined;
  }

  arm(sink: AnalyticsSink): void {
    this.#sink = sink;
  }

  disarm(): void {
    this.#sink = undefined;
  }

  /**
   * Attach the Account to everything reported after it. The identifier is the Account's own uuid
   * and never its address or display name: the funnel has to survive a reader moving between a
   * phone and a laptop, and an opaque identifier is the whole of what that needs.
   */
  identify(userId: string | null): void {
    this.#sink?.(["set", { user_id: userId }]);
  }

  /**
   * One measured navigation. The location and path are route templates the caller has already
   * projected: this reports what it is given rather than deriving anything from the address.
   */
  page({
    location,
    path,
    referrer,
    title,
  }: {
    location: string;
    path: string;
    referrer?: string;
    title: string;
  }): void {
    if (!this.#reporting()) return;
    const params: AnalyticsParams = {
      page_location: location,
      page_path: path,
      page_referrer: referrer,
      page_title: title,
    };
    // Recorded as defaults as well as sent, so that any hit the tag raises on its own — a history
    // change it noticed before this call, an enhanced measurement event — carries the sanitized
    // location rather than reading the raw one back off the document.
    this.#sink?.(["set", params]);
    this.#sink?.(["event", ANALYTICS_EVENT.pageView, params]);
  }

  track(name: string, params: AnalyticsParams = {}): void {
    if (!this.#reporting()) return;
    this.#sink?.(["event", name, params]);
  }

  /** Armed, and not standing on a preview surface. */
  #reporting(): boolean {
    return this.#sink !== undefined && !this.#location().pathname.startsWith(PREVIEW_PATH_PREFIX);
  }
}

/** The reporter every call site shares. It stays inert until `installAnalytics` arms it. */
export const analytics = new AnalyticsReporter();

/**
 * Install Google Analytics for this document, if this document is one that should be measured.
 *
 * Returns a disposer for symmetry with the other installers in `main.tsx`; a page that has already
 * fetched the tag cannot unfetch it, but disarming stops anything further being reported.
 */
export function installAnalytics(target: Window = window, reporter: AnalyticsReporter = analytics): () => void {
  if (!analyticsEnabled(target)) return () => undefined;
  // Before the tag can send anything, including on a document that opened straight onto a preview.
  syncAnalyticsSuppression(target.location.pathname, target);
  const sink = dataLayerSink(target);
  sink(["js", new Date()]);
  sink([
    "config",
    ANALYTICS_MEASUREMENT_ID,
    {
      // This application sends its own page views, from the router, with the URL sanitized. The
      // automatic one would report the raw address of whichever page the visit started on.
      send_page_view: false,
      // Nothing here is used to build advertising audiences, and Google Signals would attach a
      // Google identity to a session that this application deliberately identifies by an opaque id.
      allow_google_signals: false,
      allow_ad_personalization_signals: false,
      // Staging shares this property with production, so it says which it is and Google Analytics
      // excludes it through one filter instead of every report remembering to.
      traffic_type: analyticsTrafficType(target.location.hostname),
    },
  ]);
  appendGtagScript(ANALYTICS_MEASUREMENT_ID, target);
  reporter.arm(sink);
  return () => reporter.disarm();
}
