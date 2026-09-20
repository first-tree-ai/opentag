import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { browserApi } from "../../api.js";
import {
  useAgentMcpServers,
  useAttachMcpServer,
  useAvailableMcpServers,
  useCreateMcpServer,
  useDetachMcpServer,
  useMcpServerDetail,
  useMcpServers,
  useProbeMcpServer,
  useRemoveMcpServer,
  useRevokeMcpAuthorization,
  useSetMcpAuthorization,
  useStartMcpOAuth,
  useUpdateMcpBinding,
  useUpdateMcpServer,
} from "./mcp-queries.js";

/**
 * The Agent-scoped mutation hooks, asserted on the body they actually send.
 *
 * Each of these takes one object holding both the routing id and the payload, and hands the two to
 * the API helper separately. Passing that object straight through as the body sent `mcpServerId` as
 * well, and every MCP request schema on the Server is `.strict()` — so OAuth start, authorization,
 * binding updates, and shared-definition edits were all answered with
 * `VALIDATION_ERROR: Unrecognized key "mcpServerId"`, which the page showed as "The request payload
 * is invalid".
 *
 * This is asserted here rather than in `api.csrf.test.ts` because that suite drives `BrowserApi`
 * directly and therefore cannot see what the hooks pass it; and not only in the page test, because a
 * page test asserts what the user sees and this is a wire-shape contract.
 */

const AGENT_ID = "1a63a21e-f6c7-4474-91ea-4dabf0566a24";
const SERVER_ID = "9d4e1378-8ff2-4e41-a6dd-e8bf59ed775b";

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

/**
 * The body handed to the API helper, so the assertion is on the value rather than a mock of it.
 *
 * The last positional argument is the payload for every method under test here, which is also the
 * shape that made the bug easy to write: the id and the body travelled together.
 */
function captureBody(method: keyof typeof browserApi) {
  const calls: Record<string, unknown>[] = [];
  const spy = vi.spyOn(browserApi, method as never) as unknown as {
    mockImplementation: (impl: (...args: unknown[]) => unknown) => unknown;
  };
  spy.mockImplementation((...args: unknown[]) => {
    const body = args.at(-1);
    if (typeof body === "object" && body !== null) calls.push(body as Record<string, unknown>);
    return Promise.resolve({});
  });
  return { calls, spy };
}

afterEach(() => vi.restoreAllMocks());

describe("MCP mutation bodies", () => {
  it("starts OAuth without putting the Server id in the body", async () => {
    const { calls, spy } = captureBody("startMcpOAuth");
    const { result } = renderHook(() => useStartMcpOAuth(AGENT_ID), { wrapper });

    await result.current.mutateAsync({ mcpServerId: SERVER_ID });
    await waitFor(() => expect(spy).toHaveBeenCalled());

    expect(calls[0]).toEqual({});
    expect(calls[0]).not.toHaveProperty("mcpServerId");
  });

  it("writes an authorization without putting the Server id in the body", async () => {
    const { calls } = captureBody("setMcpAuthorization");
    const { result } = renderHook(() => useSetMcpAuthorization(AGENT_ID), { wrapper });

    await result.current.mutateAsync({ mcpServerId: SERVER_ID, kind: "bearer", bearerKey: "k" });

    expect(calls[0]).toEqual({ kind: "bearer", bearerKey: "k" });
    expect(calls[0]).not.toHaveProperty("mcpServerId");
  });

  it("updates a binding without putting the Server id in the body", async () => {
    const { calls } = captureBody("updateAgentMcpServer");
    const { result } = renderHook(() => useUpdateMcpBinding(AGENT_ID), { wrapper });

    await result.current.mutateAsync({ mcpServerId: SERVER_ID, enabled: false });

    expect(calls[0]).toEqual({ enabled: false });
    expect(calls[0]).not.toHaveProperty("mcpServerId");
  });

  it("updates a shared definition without putting the Server id in the body", async () => {
    const { calls } = captureBody("updateMcpServer");
    const { result } = renderHook(() => useUpdateMcpServer(AGENT_ID), { wrapper });

    await result.current.mutateAsync({ mcpServerId: SERVER_ID, expectedRevision: 1, description: "d" });

    expect(calls[0]).toEqual({ expectedRevision: 1, description: "d" });
    expect(calls[0]).not.toHaveProperty("mcpServerId");
  });
});

/**
 * The reads and the id-only writes. These take no object to split, so what matters is the argument
 * each one actually uses: a read addressed to the wrong id shows another Agent's Server, and a write
 * addressed to the wrong id changes it.
 */
