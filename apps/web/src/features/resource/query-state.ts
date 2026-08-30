import { isTerminalResourceError, type LoadState } from "./use-resource.js";

/** The part of a query result this reads. Taking a plain object keeps it a pure function to test. */
export interface ResourceQueryResult {
  data: unknown;
  error: Error | null;
  isError: boolean;
}

/**
 * The value a query carries once it holds one. `undefined` is reserved for "nothing read yet", so a
 * resource that can legitimately be absent — an Agent with no messaging binding — must resolve to
 * `null` rather than `undefined`. The query client requires that anyway: it rejects a query function
 * that resolves `undefined`.
 */
type Loaded<TQuery extends ResourceQueryResult> = Exclude<TQuery["data"], undefined>;

/**
 * Reads a query as the three states a page renders.
 *
 * The subtlety is that a query holds two facts at once: `data` is sticky, so it survives a later
 * refetch that failed, while `isError` describes only the most recent attempt. So the question
 * "is there something to show" is `data !== undefined`, not "did the last fetch succeed".
 *
 * That is what lets a background failure degrade rather than blank the page: `onBackgroundError`
 * marks the value the viewer is already looking at as no longer confirmed. A terminal failure is
 * exempt — a `401`, `403`, `404` or `410` says the resource is gone or forbidden, which is not a
 * transient loss of contact, so it surfaces as an error however much stale data is in hand.
 */
export function toResourceState<TQuery extends ResourceQueryResult>(
  query: TQuery,
  onBackgroundError?: (value: Loaded<TQuery>, error: Error) => Loaded<TQuery>,
): LoadState<Loaded<TQuery>> {
  const loaded = query.data as Loaded<TQuery> | undefined;
  if (query.isError) {
    const error = query.error ?? new Error("The request failed");
    if (loaded !== undefined && onBackgroundError && !isTerminalResourceError(error)) {
      return { kind: "ready", value: onBackgroundError(loaded, error) };
    }
    return { kind: "error", error };
  }
  if (loaded !== undefined) return { kind: "ready", value: loaded };
  return { kind: "loading" };
}
