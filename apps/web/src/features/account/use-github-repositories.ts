import type { GitHubConnectionStatus } from "@opentag/shared/browser";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, browserApi } from "../../api.js";
import { REPOSITORIES_PER_BATCH, type RepositoryCatalog, readRepositoryBatch } from "./github-repository-discovery.js";

type Request = { kind: "initial" | "refresh" | "more"; target: number };
type CatalogState = { catalog?: RepositoryCatalog; pending?: Request; failure?: Request };

async function reconcileConnectionFailure(
  cause: unknown,
  signal: AbortSignal,
  reconcile?: (signal: AbortSignal) => Promise<void>,
) {
  if (signal.aborted || !(cause instanceof ApiError)) return;
  if (
    cause.code !== "GITHUB_CONNECTION_STATE_INVALID" &&
    cause.code !== "GITHUB_CONNECTION_NOT_FOUND" &&
    cause.code !== "GITHUB_AUTHORIZATION_VERSION_CONFLICT"
  )
    return;
  await reconcile?.(signal);
}

/** Lifetime is one open dialog. No cached repository data crosses an authorization or account. */
export function useGitHubRepositories(
  open: boolean,
  { id, authorizationVersion }: Pick<GitHubConnectionStatus, "id" | "authorizationVersion">,
  onConnectionInvalid?: (signal: AbortSignal) => Promise<void>,
) {
  const [state, setState] = useState<CatalogState>({});
  const catalog = useRef<RepositoryCatalog | undefined>(undefined);
  const controller = useRef<AbortController | undefined>(undefined);
  const configuration = useRef({ opened: false, left: false });
  const run = useCallback(
    async (request: Request) => {
      if (controller.current) return;
      const active = new AbortController();
      controller.current = active;
      setState((previous) => ({ catalog: previous.catalog, pending: request }));
      try {
        const next = await readRepositoryBatch({
          previous: request.kind === "refresh" ? undefined : catalog.current,
          target: request.target,
          signal: active.signal,
          readPage: (cursor, signal) => browserApi.githubRepositories(cursor, signal, { id, authorizationVersion }),
          onProgress: (next) => {
            if (request.kind === "refresh" || active.signal.aborted) return;
            catalog.current = next;
            setState({ catalog: next, pending: request });
          },
        });
        if (active.signal.aborted) return;
        catalog.current = next;
        setState({ catalog: next });
      } catch (cause) {
        await reconcileConnectionFailure(cause, active.signal, onConnectionInvalid);
        if (!active.signal.aborted) setState({ catalog: catalog.current, failure: request });
      } finally {
        if (controller.current === active) controller.current = undefined;
      }
    },
    [id, authorizationVersion, onConnectionInvalid],
  );
  const refresh = useCallback(() => void run({ kind: "refresh", target: REPOSITORIES_PER_BATCH }), [run]);
  useEffect(() => {
    catalog.current = undefined;
    configuration.current = { opened: false, left: false };
    setState({});
    if (!open) return;
    void run({ kind: "initial", target: REPOSITORIES_PER_BATCH });
    return () => {
      controller.current?.abort();
      controller.current = undefined;
    };
  }, [open, run]);
  useEffect(() => {
    if (!open) return;
    function leave() {
      if (configuration.current.opened) configuration.current.left = true;
    }
    function returned() {
      if (
        !configuration.current.opened ||
        !configuration.current.left ||
        document.visibilityState !== "visible" ||
        !document.hasFocus() ||
        state.pending
      )
        return;
      configuration.current = { opened: false, left: false };
      refresh();
    }
    function visibility() {
      if (document.visibilityState === "hidden") leave();
      else returned();
    }
    window.addEventListener("blur", leave);
    window.addEventListener("focus", returned);
    document.addEventListener("visibilitychange", visibility);
    returned();
    return () => {
      window.removeEventListener("blur", leave);
      window.removeEventListener("focus", returned);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [open, refresh, state.pending]);
  return {
    ...state,
    refresh,
    retry: () => state.failure && void run(state.failure),
    loadMore: () => void run({ kind: "more", target: (catalog.current?.visibleCount ?? 0) + REPOSITORIES_PER_BATCH }),
    configure: () => {
      configuration.current = { opened: true, left: false };
    },
  };
}
