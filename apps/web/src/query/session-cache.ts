import { hashKey, type QueryClient, type QueryKey } from "@tanstack/react-query";
import { ApiError } from "../api.js";

interface TerminalRecord {
  at: number;
  error: Error;
}

interface SessionCache {
  generation: number;
  terminalErrors: Map<string, TerminalRecord>;
}

const sessions = new WeakMap<QueryClient, SessionCache>();

function sessionOf(client: QueryClient): SessionCache {
  const held = sessions.get(client);
  if (held) return held;
  const created: SessionCache = { generation: 0, terminalErrors: new Map() };
  sessions.set(client, created);
  return created;
}

/**
 * Cancels in-flight reads and drops cached results when the Account session ends, so a late
 * response cannot populate the next Account's cache.
 */
export function attachSessionCache(client: QueryClient): QueryClient {
  sessionOf(client);
  const originalClear = client.clear.bind(client);
  client.clear = () => {
    const session = sessionOf(client);
    session.generation += 1;
    session.terminalErrors.clear();
    void client.cancelQueries();
    originalClear();
  };
  client.getQueryCache().subscribe((event) => recordQueryCacheEvent(client, event));
  return client;
}

function recordQueryCacheEvent(
  client: QueryClient,
  event: {
    type: string;
    action?: { type: string; manual?: boolean };
    query: { queryKey: QueryKey; state: { dataUpdatedAt: number; error: unknown; errorUpdatedAt: number } };
  },
): void {
  if (event.type !== "updated" || !event.action) return;
  const { action, query } = event;
  if (action.type === "success") {
    // setQueryData is not an authorized Server read; it must not retire a terminal refusal.
    if (action.manual === true) return;
    const record = terminalResourceRecord(client, query.queryKey);
    if (!record || query.state.dataUpdatedAt >= record.at) {
      clearTerminalResourceError(client, query.queryKey);
    }
    return;
  }
  if (action.type === "error" && query.state.error instanceof Error) {
    rememberTerminalResourceError(client, query.queryKey, query.state.error, query.state.errorUpdatedAt);
  }
}

export function sessionGeneration(client: QueryClient): number {
  return sessionOf(client).generation;
}

function isTerminalError(error: Error): boolean {
  return error instanceof ApiError && [401, 403, 404, 410].includes(error.status);
}

export function rememberTerminalResourceError(
  client: QueryClient,
  queryKey: QueryKey,
  error: Error,
  at = Date.now(),
): void {
  if (!isTerminalError(error)) return;
  sessionOf(client).terminalErrors.set(hashKey(queryKey), { at, error });
}

export function clearTerminalResourceError(client: QueryClient, queryKey: QueryKey): void {
  sessionOf(client).terminalErrors.delete(hashKey(queryKey));
}

export function terminalResourceError(client: QueryClient, queryKey: QueryKey): Error | undefined {
  return sessionOf(client).terminalErrors.get(hashKey(queryKey))?.error;
}

export function terminalResourceObservedAt(client: QueryClient, queryKey: QueryKey): number {
  return sessionOf(client).terminalErrors.get(hashKey(queryKey))?.at ?? 0;
}

function terminalResourceRecord(client: QueryClient, queryKey: QueryKey): TerminalRecord | undefined {
  return sessionOf(client).terminalErrors.get(hashKey(queryKey));
}

/**
 * An imperative read that shares the QueryClient in-flight slot for `queryKey`, then refuses to
 * keep the result if the Account session ended while it was in the air. A cancelled generation must
 * not delete a later Account's query of the same key.
 */
export async function fetchSharedResource<T>(
  client: QueryClient,
  options: {
    queryKey: QueryKey;
    queryFn: () => Promise<T>;
    staleTime?: number;
    gcTime?: number;
  },
): Promise<T> {
  const session = sessionOf(client);
  const generation = session.generation;
  const ended = () => session.generation !== generation;
  const result = await client.fetchQuery({
    queryKey: options.queryKey,
    staleTime: options.staleTime ?? 0,
    ...(options.gcTime !== undefined ? { gcTime: options.gcTime } : {}),
    queryFn: async ({ signal }) => {
      if (ended() || signal.aborted) throw sessionEndedError();
      const data = await options.queryFn();
      if (ended() || signal.aborted) throw sessionEndedError();
      return data;
    },
  });
  if (ended()) throw sessionEndedError();
  return result;
}

function sessionEndedError(): Error {
  return new Error("The Account session ended");
}