describe("MCP queries and id-only mutations", () => {
  /** Counts what the mounted read asked the API for, without caring which query owns it. */
  function countCalls(method: keyof typeof browserApi, value: unknown) {
    const spy = vi.spyOn(browserApi, method as never).mockResolvedValue(value as never);
    return spy;
  }

  it("reads the Account's whole Server pool", async () => {
    const read = countCalls("mcpServers", { servers: [] });
    const { result } = renderHook(() => useMcpServers(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("reads one Server definition by the id it was given", async () => {
    const read = countCalls("mcpServer", { server: { id: SERVER_ID } });
    const { result } = renderHook(() => useMcpServerDetail(SERVER_ID), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(read).toHaveBeenCalledWith(SERVER_ID);
  });

  it("does not read a definition it was not given an id for", async () => {
    // `enabled: false` is what keeps the query from asking for `/mcp-servers/undefined`.
    const read = countCalls("mcpServer", {});
    const { result } = renderHook(() => useMcpServerDetail(undefined), { wrapper });

    expect(result.current.fetchStatus).toBe("idle");
    expect(read).not.toHaveBeenCalled();
  });

  it("reads this Agent's mounts with the Agent's own id", async () => {
    const read = countCalls("agentMcpServers", { servers: [] });
    const { result } = renderHook(() => useAgentMcpServers(AGENT_ID), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(read).toHaveBeenCalledWith(AGENT_ID);
  });

  it("holds the available-Server read until the chooser that needs it is open", async () => {
    const read = countCalls("availableMcpServers", { servers: [] });
    const { result } = renderHook(() => useAvailableMcpServers(AGENT_ID, false), { wrapper });

    expect(result.current.fetchStatus).toBe("idle");
    expect(read).not.toHaveBeenCalled();
  });

  it("reads the available Servers once the chooser asks for them", async () => {
    const read = countCalls("availableMcpServers", { servers: [] });
    const { result } = renderHook(() => useAvailableMcpServers(AGENT_ID, true), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(read).toHaveBeenCalledWith(AGENT_ID);
  });

  it("creates a definition from the form input, unchanged", async () => {
    const create = countCalls("createMcpServer", { id: SERVER_ID });
    const { result } = renderHook(() => useCreateMcpServer(AGENT_ID), { wrapper });

    await result.current.mutateAsync({ name: "linear", url: "https://mcp.linear.app/sse", defaultAuthKind: "oauth" });

    expect(create).toHaveBeenCalledWith({
      name: "linear",
      url: "https://mcp.linear.app/sse",
      defaultAuthKind: "oauth",
    });
  });

  it("mounts a Server enabled, so adding it is enough to use it", async () => {
    const attach = countCalls("attachMcpServer", {});
    const { result } = renderHook(() => useAttachMcpServer(AGENT_ID), { wrapper });

    await result.current.mutateAsync(SERVER_ID);

    // The mount is on: `enabled: false` there would add a Server the Agent cannot use.
    expect(attach).toHaveBeenCalledWith(AGENT_ID, { mcpServerId: SERVER_ID, enabled: true });
  });

  it("detaches this Agent's mount by both ids, with no body", async () => {
    const detach = countCalls("detachMcpServer", undefined);
    const { result } = renderHook(() => useDetachMcpServer(AGENT_ID), { wrapper });

    await result.current.mutateAsync(SERVER_ID);

    expect(detach).toHaveBeenCalledWith(AGENT_ID, SERVER_ID);
  });

  it("revokes this Agent's credential by both ids", async () => {
    const revoke = countCalls("revokeMcpAuthorization", {});
    const { result } = renderHook(() => useRevokeMcpAuthorization(AGENT_ID), { wrapper });

    await result.current.mutateAsync(SERVER_ID);

    expect(revoke).toHaveBeenCalledWith(AGENT_ID, SERVER_ID);
  });

  it("probes this Agent's mount by both ids", async () => {
    const probe = countCalls("probeMcpServer", { probeState: "succeeded" });
    const { result } = renderHook(() => useProbeMcpServer(AGENT_ID), { wrapper });

    await result.current.mutateAsync(SERVER_ID);

    expect(probe).toHaveBeenCalledWith(AGENT_ID, SERVER_ID);
  });
});

/**
 * Every write retires the four MCP reads, because a mount changes both this Agent's view and the
 * Account-wide definition counts. A test of one write is a test of the shared invalidation.
 */
describe("MCP write invalidation", () => {
  function wrapperWith(queryClient: QueryClient) {
    return function Wrapper({ children }: { children: ReactNode }) {
      return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
    };
  }

  it("retires this Agent's reads, the Account pool, and every definition detail after a write", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    vi.spyOn(browserApi, "attachMcpServer").mockResolvedValue({} as never);

    const { result } = renderHook(() => useAttachMcpServer(AGENT_ID), {
      wrapper: wrapperWith(queryClient),
    });
    await result.current.mutateAsync(SERVER_ID);

    const keys = invalidate.mock.calls.map((call) => call[0]?.queryKey);
    expect(keys).toContainEqual(["mcp", "agents", AGENT_ID]);
    expect(keys).toContainEqual(["mcp", "agents", AGENT_ID, "available"]);
    expect(keys).toContainEqual(["mcp", "servers"]);
    expect(keys).toContainEqual(["mcp", "server"]);
  });
});
