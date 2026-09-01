import { type LinkComponentProps, LinkProvider, TooltipProvider } from "@cloudflare/kumo";
import type { AgentAdminConfig } from "@opentag/shared/browser";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  Link as RouterLink,
  RouterProvider,
} from "@tanstack/react-router";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { forwardRef, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  agentId,
  agentListItem,
  computerId,
  creationIntentKey,
  json,
  resetWebAppState,
  storeCreationIntent,
  userId,
} from "../__tests__/support/app-fixtures.js";
import { createQueryClient } from "../query/client.js";
import { type AgentCreationFacts, AgentCreationFlow } from "./agent-creation-flow.js";

const readyFacts: AgentCreationFacts = {
  computers: [{ id: computerId, displayName: "Ada's Mac", connectionStatus: "online" }],
  providers: [{ computerId, provider: "codex", runtimeReady: true, status: "ready" }],
  runtimeEvidenceAvailable: true,
};

/** The Server's answer when a create lands, in the shape the response schema parses. */
const createdAgentConfig = {
  id: agentId,
  name: "resumed-agent",
  displayName: "Resumed Agent",
  runtimeProvider: "codex",
  receiveMode: "mention_only",
  status: "active",
  createdAt: "2026-08-20T00:00:00.000Z",
  updatedAt: "2026-08-20T00:00:00.000Z",
  createdByUserId: userId,
  computerId,
  revision: 1,
  runtimeConfig: { revision: 1, model: null, reasoningEffort: null, instructions: "", maxDurationMs: null },
};

const AppLink = forwardRef<HTMLAnchorElement, LinkComponentProps>(function AppLink({ href, ...props }, ref) {
  if (href?.startsWith("http://") || href?.startsWith("https://")) {
    return <a {...props} href={href} ref={ref} />;
  }
  return <RouterLink {...props} ref={ref} to={(href ?? "#") as never} />;
});

interface RenderedFlow {
  readonly created: AgentAdminConfig[];
  /** The location surface the assertions read; the harness router is narrower than the app's. */
  readonly router: { readonly state: { readonly location: { readonly pathname: string; readonly search: unknown } } };
  readonly unmount: () => void;
}

/**
 * Mounts the flow under its own memory router with a real `/onboarding` route, so a Check that
 * reconciles to an exact Agent is observed where it lands rather than through a navigation spy.
 */
async function renderFlow(
  options: { facts?: AgentCreationFacts; onSubmittingChange?: (submitting: boolean) => void; preview?: boolean } = {},
): Promise<RenderedFlow> {
  const created: AgentAdminConfig[] = [];
  const rootRoute = createRootRoute({ component: Outlet });
  const flowRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: (): ReactNode => (
      <AgentCreationFlow
        accountId={userId}
        facts={options.facts ?? readyFacts}
        preview={options.preview}
        onCreated={(agent) => created.push(agent)}
        onRefresh={() => undefined}
        onSubmittingChange={options.onSubmittingChange}
      />
    ),
  });
  const onboardingRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/onboarding",
    validateSearch: (search: Record<string, unknown>): { agentId?: string } => ({
      agentId: typeof search.agentId === "string" ? search.agentId : undefined,
    }),
    component: (): ReactNode => <p>Onboarding for the exact Agent</p>,
  });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: rootRoute.addChildren([flowRoute, onboardingRoute]),
  });
  let view: ReturnType<typeof render> | undefined;
  await act(async () => {
    view = render(
      <QueryClientProvider client={createQueryClient()}>
        <LinkProvider component={AppLink}>
          <TooltipProvider>
            <RouterProvider router={router as never} />
          </TooltipProvider>
        </LinkProvider>
      </QueryClientProvider>,
    );
  });
  if (!view) throw new Error("The flow did not render");
  const mounted = view;
  return { created, router, unmount: () => mounted.unmount() };
}

