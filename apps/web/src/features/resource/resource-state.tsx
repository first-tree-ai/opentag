import type { QueryKey } from "@tanstack/react-query";
import { useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { ApiError } from "../../api.js";
import * as m from "../../paraglide/messages.js";
import { terminalResourceError } from "../../query/session-cache.js";
import { Banner, Button, Loader } from "../../ui/design-system.js";

export type LoadState<T> = { kind: "loading" } | { kind: "error"; error: Error } | { kind: "ready"; value: T };

export function isTerminalResourceError(error: Error): boolean {
  return error instanceof ApiError && [401, 403, 404, 410].includes(error.status);
}

/** A paused or offline observer is not a fresh confirmation of the value it still holds. */
export function isConfirmedQuerySuccess(query: { isSuccess: boolean; fetchStatus: string }): boolean {
  return query.isSuccess && query.fetchStatus !== "paused";
}

/** The part of a query this remembers. Taking a plain object keeps the reads it accepts explicit. */
export interface SettlingQuery {
  error: Error | null;
  isError: boolean;
  isSuccess: boolean;
}

/**
 * The last answer the Server actually gave, held on the QueryClient so remounts, in-flight refreshes,
 * and later transient failures cannot resurrect a 401/403/404/410. Only a later successful read
 * retires it. Transient failures are not stored here: they describe the attempt, not the resource.
 */
export function usePersistedSettledError(queryKey: QueryKey, query: SettlingQuery): Error | null {
  const queryClient = useQueryClient();
  const held = terminalResourceError(queryClient, queryKey);
  if (held) return held;
  if (query.isSuccess) return null;
  return query.isError ? (query.error ?? new Error(m.common_request_failed())) : null;
}

export function ResourceRefreshNotice({ error, onRetry }: { error: Error; onRetry: () => void }) {
  return (
    <Banner
      action={<Banner.Action onClick={onRetry}>{m.common_try_again()}</Banner.Action>}
      data-ui="resource-refresh-failed"
      description={error.message}
      role="status"
      title={m.common_update_failed_last_available()}
      variant="alert"
    />
  );
}

export function liveRefreshErrors(
  query: SettlingQuery & { data?: unknown; isFetchNextPageError?: boolean },
  persistedError: Error | null,
): { terminalError: Error | null; refreshError: Error | null; loadMoreError: Error | null } {
  const terminalError = persistedError && isTerminalResourceError(persistedError) ? persistedError : null;
  const current = query.error ?? persistedError;
  const loadMoreError = query.isFetchNextPageError && !terminalError ? current : null;
  const refreshError =
    !terminalError && query.data !== undefined && query.isError && !query.isFetchNextPageError ? current : null;
  return { terminalError, refreshError, loadMoreError };
}

export function ResourceRefreshStatus({ error, onRetry }: { error: Error; onRetry: () => void }) {
  return (
    <p
      className="flex flex-wrap items-center gap-3 text-sm text-kumo-subtle"
      data-ui="resource-refresh-failed"
      role="status"
    >
      <span>{m.common_update_failed_last_available()}</span>
      <Button size="compact" type="button" variant="secondary" onClick={onRetry}>
        {m.common_try_again()}
      </Button>
      <span className="text-kumo-danger">{error.message}</span>
    </p>
  );
}

export function AsyncState<T>({
  state,
  children,
  loading,
}: {
  state: LoadState<T>;
  children: (value: T) => ReactNode;
  loading?: ReactNode;
}) {
  if (state.kind === "loading")
    return (
      loading ?? (
        <div
          aria-label={m.common_loading_current_server_state()}
          className="flex items-center gap-2 text-sm text-kumo-subtle"
          role="status"
        >
          <span aria-hidden="true">
            <Loader size="sm" />
          </span>
          <span>{m.common_loading_current_server_state_detail()}</span>
        </div>
      )
    );
  if (state.kind === "error")
    return (
      <div className="rounded-md bg-kumo-danger-tint p-3 text-sm text-kumo-danger" role="alert">
        {state.error.message}
      </div>
    );
  return children(state.value);
}

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
    const error = query.error ?? new Error(m.common_request_failed());
    if (loaded !== undefined && onBackgroundError && !isTerminalResourceError(error)) {
      return { kind: "ready", value: onBackgroundError(loaded, error) };
    }
    return { kind: "error", error };
  }
  if (loaded !== undefined) return { kind: "ready", value: loaded };
  return { kind: "loading" };
}
