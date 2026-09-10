import { hashKey, type QueryClient, type QueryKey } from "@tanstack/react-query";
import { ApiError } from "../api.js";

/**
 * Where one resource answer stands against another. `seq` is observation order: the cache assigns
 * it when a read actually settles, so two answers landing in the same millisecond — or under a
 * clock that moved backwards — still order by which was observed later. A `setQueryData` write
 * preserves the key's previous sequence (or 0 before any read); it never advances observation
 * order and therefore cannot promote an older answer over a later refusal.
 */
export interface ResourceObservation {
  readonly seq: number;
  readonly at: number;
}

export interface TerminalResourceObservation {
  readonly seq: number;
  readonly error: Error;
}

interface SessionCache {
  generation: number;
  /** The observation clock: bumped once per settled read the cache records, never by the wall clock. */
  clock: number;
  successes: Map<string, ResourceObservation>;
  terminalErrors: Map<string, TerminalResourceObservation>;
}

const sessions = new WeakMap<QueryClient, SessionCache>();

function sessionOf(client: QueryClient): SessionCache {
  const held = sessions.get(client);
  if (held) return held;
  const created: SessionCache = { generation: 0, clock: 0, successes: new Map(), terminalErrors: new Map() };
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
    session.clock = 0;
    session.successes.clear();
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
    query: { queryKey: QueryKey; state: { dataUpdatedAt: number; error: unknown } };
  },
): void {
  if (event.type !== "updated" || !event.action) return;
  const { action, query } = event;
  if (action.type === "success") {
    recordResourceSuccess(client, query.queryKey, query.state.dataUpdatedAt, action.manual === true);
    return;
  }
  if (action.type === "error" && query.state.error instanceof Error) {
    rememberTerminalResourceError(client, query.queryKey, query.state.error);
  }
}

function recordResourceSuccess(client: QueryClient, queryKey: QueryKey, at: number, manual: boolean): void {
  const session = sessionOf(client);
  const key = hashKey(queryKey);
  if (manual) {
    // setQueryData is not an authorized Server read: it follows the time its payload claims but
    // keeps the observation order the key already had, so it neither retires a terminal refusal
    // nor promotes the row it touches over one the Server answered later.
    const previous = session.successes.get(key);
    session.successes.set(key, { seq: previous?.seq ?? 0, at });
    return;
  }
  const observation: ResourceObservation = { seq: session.clock + 1, at };
  session.clock = observation.seq;
  session.successes.set(key, observation);
  // An answer the Server gave after the refusal was observed retires it; anything older never does.
  const record = session.terminalErrors.get(key);
  if (record && record.seq < observation.seq) clearTerminalResourceError(client, queryKey);
}

export function sessionGeneration(client: QueryClient): number {
  return sessionOf(client).generation;
}

function isTerminalError(error: Error): boolean {
  return error instanceof ApiError && [401, 403, 404, 410].includes(error.status);
}

export function rememberTerminalResourceError(client: QueryClient, queryKey: QueryKey, error: Error): void {
  if (!isTerminalError(error)) return;
  const session = sessionOf(client);
  session.clock += 1;
  session.terminalErrors.set(hashKey(queryKey), { seq: session.clock, error });
}

export function clearTerminalResourceError(client: QueryClient, queryKey: QueryKey): void {
  sessionOf(client).terminalErrors.delete(hashKey(queryKey));
}

export function terminalResourceError(client: QueryClient, queryKey: QueryKey): Error | undefined {
  return sessionOf(client).terminalErrors.get(hashKey(queryKey))?.error;
}

/** The last successful read the cache observed for this key, or the manual write standing in for one. */
export function resourceSuccessObservation(client: QueryClient, queryKey: QueryKey): ResourceObservation | undefined {
  return sessionOf(client).successes.get(hashKey(queryKey));
}

export function terminalResourceObservation(
  client: QueryClient,
  queryKey: QueryKey,
): TerminalResourceObservation | undefined {
  return sessionOf(client).terminalErrors.get(hashKey(queryKey));
}

/**
 * True when `candidate` settled the question after `baseline`. Two reads the cache itself observed
 * order by observation, never by the wall clock; when either side is a write the Server never
 * answered (seq 0), the times their payloads claim decide, as they did before observation order
 * existed.
 */
export function observedAfter(
  candidate: ResourceObservation | undefined,
  baseline: ResourceObservation | undefined,
): boolean {
  if (!candidate) return false;
  if (!baseline) return true;
  if (candidate.seq > 0 && baseline.seq > 0) return candidate.seq > baseline.seq;
  return candidate.at > baseline.at;
}

/**
 * A terminal refusal stands until a read the Server actually answered settles strictly after it.
 * Manual writes and answers observed earlier — including one that shares the refusal's
 * millisecond — never outrank it.
 */
export function refusalOutranks(
  refusal: TerminalResourceObservation | undefined,
  success: ResourceObservation | undefined,
): boolean {
  return refusal !== undefined && (success?.seq ?? 0) <= refusal.seq;
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