/** Answers only the Agents list read; any write attempt fails the test that asked for a read. */
function mockAgentsRead(answer: () => Promise<Response> | Response) {
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    const path = String(input);
    if (path === "/api/v1/agents" && init?.method === undefined) return answer();
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${path}`);
  });
}

function storeResumedAgentIntent(creationIntentId: string) {
  return storeCreationIntent({
    creationIntentId,
    request: { name: "resumed-agent", displayName: "Resumed Agent", runtimeProvider: "codex", computerId },
  });
}

describe("AgentCreationFlow creation intent recovery", () => {
  beforeEach(resetWebAppState);

  it("sends nothing and leaves the stored attempt untouched when a prior intent is present", async () => {
    storeResumedAgentIntent("d0e1f2a3-b4c5-4d6e-8f7a-9b0c1d2e3f40");
    const stored = window.localStorage.getItem(creationIntentKey);
    await renderFlow();

    expect(await screen.findByRole("button", { name: "Check result" })).toBeTruthy();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // Mounting is not a decision: no request left the browser, and the record kept its identity.
    expect(vi.mocked(fetch).mock.calls).toHaveLength(0);
    expect(window.localStorage.getItem(creationIntentKey)).toBe(stored);
    expect((screen.getByLabelText("Display name") as HTMLInputElement).value).toBe("Resumed Agent");
  });

  it("routes an exact Check result to canonical onboarding and retires the saved attempt", async () => {
    storeCreationIntent({
      creationIntentId: "d0e1f2a3-b4c5-4d6e-8f7a-9b0c1d2e3f41",
      request: { name: "reviewer", displayName: "Reviewer", runtimeProvider: "codex", computerId },
    });
    // An unbound Agent is still the exact legal target the saved attempt was creating.
    mockAgentsRead(() => json({ agents: [{ ...agentListItem, computer: null }] }));
    const { router } = await renderFlow();

    fireEvent.click(await screen.findByRole("button", { name: "Check result" }));

    expect(await screen.findByText("Onboarding for the exact Agent")).toBeTruthy();
    expect(router.state.location.pathname).toBe("/onboarding");
    expect(router.state.location.search).toEqual({ agentId });
    expect(window.localStorage.getItem(creationIntentKey)).toBeNull();
    expect(vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
  });

  it("reports a Check with no exact active Agent and keeps the saved attempt", async () => {
    const record = storeCreationIntent({
      creationIntentId: "d0e1f2a3-b4c5-4d6e-8f7a-9b0c1d2e3f42",
      request: { name: "reviewer", displayName: "Reviewer", runtimeProvider: "codex", computerId },
    });
    // A suspended namesake is not a legal target: the exact rule fails closed, not onto it.
    mockAgentsRead(() => json({ agents: [{ ...agentListItem, status: "suspended" }] }));
    const { router } = await renderFlow();

    fireEvent.click(await screen.findByRole("button", { name: "Check result" }));

    const outcome = await screen.findByText(/No active Agent named @reviewer exists yet/);
    expect(outcome.closest('[role="status"]')).not.toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(router.state.location.pathname).toBe("/");
    expect(window.localStorage.getItem(creationIntentKey)).toContain(record.creationIntentId);
    expect(screen.getByRole("button", { name: "Retry creation" })).toBeTruthy();
  });

  it("fails a Check closed when more than one active Agent matches the saved name", async () => {
    const record = storeCreationIntent({
      creationIntentId: "d0e1f2a3-b4c5-4d6e-8f7a-9b0c1d2e3f43",
      request: { name: "reviewer", displayName: "Reviewer", runtimeProvider: "codex", computerId },
    });
    mockAgentsRead(() =>
      json({ agents: [agentListItem, { ...agentListItem, id: "2b63a21e-f6c7-4474-91ea-4dabf0566a25" }] }),
    );
    const { router } = await renderFlow();

    fireEvent.click(await screen.findByRole("button", { name: "Check result" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("More than one active Agent is named @reviewer");
    expect(router.state.location.pathname).toBe("/");
    expect(window.localStorage.getItem(creationIntentKey)).toContain(record.creationIntentId);
  });

  it("keeps the saved attempt and every choice available when the Check read itself fails", async () => {
    const record = storeCreationIntent({
      creationIntentId: "d0e1f2a3-b4c5-4d6e-8f7a-9b0c1d2e3f44",
      request: { name: "reviewer", displayName: "Reviewer", runtimeProvider: "codex", computerId },
    });
    mockAgentsRead(() =>
      json({ error: { code: "SERVICE_UNAVAILABLE", category: "transient", message: "Agent list unavailable" } }, 503),
    );
    await renderFlow();

    fireEvent.click(await screen.findByRole("button", { name: "Check result" }));

    expect((await screen.findByRole("alert")).textContent).toContain("Agent list unavailable");
    expect(window.localStorage.getItem(creationIntentKey)).toContain(record.creationIntentId);
    // The read failing says nothing about the attempt, so no decision is taken away.
    expect(screen.getByRole("button", { name: "Check result" }).hasAttribute("disabled")).toBe(false);
    expect(screen.getByRole("button", { name: "Retry creation" }).hasAttribute("disabled")).toBe(false);
    expect(screen.getByRole("button", { name: "Discard attempt" }).hasAttribute("disabled")).toBe(false);
  });

  it("runs only one Check at a time and parks every other action while it runs", async () => {
    storeCreationIntent({
      creationIntentId: "d0e1f2a3-b4c5-4d6e-8f7a-9b0c1d2e3f45",
      request: { name: "reviewer", displayName: "Reviewer", runtimeProvider: "codex", computerId },
    });
    let release: () => void = () => undefined;
    const pending = new Promise<Response>((resolve) => {
      release = () => resolve(json({ agents: [] }));
    });
    mockAgentsRead(() => pending);
    const busyChanges: boolean[] = [];
    await renderFlow({ onSubmittingChange: (submitting) => busyChanges.push(submitting) });

    const check = await screen.findByRole("button", { name: "Check result" });
    fireEvent.click(check);
    fireEvent.click(check);

    await waitFor(() => expect(vi.mocked(fetch).mock.calls).toHaveLength(1));
    expect(check.hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Retry creation" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Discard attempt" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Create Agent" }).hasAttribute("disabled")).toBe(true);
    expect(busyChanges).toEqual([true]);

    await act(async () => {
      release();
    });

    expect(await screen.findByText(/No active Agent named @reviewer exists yet/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Check result" }).hasAttribute("disabled")).toBe(false);
    expect(screen.getByRole("button", { name: "Retry creation" }).hasAttribute("disabled")).toBe(false);
    expect(busyChanges).toEqual([true, false]);
  });

  it("parks Check and Discard while a Retry is being sent", async () => {
    storeResumedAgentIntent("d0e1f2a3-b4c5-4d6e-8f7a-9b0c1d2e3f46");
    let release: () => void = () => undefined;
    const pending = new Promise<Response>((resolve) => {
      release = () => resolve(json(createdAgentConfig, 201));
    });
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input) === "/api/v1/agents" && init?.method === "POST") return pending;
      throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${String(input)}`);
    });
    const { created } = await renderFlow();

    fireEvent.click(await screen.findByRole("button", { name: "Retry creation" }));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Check result" }).hasAttribute("disabled")).toBe(true),
    );
    expect(screen.getByRole("button", { name: "Discard attempt" }).hasAttribute("disabled")).toBe(true);
    expect(vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === undefined)).toHaveLength(0);

    await act(async () => {
      release();
    });

    await waitFor(() => expect(created).toHaveLength(1));
    expect(window.localStorage.getItem(creationIntentKey)).toBeNull();
  });

  it("retries the saved attempt with its original idempotency identity after a failed send", async () => {
    const record = storeResumedAgentIntent("d0e1f2a3-b4c5-4d6e-8f7a-9b0c1d2e3f47");
    const bodies: Record<string, unknown>[] = [];
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input) === "/api/v1/agents" && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        bodies.push(body);
        if (bodies.length === 1) throw new Error("Connection lost after creation");
        return json(createdAgentConfig, 201);
      }
      throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${String(input)}`);
    });
    const { created } = await renderFlow();

    fireEvent.click(await screen.findByRole("button", { name: "Retry creation" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Connection lost after creation");
    // A send without an answer consumes nothing: the saved attempt and its identity stay put.
    expect(window.localStorage.getItem(creationIntentKey)).toContain(record.creationIntentId);

    fireEvent.click(screen.getByRole("button", { name: "Retry creation" }));

    await waitFor(() => expect(created).toHaveLength(1));
    expect(bodies).toHaveLength(2);
    expect(bodies[0]?.creationIntentId).toBe(record.creationIntentId);
    expect(bodies[1]?.creationIntentId).toBe(record.creationIntentId);
    expect(window.localStorage.getItem(creationIntentKey)).toBeNull();
    // Retry continues the original write; it never needed a fresh read of the Agents list.
    expect(vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === undefined)).toHaveLength(0);
  });

  it("discards the saved attempt locally and starts the next one under a fresh identity", async () => {
    const record = storeResumedAgentIntent("d0e1f2a3-b4c5-4d6e-8f7a-9b0c1d2e3f48");
    const bodies: Record<string, unknown>[] = [];
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input) === "/api/v1/agents" && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        bodies.push(body);
        return json(createdAgentConfig, 201);
      }
      throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${String(input)}`);
    });
    await renderFlow();

    fireEvent.click(await screen.findByRole("button", { name: "Discard attempt" }));

    await waitFor(() => expect(screen.queryByRole("button", { name: "Check result" })).toBeNull());
    expect(window.localStorage.getItem(creationIntentKey)).toBeNull();
    // Discard is a local decision: not a single request left the browser for it.
    expect(vi.mocked(fetch).mock.calls).toHaveLength(0);

    // The form kept the values it was showing, so creating now is a brand-new attempt.
    fireEvent.click(screen.getByRole("button", { name: "Create Agent" }));

    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]?.creationIntentId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(bodies[0]?.creationIntentId).not.toBe(record.creationIntentId);
    expect(bodies[0]?.name).toBe("resumed-agent");
  });

  it("keeps Retry parked until the saved route is ready again, across a remount that mutates nothing", async () => {
    const record = storeResumedAgentIntent("d0e1f2a3-b4c5-4d6e-8f7a-9b0c1d2e3f49");
    const stored = window.localStorage.getItem(creationIntentKey);
    const routeDownFacts: AgentCreationFacts = {
      computers: [{ id: computerId, displayName: "Ada's Mac", connectionStatus: "offline" }],
      providers: [{ computerId, provider: "codex", runtimeReady: false, status: "unavailable" }],
      runtimeEvidenceAvailable: true,
    };
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input) === "/api/v1/agents" && init?.method === "POST") return json(createdAgentConfig, 201);
      throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${String(input)}`);
    });
    const first = await renderFlow({ facts: routeDownFacts });

    const parkedRetry = await screen.findByRole("button", { name: "Retry creation" });
    expect(parkedRetry.hasAttribute("disabled")).toBe(true);
    expect(screen.getByText(/Retry uses the original Computer and Runtime/)).toBeTruthy();
    // A route that is not ready takes away only Retry; Check and Discard stay available.
    expect(screen.getByRole("button", { name: "Check result" }).hasAttribute("disabled")).toBe(false);
    expect(screen.getByRole("button", { name: "Discard attempt" }).hasAttribute("disabled")).toBe(false);
    first.unmount();

    // The remount finds the route ready, still sends nothing by itself, and unlocks the same Retry.
    const second = await renderFlow();
    expect(vi.mocked(fetch).mock.calls).toHaveLength(0);
    expect(window.localStorage.getItem(creationIntentKey)).toBe(stored);

    fireEvent.click(await screen.findByRole("button", { name: "Retry creation" }));

    await waitFor(() => expect(second.created).toHaveLength(1));
    const posts = vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST");
    expect(posts).toHaveLength(1);
    expect(JSON.parse(String(posts[0]?.[1]?.body)).creationIntentId).toBe(record.creationIntentId);
  });

  it("ignores a stored attempt entirely in preview", async () => {
    storeResumedAgentIntent("d0e1f2a3-b4c5-4d6e-8f7a-9b0c1d2e3f4a");
    const stored = window.localStorage.getItem(creationIntentKey);
    await renderFlow({ preview: true });

    expect(await screen.findByLabelText("Display name")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Check result" })).toBeNull();
    expect((screen.getByLabelText("Display name") as HTMLInputElement).value).toBe("");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(vi.mocked(fetch).mock.calls).toHaveLength(0);
    expect(window.localStorage.getItem(creationIntentKey)).toBe(stored);
  });
});
