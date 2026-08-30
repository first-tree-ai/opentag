import { type ReactNode, useEffect, useRef, useState } from "react";
import { ApiError } from "../../api.js";
import { Loader } from "../../ui/design-system.js";

export type LoadState<T> = { kind: "loading" } | { kind: "error"; error: Error } | { kind: "ready"; value: T };

export function useResource<T>(
  loader: () => Promise<T>,
  key: string,
  options: {
    initialValue?: T;
    keepPreviousData?: boolean;
    onBackgroundError?: (value: T, error: Error) => T;
    revalidateMs?: number;
    refreshOnFocus?: boolean;
  } = {},
): LoadState<T> {
  const [state, setState] = useState<LoadState<T>>(() =>
    options.initialValue === undefined ? { kind: "loading" } : { kind: "ready", value: options.initialValue },
  );
  const loaderRef = useRef(loader);
  const keyRef = useRef(key);
  const optionsRef = useRef(options);
  loaderRef.current = loader;
  keyRef.current = key;
  optionsRef.current = options;
  useEffect(() => {
    let active = true;
    let request = 0;
    let inFlight = false;
    const activeKey = key;
    const load = (showLoading: boolean) => {
      if (inFlight) return;
      inFlight = true;
      const currentRequest = ++request;
      if (showLoading) setState({ kind: "loading" });
      void loaderRef
        .current()
        .then(
          (value) =>
            active && keyRef.current === activeKey && request === currentRequest && setState({ kind: "ready", value }),
          (error: unknown) => {
            if (!active || keyRef.current !== activeKey || request !== currentRequest) return;
            const resolvedError = error instanceof Error ? error : new Error(String(error));
            if (showLoading || isTerminalResourceError(resolvedError)) {
              setState({ kind: "error", error: resolvedError });
              return;
            }
            setState((current) => {
              if (current.kind !== "ready" || !optionsRef.current.onBackgroundError) {
                return { kind: "error", error: resolvedError };
              }
              return {
                kind: "ready",
                value: optionsRef.current.onBackgroundError(current.value, resolvedError),
              };
            });
          },
        )
        .finally(() => {
          if (active && keyRef.current === activeKey && request === currentRequest) inFlight = false;
        });
    };
    const revalidate = () => load(false);
    const revalidateVisible = () => {
      if (document.visibilityState === "visible") revalidate();
    };
    load(!options.keepPreviousData && options.initialValue === undefined);
    let interval: number | undefined;
    const stopPolling = () => {
      if (interval === undefined) return;
      window.clearInterval(interval);
      interval = undefined;
    };
    const startPolling = () => {
      if (!options.revalidateMs || document.visibilityState !== "visible" || interval !== undefined) return;
      interval = window.setInterval(revalidateVisible, options.revalidateMs);
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState !== "visible") {
        stopPolling();
        return;
      }
      startPolling();
      if (options.refreshOnFocus) revalidate();
    };
    startPolling();
    if (options.refreshOnFocus) window.addEventListener("focus", revalidateVisible);
    if (options.refreshOnFocus || options.revalidateMs) {
      document.addEventListener("visibilitychange", handleVisibilityChange);
    }
    return () => {
      active = false;
      stopPolling();
      window.removeEventListener("focus", revalidateVisible);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [key, options.initialValue, options.keepPreviousData, options.refreshOnFocus, options.revalidateMs]);
  return state;
}

export function isTerminalResourceError(error: Error): boolean {
  return error instanceof ApiError && [401, 403, 404, 410].includes(error.status);
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
          aria-label="Loading current server state"
          className="flex items-center gap-2 text-sm text-kumo-subtle"
          role="status"
        >
          <span aria-hidden="true">
            <Loader size="sm" />
          </span>
          <span>Loading current Server state…</span>
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
