import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { browserApi } from "../../api.js";
import { useSetMcpAuthorization, useStartMcpOAuth, useUpdateMcpBinding, useUpdateMcpServer } from "./mcp-queries.js";

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
