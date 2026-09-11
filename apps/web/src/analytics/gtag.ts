export type AnalyticsParamValue = string | number | boolean | null | undefined;
export type AnalyticsParams = Readonly<Record<string, AnalyticsParamValue>>;

/**
 * One queued gtag.js instruction. Modelling the command rather than exposing a variadic `gtag`
 * keeps every call site type-checked against the four shapes the tag actually understands, and
 * lets a test record instructions as plain data instead of reconstructing an argument list.
 */
export type GtagCommand =
  | readonly ["js", Date]
  | readonly ["set", AnalyticsParams]
  | readonly ["config", string, AnalyticsParams]
  | readonly ["event", string, AnalyticsParams];

export type AnalyticsSink = (command: GtagCommand) => void;

type GtagFunction = (...args: readonly unknown[]) => void;
type GtagScope = Window & { dataLayer?: unknown[]; gtag?: GtagFunction };

export const GTAG_SCRIPT_ORIGIN = "https://www.googletagmanager.com";

/**
 * The published gtag.js bootstrap, written as a module rather than as an inline `<script>`.
 *
 * The Server serves this application under a Content Security Policy with no `'unsafe-inline'` for
 * scripts, so the snippet from the Google Analytics console cannot run as written and is not worth
 * loosening the policy for. What the snippet actually does is create a queue and a function that
 * appends to it; both are ordinary code, and doing it here keeps script execution restricted to
 * this origin and the tag's own host.
 *
 * The queue is the reason nothing needs to wait for the network. Instructions recorded before
 * gtag.js arrives are replayed by it on load, so a milestone reached in the first second of a visit
 * is reported rather than dropped.
 */
export function dataLayerSink(target: Window = window): AnalyticsSink {
  const scope = target as GtagScope;
  const layer = scope.dataLayer ?? [];
  scope.dataLayer = layer;
  if (!scope.gtag) {
    // gtag.js reads each queued entry as an `arguments` object rather than as an array, so the
    // queue is filled exactly the way the published snippet fills it.
    scope.gtag = function gtag() {
      // biome-ignore lint/complexity/useArrowFunction: `arguments` is the value gtag.js expects.
      layer.push(arguments);
    };
  }
  const send = scope.gtag;
  return (command) => {
    send(...command);
  };
}

/**
 * Fetch the tag. It is deliberately the last step of installation: the queue already holds the
 * configuration, so a slow or blocked response costs nothing but the report itself.
 */
export function appendGtagScript(measurementId: string, target: Window = window): HTMLScriptElement {
  const script = target.document.createElement("script");
  script.async = true;
  script.src = `${GTAG_SCRIPT_ORIGIN}/gtag/js?id=${encodeURIComponent(measurementId)}`;
  target.document.head.append(script);
  return script;
}
