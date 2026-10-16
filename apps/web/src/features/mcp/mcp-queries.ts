import type {
  ListAgentMCPServersResponse,
  ListAvailableMCPServersResponse,
  MCPAgentServer,
  MCPCatalogEndpointsResponse,
  MCPServer,
  MCPServerDetail,
} from "@opentag/shared/browser";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { browserApi } from "../../api.js";
import { queryKeys } from "../../query/keys.js";
import { LIVE_REFETCH_INTERVAL_MS, liveResourceQueryOptions } from "../../query/live.js";

/**
 * Reads and writes for the MCP Agent page.
 *
 * The per-Agent read polls on the ordinary live cadence because an authorization completes out of
 * band: the browser leaves for the authorization server and comes back, and the probe result lands
 * afterwards. Polling the row updates authorization and tool-loading feedback without a reload, so
 * `probeState` is persisted on the row rather than inferred from a read timestamp.
 */

export function useMcpServers() {
  return useQuery({
    ...liveResourceQueryOptions,
    queryKey: queryKeys.mcp.servers(),
    queryFn: (): Promise<{ servers: MCPServer[] }> => browserApi.mcpServers(),
  });
}

/**
 * The catalog endpoints this deployment replaces. They change only when the deployment's
 * configuration changes, which needs a restart, so the read is not polled.
 */
const CATALOG_ENDPOINTS_STALE_TIME_MS = 5 * 60_000;
export function useMcpCatalogEndpoints() {
  return useQuery({
    queryKey: queryKeys.mcp.catalogEndpoints(),
    queryFn: (): Promise<MCPCatalogEndpointsResponse> => browserApi.mcpCatalogEndpoints(),
    staleTime: CATALOG_ENDPOINTS_STALE_TIME_MS,
  });
}

export function useMcpServerDetail(mcpServerId: string | undefined) {
  return useQuery({
    ...liveResourceQueryOptions,
    queryKey: queryKeys.mcp.server(mcpServerId ?? ""),
    queryFn: (): Promise<MCPServerDetail> => browserApi.mcpServer(mcpServerId as string),
    enabled: mcpServerId !== undefined,
  });
}

/** Read only this Agent's overridden definitions and the explicitly restored installation. */
export function useMcpInstallationDefinitions(mounted: readonly MCPAgentServer[], restoredId?: string) {
  const ids = new Set(mounted.filter((entry) => entry.overridden.url).map((entry) => entry.mcpServerId));
  if (restoredId) ids.add(restoredId);
  const queries = useQueries({
    queries: [...ids].map((id) => ({
      ...liveResourceQueryOptions,
      queryKey: queryKeys.mcp.server(id),
      queryFn: () => browserApi.mcpServer(id),
    })),
  });
  // Cached metadata remains usable after a failed background refetch.
  const failure = queries.find((query) => query.isError && !query.data);
  return {
    servers: queries.flatMap((query) => (query.data ? [query.data.server] : [])),
    isPending: queries.some((query) => query.isPending),
    isError: Boolean(failure),
    error: failure?.error,
    refetch: () => Promise.all(queries.map((query) => query.refetch())),
  };
}

const PROBE_REFETCH_INTERVAL_MS = 1_000;
const PROBE_FAST_POLL_WINDOW_MS = 30_000;
const pendingProbeStarts = new WeakMap<object, Map<string, number>>();

/** Fast polling is bounded even when failed requests keep the cached probe state pending. */
export function mcpProbeRefetchInterval(query: { state: { data: ListAgentMCPServersResponse | undefined } }): number {
  const pending = query.state.data?.servers.filter(
    (entry) =>
      entry.enabled && entry.authorization?.status === "active" && entry.authorization.probeState === "pending",
  );
  if (!pending?.length) {
    pendingProbeStarts.delete(query);
    return LIVE_REFETCH_INTERVAL_MS;
  }
  const now = Date.now();
  const previous = pendingProbeStarts.get(query);
  const starts = new Map(pending.map((entry) => [entry.mcpServerId, previous?.get(entry.mcpServerId) ?? now]));
  pendingProbeStarts.set(query, starts);
  return [...starts.values()].some((startedAt) => now - startedAt < PROBE_FAST_POLL_WINDOW_MS)
    ? PROBE_REFETCH_INTERVAL_MS
    : LIVE_REFETCH_INTERVAL_MS;
}

export function useAgentMcpServers(agentId: string) {
  return useQuery({
    ...liveResourceQueryOptions,
    queryKey: queryKeys.mcp.agentServers(agentId),
    queryFn: (): Promise<ListAgentMCPServersResponse> => browserApi.agentMcpServers(agentId),
    refetchInterval: mcpProbeRefetchInterval,
  });
}

export function useAvailableMcpServers(agentId: string, enabled: boolean) {
  return useQuery({
    ...liveResourceQueryOptions,
    queryKey: queryKeys.mcp.availableServers(agentId),
    queryFn: (): Promise<ListAvailableMCPServersResponse> => browserApi.availableMcpServers(agentId),
    enabled,
  });
}

/**
 * Every write invalidates the Agent's own MCP reads and the Account pool: adding, editing, or
 * removing a mount changes both the Agent's view and the definition's aggregate counts. A shared
 * definition edit also invalidates every other Agent that uses it, which the pool invalidation and
 * the live cadence between them cover.
 */
export function useMcpInvalidation(agentId?: string) {
  const queryClient = useQueryClient();
  return async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: agentId ? queryKeys.mcp.agentServers(agentId) : ["mcp", "agents"] }),
      queryClient.invalidateQueries({ queryKey: queryKeys.mcp.servers() }),
      queryClient.invalidateQueries({ queryKey: queryKeys.mcp.serverRoot() }),
    ]);
  };
}

export function useCreateMcpServer(agentId: string) {
  const invalidate = useMcpInvalidation(agentId);
  return useMutation({
    mutationFn: (input: Parameters<typeof browserApi.createMcpServer>[0]) => browserApi.createMcpServer(input),
    onSuccess: invalidate,
  });
}

export function useUpdateMcpServer(_agentId?: string) {
  const invalidate = useMcpInvalidation();
  return useMutation({
    mutationFn: (input: { mcpServerId: string } & Parameters<typeof browserApi.updateMcpServer>[1]) =>
      browserApi.updateMcpServer(input.mcpServerId, bodyOf(input)),
    onSuccess: invalidate,
  });
}

export function useRemoveMcpServer(_agentId?: string) {
  const invalidate = useMcpInvalidation();
  return useMutation({
    mutationFn: (mcpServerId: string) => browserApi.removeMcpServer(mcpServerId),
    onSuccess: invalidate,
  });
}

export function useAttachMcpServer(agentId: string) {
  const invalidate = useMcpInvalidation(agentId);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (mcpServerId: string) => browserApi.attachMcpServer(agentId, { mcpServerId, enabled: true }),
    onSuccess: async (entry) => {
      queryClient.setQueryData<ListAgentMCPServersResponse>(queryKeys.mcp.agentServers(agentId), (previous) =>
        mergeAgentServer(previous, entry),
      );
      await invalidate();
    },
  });
}

export function useDetachMcpServer(agentId: string) {
  const invalidate = useMcpInvalidation(agentId);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (mcpServerId: string) => browserApi.detachMcpServer(agentId, mcpServerId),
    onSuccess: async (_result, mcpServerId) => {
      queryClient.setQueryData<ListAgentMCPServersResponse>(
        queryKeys.mcp.agentServers(agentId),
        (previous) => previous && { servers: previous.servers.filter((server) => server.mcpServerId !== mcpServerId) },
      );
      await invalidate();
    },
  });
}

export function useUpdateMcpBinding(agentId: string) {
  const invalidate = useMcpInvalidation(agentId);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { mcpServerId: string } & Parameters<typeof browserApi.updateAgentMcpServer>[2]) =>
      browserApi.updateAgentMcpServer(agentId, input.mcpServerId, bodyOf(input)),
    onSuccess: async (entry) => {
      queryClient.setQueryData<ListAgentMCPServersResponse>(queryKeys.mcp.agentServers(agentId), (previous) =>
        mergeAgentServer(previous, entry),
      );
      await invalidate();
    },
  });
}

export function useSetMcpAuthorization(agentId: string) {
  const invalidate = useMcpInvalidation(agentId);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { mcpServerId: string } & Parameters<typeof browserApi.setMcpAuthorization>[2]) =>
      browserApi.setMcpAuthorization(agentId, input.mcpServerId, bodyOf(input)),
    onSuccess: async (entry) => {
      queryClient.setQueryData<ListAgentMCPServersResponse>(queryKeys.mcp.agentServers(agentId), (previous) =>
        mergeAgentServer(previous, entry),
      );
      await invalidate();
    },
  });
}

/**
 * Split a mutation input into the routing id and the request body.
 *
 * Each dialog holds one object carrying both, because `mcpServerId` is what the API helper needs for
 * the URL while the rest is the body. Passing that object straight through as the body sends
 * `mcpServerId` too, and every one of these request schemas is `.strict()` — so the Server answered
 * `VALIDATION_ERROR: Unrecognized key "mcpServerId"` on OAuth start, authorization, binding updates,
 * and shared-definition edits alike. TypeScript does not catch it: excess-property checking applies
 * to object literals, and an object built elsewhere is assignable to a narrower type.
 */
function bodyOf<T extends { mcpServerId: string }>(input: T): Omit<T, "mcpServerId"> {
  const { mcpServerId: _mcpServerId, ...body } = input;
  return body;
}

export function useStartMcpOAuth(agentId: string) {
  const invalidate = useMcpInvalidation(agentId);
  return useMutation({
    mutationFn: (input: { mcpServerId: string } & Parameters<typeof browserApi.startMcpOAuth>[2]) =>
      browserApi.startMcpOAuth(agentId, input.mcpServerId, bodyOf(input)),
    // The authorization URL is ready; list refreshes must not hold the redirect.
    onSuccess: () => {
      void invalidate();
    },
  });
}

export function useProbeMcpServer(agentId: string) {
  const invalidate = useMcpInvalidation(agentId);
  return useMutation({
    mutationFn: (mcpServerId: string) => browserApi.probeMcpServer(agentId, mcpServerId),
    onSuccess: invalidate,
  });
}

/** The polling cadence, re-exported so a test can assert the page's actual refresh behavior. */
export const MCP_PAGE_REFETCH_INTERVAL_MS = LIVE_REFETCH_INTERVAL_MS;

/** Keep rows in place when a confirmed write is displayed before its follow-up read completes. */
function mergeAgentServer(
  previous: ListAgentMCPServersResponse | undefined,
  entry: MCPAgentServer,
): ListAgentMCPServersResponse {
  const servers = previous?.servers ?? [];
  if (!servers.some((server) => server.mcpServerId === entry.mcpServerId)) return { servers: [...servers, entry] };
  return { servers: servers.map((server) => (server.mcpServerId === entry.mcpServerId ? entry : server)) };
}
