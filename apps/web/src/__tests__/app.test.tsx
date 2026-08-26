import type { AgentUsageDetail } from "@opentag/shared/browser";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../app.js";

const workspaceId = "d3fda800-7ce2-4338-aae8-3d2120401ed6";
const secondaryWorkspaceId = "3928e3dc-99b0-4a79-97c8-bf9c26b91add";
const userId = "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e";
const memberUserId = "63e2babe-e4ac-4e2c-b7d1-d092d5a4568e";
const agentId = "1a63a21e-f6c7-4474-91ea-4dabf0566a24";
const computerId = "85fe9af3-d1c6-472b-b78c-8a7ccf512750";

const agentSummary = {
  id: agentId,
  workspaceId,
  name: "reviewer",
  displayName: "Reviewer",
  createdBy: { userId, displayName: "Ada" },
  computer: {
    computerId,
    displayName: "Ada's Mac",
    platform: "darwin",
  },
  runtimeProvider: "codex",
  receiveMode: "mention_only",
  status: "active",
  createdAt: "2026-08-20T00:00:00.000Z",
  updatedAt: "2026-08-20T00:00:00.000Z",
};
const agentListItem = {
  ...agentSummary,
  activity: { state: "idle" as const },
  usage: { windowDays: 30 as const, tasks: 32, failed: 0, tokens: 428_000 },
};

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function installApi(
  options: {
    agentCreator?: { userId: string; displayName: string };
    agentRead?: () => Promise<void> | void;
    agentReadStatus?: () => number | undefined;
    agentUsage?: Omit<AgentUsageDetail, "endedAt" | "startedAt" | "windowDays">;
    agentListStatus?: () => number | undefined;
    agentActivity?: { state: "idle" } | { state: "working"; startedAt: string };
    emptyAgents?: boolean;
    agentCreate?: (input: Record<string, unknown>) => Promise<void> | void;
    multipleMemberships?: boolean;
    agentCreateError?: "conflict" | "generic" | "name";
    authProviders?: readonly { enabled: boolean; id: string; startUrl: string | null }[];
    bindingReauth?: boolean;
    bindingEvidenceFails?: boolean;
    bindingState?: "provisioning" | "active";
    bound?: boolean;
    computers?:
      | readonly Record<string, unknown>[]
      | ((connected: boolean) => Promise<readonly Record<string, unknown>[]> | readonly Record<string, unknown>[]);
    computerEvidenceFails?: boolean;
    computerProviderReadiness?: readonly {
      observedAt: string | null;
      provider: "codex" | "claude-code";
      status: "checking" | "install" | "sign-in" | "ready" | "unavailable";
    }[];
    computerStatus?: () => "online" | "offline";
    computerReadStatus?: (connected: boolean) => number | undefined;
    handoffReady?: boolean;
    initialStatus?: "active" | "suspended";
    provider?: "feishu" | "slack";
    runtimeProvider?: "codex" | "claude-code";
    meFailuresAfterProfileUpdate?: number;
    profileUpdate?: (displayName: string) => Promise<Response> | Response;
    profileUpdateFails?: boolean;
    setupFailureCode?: string;
    setupCompletedAt?: string | null;
    unauthenticated?: boolean;
    workspaceless?: boolean;
  } = {},
) {
  let lifecycleStatus = options.initialStatus ?? "active";
  let revision = lifecycleStatus === "active" ? 1 : 2;
  const adminConfig = () => ({
    id: agentId,
    workspaceId,
    name: agentSummary.name,
    displayName: agentSummary.displayName,
    runtimeProvider: options.runtimeProvider ?? agentSummary.runtimeProvider,
    receiveMode: agentSummary.receiveMode,
    status: lifecycleStatus,
    createdAt: agentSummary.createdAt,
    updatedAt: agentSummary.updatedAt,
    createdByUserId: options.agentCreator?.userId ?? userId,
    computerId,
    revision,
    runtimeConfig: {
      revision: 1,
      model: null,
      reasoningEffort: null,
      instructions: "",
      maxDurationMs: null,
    },
  });
  let setupCompletedAt = options.setupCompletedAt === undefined ? "2026-08-20T00:00:00.000Z" : options.setupCompletedAt;
  let currentDisplayName = "Ada";
  let profileUpdated = false;
  let meFailuresRemaining = options.meFailuresAfterProfileUpdate ?? 0;
  let computerConnectCodeIssued = false;
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    const path = String(input);
    if (path === "/api/v1/auth/providers") {
      return json({
        providers: options.authProviders ?? [{ id: "dev", enabled: true, startUrl: "/api/v1/auth/dev/callback" }],
      });
    }
    if (path === "/api/v1/me" && init?.method === "PATCH") {
      const body = JSON.parse(String(init.body)) as { displayName: string };
      const response = options.profileUpdate
        ? await options.profileUpdate(body.displayName)
        : options.profileUpdateFails
          ? json(
              {
                error: {
                  code: "VALIDATION_ERROR",
                  category: "validation",
                  message: "Display name update failed",
                },
              },
              400,
            )
          : json({ id: userId, email: "ada@example.com", displayName: body.displayName.trim() });
      if (response.ok) {
        currentDisplayName = body.displayName.trim();
        profileUpdated = true;
      }
      return response;
    }
    if (path === "/api/v1/me") {
      if (options.unauthenticated) return json({ error: { message: "Sign in required" } }, 401);
      if (profileUpdated && meFailuresRemaining > 0) {
        meFailuresRemaining -= 1;
        return json(
          { error: { code: "SERVICE_UNAVAILABLE", category: "transient", message: "Account state unavailable" } },
          503,
        );
      }
      const existing = options.workspaceless
        ? []
        : [
            {
              id: workspaceId,
              name: "example",
              displayName: "Example",
              setupCompletedAt,
              grantedAt: "2026-08-20T00:00:00.000Z",
            },
          ];
      return json({
        user: { id: userId, email: "ada@example.com", displayName: currentDisplayName },
        workspaces: [
          ...existing,
          ...(options.multipleMemberships
            ? [
                {
                  id: secondaryWorkspaceId,
                  name: "secondary",
                  displayName: "Secondary",
                  setupCompletedAt: "2026-08-20T00:00:00.000Z",
                  grantedAt: "2026-08-20T00:00:00.000Z",
                },
              ]
            : []),
        ],
      });
    }
    if (path === `/api/v1/workspaces/${workspaceId}/setup/complete` && init?.method === "POST") {
      setupCompletedAt = "2026-08-20T00:10:00.000Z";
      return json({ setupCompletedAt });
    }
    if (/^\/api\/v1\/workspaces\/[^/]+\/agents$/.test(path) && init?.method === "POST") {
      if (options.agentCreateError) {
        if (options.agentCreateError === "conflict") {
          return json(
            {
              error: {
                code: "AGENT_NAME_CONFLICT",
                category: "deterministic",
                message: "An active Agent with this name already exists in the Workspace",
              },
            },
            409,
          );
        }
        return json(
          {
            error: {
              code: "VALIDATION_ERROR",
              category: "validation",
              message: "The request payload is invalid",
              ...(options.agentCreateError === "name"
                ? { issues: [{ path: ["name"], code: "invalid_format", message: "Use a lowercase Agent name" }] }
                : {}),
            },
          },
          400,
        );
      }
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      await options.agentCreate?.(body);
      return json(adminConfig(), 201);
    }
    if (/^\/api\/v1\/workspaces\/[^/]+\/agents$/.test(path) && init?.method === undefined) {
      const failureStatus = options.agentListStatus?.();
      if (failureStatus) return json({ error: { message: "Agent list unavailable" } }, failureStatus);
      return json({
        agents: options.emptyAgents
          ? []
          : [
              {
                ...agentListItem,
                createdBy: options.agentCreator ?? agentListItem.createdBy,
                activity: options.agentActivity ?? agentListItem.activity,
                status: lifecycleStatus,
                runtimeProvider: options.runtimeProvider ?? agentListItem.runtimeProvider,
              },
            ],
      });
    }
    if (/^\/api\/v1\/workspaces\/[^/]+\/computers$/.test(path)) {
      const failureStatus = options.computerReadStatus?.(computerConnectCodeIssued);
      if (failureStatus) return json({ error: { message: "Computer readiness unavailable" } }, failureStatus);
      if (options.computerEvidenceFails) return json({ error: { message: "Computer evidence unavailable" } }, 503);
      const configured =
        typeof options.computers === "function"
          ? await options.computers(computerConnectCodeIssued)
          : options.computers;
      const normalizeComputer = (computer: Record<string, unknown>) => ({
        computerId: computer.computerId ?? computer.id,
        displayName: computer.displayName,
        platform: computer.platform,
        connectionStatus: computer.connectionStatus,
        providerReadiness: computer.providerReadiness,
        connectedAt: computer.connectedAt ?? null,
        lastSeenAt: computer.lastSeenAt ?? null,
        observedAt: computer.observedAt ?? computer.lastSeenAt ?? computer.connectedAt ?? "2026-08-20T00:00:00.000Z",
        enrolledAt: computer.enrolledAt ?? "2026-08-20T00:00:00.000Z",
        agentIds: computer.agentIds ?? [agentId],
      });
      return json({
        computers: configured?.map(normalizeComputer) ?? [
          normalizeComputer({
            id: computerId,
            displayName: "Ada's Mac",
            platform: "darwin",
            connectionStatus: options.computerStatus?.() ?? "online",
            providerReadiness: options.computerProviderReadiness ?? [
              { provider: "codex", status: "ready", observedAt: "2026-08-20T00:00:00.000Z" },
            ],
            connectedAt: "2026-08-20T00:00:00.000Z",
            lastSeenAt: "2026-08-20T00:00:00.000Z",
          }),
        ],
      });
    }
    if (/^\/api\/v1\/workspaces\/[^/]+\/computer-connect-codes$/.test(path) && init?.method === "POST") {
      computerConnectCodeIssued = true;
      return json(
        {
          bootstrapCommand: "opentag computer connect --server https://opentag.example.com -- example",
          expiresIn: 900,
          issuedAt: "2026-08-20T00:00:00.000Z",
        },
        201,
      );
    }
    if (path.startsWith(`/api/v1/agents/${agentId}/usage?`)) {
      const days = Number(new URL(path, "https://opentag.test").searchParams.get("days"));
      return json({
        windowDays: days,
        startedAt: "2026-07-25T12:00:00.000Z",
        endedAt: "2026-08-24T12:00:00.000Z",
        ...(options.agentUsage ?? {
          tasks: 32,
          measuredTasks: 31,
          failed: 0,
          inputTokens: 360_000,
          cachedInputTokens: 120_000,
          outputTokens: 68_000,
          tokens: 428_000,
          daily: [
            {
              date: "2026-08-20",
              tasks: 15,
              measuredTasks: 15,
              inputTokens: 160_000,
              cachedInputTokens: 50_000,
              outputTokens: 30_000,
              tokens: 190_000,
            },
            {
              date: "2026-08-22",
              tasks: 0,
              measuredTasks: 0,
              inputTokens: 0,
              cachedInputTokens: 0,
              outputTokens: 0,
              tokens: 0,
            },
            {
              date: "2026-08-24",
              tasks: 17,
              measuredTasks: 16,
              inputTokens: 200_000,
              cachedInputTokens: 70_000,
              outputTokens: 38_000,
              tokens: 238_000,
            },
          ],
        }),
      });
    }
    if (path === `/api/v1/agents/${agentId}`) {
      if (init?.method === "PATCH") return json(adminConfig());
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      await options.agentRead?.();
      const failureStatus = options.agentReadStatus?.();
      if (failureStatus) {
        return json(
          { error: { code: "RESOURCE_NOT_FOUND", category: "deterministic", message: "Agent unavailable" } },
          failureStatus,
        );
      }
      return json({
        ...agentSummary,
        createdBy: options.agentCreator ?? agentSummary.createdBy,
        runtimeProvider: options.runtimeProvider ?? agentSummary.runtimeProvider,
        status: lifecycleStatus,
        activity: options.agentActivity ?? { state: "idle" },
      });
    }
    if (path === `/api/v1/agents/${agentId}/config`) {
      return json(adminConfig());
    }
    if (path === `/api/v1/agents/${agentId}/suspend` && init?.method === "POST") {
      lifecycleStatus = "suspended";
      revision += 1;
      return json(adminConfig());
    }
    if (path === `/api/v1/agents/${agentId}/reactivate` && init?.method === "POST") {
      lifecycleStatus = "active";
      revision += 1;
      return json(adminConfig());
    }
    if (path === `/api/v1/agents/${agentId}/im-binding/handoff`) {
      if (options.bindingEvidenceFails) {
        return json(
          {
            error: {
              code: "SERVICE_UNAVAILABLE",
              category: "transient",
              message: "Handoff evidence unavailable",
            },
          },
          503,
        );
      }
      if (!options.bound) return new Response(null, { status: 204 });
      const bindingState = options.bindingReauth ? "reauthorization_required" : "active";
      return json({ bindingState, handoffReady: options.handoffReady ?? bindingState === "active" });
    }
    if (path === `/api/v1/agents/${agentId}/im-binding`) {
      if (options.bindingEvidenceFails) {
        return json(
          {
            error: {
              code: "SERVICE_UNAVAILABLE",
              category: "transient",
              message: "Binding evidence unavailable",
            },
          },
          503,
        );
      }
      if (!options.bound) return new Response(null, { status: 204 });
      return json({
        id: crypto.randomUUID(),
        agentId,
        provider: options.provider ?? "feishu",
        bindingState: options.bindingState ?? (options.bindingReauth ? "reauthorization_required" : "active"),
        bot: { displayName: "Reviewer", avatarUrl: null },
        receiveMode: "mention_only",
        lastInboundAt: null,
        lastValidatedAt: "2026-08-20T00:00:00.000Z",
        lastRuntimeObservationAt: null,
      });
    }
    if (path === `/api/v1/agents/${agentId}/im-binding/feishu/setup-attempts` && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { intent: "create" | "reauthorize" | "replace" };
      return json(
        {
          id: crypto.randomUUID(),
          agentId,
          intent: body.intent,
          state: options.setupFailureCode ? "failed" : "awaiting_user",
          qrUrl: options.setupFailureCode ? null : "https://open.feishu.cn/setup",
          expiresAt: "2026-08-20T00:15:00.000Z",
          errorCode: options.setupFailureCode ?? null,
          completedAt: options.setupFailureCode ? "2026-08-20T00:01:00.000Z" : null,
          createdAt: "2026-08-20T00:00:00.000Z",
        },
        201,
      );
    }
    if (path === `/api/v1/agents/${agentId}/im-binding/slack/configuration` && (init?.method ?? "GET") === "GET") {
      return json({
        agentId,
        manifest: {
          display_information: { name: "Reviewer - OpenTag" },
          oauth_config: {
            scopes: {
              bot: [
                "app_mentions:read",
                "channels:history",
                "chat:write",
                "files:read",
                "groups:history",
                "im:history",
                "mpim:history",
              ],
            },
          },
          settings: {
            event_subscriptions: {
              bot_events: [
                "app_mention",
                "app_uninstalled",
                "message.channels",
                "message.groups",
                "message.im",
                "message.mpim",
                "tokens_revoked",
              ],
            },
          },
        },
        manifestUrl: "https://api.slack.com/apps?new_app=1&manifest_json=example",
        eventsUrl: `https://opentag.example.com/api/v1/agents/${agentId}/im-binding/slack/events`,
        requiredBotScopes: [
          "app_mentions:read",
          "channels:history",
          "chat:write",
          "files:read",
          "groups:history",
          "im:history",
          "mpim:history",
        ],
        subscribedBotEvents: [
          "app_mention",
          "app_uninstalled",
          "message.channels",
          "message.groups",
          "message.im",
          "message.mpim",
          "tokens_revoked",
        ],
        currentBinding: null,
      });
    }
    if (path === "/api/v1/auth/browser/logout" && init?.method === "POST") return new Response(null, { status: 204 });
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${path}`);
  });
}

describe("OpenTag Web App Shell", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    window.history.replaceState({}, "", "/agents");
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
  });

  it("uses the same Agents-first shell for admins", async () => {
    installApi();
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Agents" })).toBeTruthy();
    expect(window.location.pathname).toBe("/agents");
    expect(screen.queryByText("Infrastructure")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Agent runtime" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Computers" })).toBeNull();
    expect(screen.getByRole("main").classList.contains("decorative-page")).toBe(false);
    expect(screen.getByRole("link", { name: "Agents" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Settings" })).toBeNull();
    expect(screen.queryByText("Example")).toBeNull();
    const agentLink = await screen.findByRole("link", { name: "Open Reviewer" });
    const createAgent = screen.getByRole("button", { name: "New Agent" });
    expect(createAgent.closest(".page-header")).toBeTruthy();
    const agentCard = agentLink.closest(".agent-card");
    expect(agentCard).toBeTruthy();
    expect(screen.getByText("Monitor availability and 30-day usage across your AI teammates.")).toBeTruthy();
    expect(screen.queryByText("Usage · Last 30 days")).toBeNull();
    expect(within(agentCard as HTMLElement).getByText("Tasks")).toBeTruthy();
    expect(within(agentCard as HTMLElement).getByText("Tokens")).toBeTruthy();
    expect(within(agentCard as HTMLElement).getByText("428K")).toBeTruthy();
    expect(within(agentCard as HTMLElement).getByText("Not connected")).toBeTruthy();
    expect(
      within(agentCard as HTMLElement)
        .getByRole("link", { name: "Connect messaging" })
        .getAttribute("href"),
    ).toBe(`/agents/${agentId}/settings/messaging`);
    expect(screen.queryByText("Ada's Mac · macOS")).toBeNull();
    expect(screen.queryByText("Mentions only")).toBeNull();
    const workspaceNavigation = screen.getByRole("navigation", { name: "Product" });
    expect(
      within(workspaceNavigation)
        .getAllByRole("link")
        .map((item) => item.textContent),
    ).toEqual(["Agents", "Tasks", "Skills", "Integrations"]);
    const navigationIcons = workspaceNavigation.querySelectorAll(".primary-nav-icon");
    expect(navigationIcons).toHaveLength(4);
    expect(Array.from(navigationIcons).every((icon) => icon.getAttribute("aria-hidden") === "true")).toBe(true);
  });

  it("shows elapsed time without exposing conversation content for a working Agent", async () => {
    installApi({
      agentActivity: {
        state: "working",
        startedAt: new Date(Date.now() - 8 * 60_000).toISOString(),
      },
      bound: true,
      handoffReady: true,
    });
    render(<App />);

    const agentCard = (await screen.findByRole("link", { name: "Open Reviewer" })).closest(".agent-card");
    expect(agentCard).toBeTruthy();
    const status = within(agentCard as HTMLElement)
      .getByText("Working")
      .closest(".ds-status");
    expect(status).toBeTruthy();
    expect(within(status as HTMLElement).getByText("Started 8m ago")).toBeTruthy();
  });

  it("keeps an offline reason and its Computer exit together in the Agent status", async () => {
    installApi({
      bound: true,
      computerStatus: () => "offline",
      handoffReady: true,
    });
    render(<App />);

    const agentCard = (await screen.findByRole("link", { name: "Open Reviewer" })).closest(".agent-card");
    expect(agentCard).toBeTruthy();
    const status = within(agentCard as HTMLElement)
      .getByText("Needs attention")
      .closest(".ds-status");
    expect(status).toBeTruthy();
    expect(within(status as HTMLElement).getByText("Computer offline")).toBeTruthy();
    const exit = within(status as HTMLElement).getByRole("link", { name: "View Computer" });
    expect(exit.getAttribute("href")).toBe(`/agents/${agentId}/settings/computer`);
    expect(exit.classList.contains("ds-button--inline")).toBe(true);
    expect(exit.classList.contains("ds-button--outline")).toBe(false);
  });

  it("opens the Agent from the row rather than from a 36px chevron", async () => {
    installApi();
    render(<App />);

    const open = await screen.findByRole("link", { name: "Open Reviewer" });
    expect(open.textContent).toBe("Reviewer");
    expect(open.getAttribute("href")).toBe(`/agents/${agentId}`);
    const card = open.closest(".agent-card");
    expect(card).toBeTruthy();
    expect((card as HTMLElement).querySelector(".agent-card-action")?.tagName).toBe("SPAN");
    /*
     * The failure exit is a second link inside the same row. It has to stay a sibling of the row
     * link rather than a child of it: nesting would be invalid, and wrapping the row in one anchor
     * is the shortcut that would produce it.
     */
    const exit = within(card as HTMLElement).getByRole("link", { name: "Connect messaging" });
    expect(open.contains(exit)).toBe(false);
    expect(exit.getAttribute("href")).toBe(`/agents/${agentId}/settings/messaging`);
    expect(within(card as HTMLElement).getAllByRole("link")).toEqual([open, exit]);
  });

  it.each(["/", "/agents"])("redirects unauthenticated protected path %s to login", async (path) => {
    installApi({ unauthenticated: true });
    window.history.replaceState({}, "", path);
    render(<App />);
    const heading = await screen.findByRole("heading", { name: "Welcome back" });
    expect(heading.closest("main")?.classList.contains("decorative-page")).toBe(true);
    expect(screen.getByText("OpenTag").closest(".login-brand-lockup")).toBeTruthy();
    expect(screen.getByText("Sign in to continue to OpenTag.")).toBeTruthy();
    expect(screen.queryByText(/Permissions are checked/)).toBeNull();
    const expectedNext = path === "/" ? "/agents" : path;
    expect(window.location.search).toBe(`?next=${encodeURIComponent(expectedNext)}`);
  });

  it("renders the Google provider with its branded sign-in treatment", async () => {
    installApi({
      authProviders: [{ id: "google", enabled: true, startUrl: "/api/v1/auth/google/start" }],
      unauthenticated: true,
    });
    window.history.replaceState({}, "", "/agents");
    render(<App />);

    const signIn = await screen.findByRole("link", { name: "Sign in with Google" });
    expect(signIn.classList.contains("login-provider-button--google")).toBe(true);
    expect(signIn.querySelector('img[alt="Sign in with Google"]')).toBeTruthy();
    expect(new URL(signIn.getAttribute("href") ?? "", window.location.origin).searchParams.get("next")).toBe("/agents");
    expect(screen.getByText("Sign in to manage your Agents and Computers.")).toBeTruthy();
  });

  it("keeps authenticated invalid Agent tabs on the plain workspace canvas", async () => {
    installApi();
    window.history.replaceState({}, "", `/agents/${agentId}/unknown`);
    render(<App />);

    const heading = await screen.findByRole("heading", { name: "Page not found" });
    expect(heading.closest(".center-card")?.classList.contains("decorative-page")).toBe(false);
    expect(screen.getByRole("main").classList.contains("decorative-page")).toBe(false);
  });

  it("keeps the standalone not-found route on the decorative canvas", async () => {
    window.history.replaceState({}, "", "/unknown");
    render(<App />);

    const heading = await screen.findByRole("heading", { name: "Page not found" });
    expect(heading.closest("main")?.classList.contains("decorative-page")).toBe(true);
  });

  it("uses the page header as the Account owner's sole empty-state action", async () => {
    installApi({ emptyAgents: true });
    render(<App />);

    expect(await screen.findByRole("heading", { name: "No Agents yet" })).toBeTruthy();
    expect(screen.getByText("Create your first shared AI teammate with New Agent.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "New Agent" }).closest(".page-header")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Agents" })).toBeNull();
  });

  it("opens the complete New Agent form in a dialog and returns focus when cancelled", async () => {
    installApi();
    render(<App />);
    const trigger = await screen.findByRole("button", { name: "New Agent" });

    fireEvent.click(trigger);

    const dialog = await screen.findByRole("dialog", { name: "New Agent" });
    expect(within(dialog).queryByText("Create")).toBeNull();
    expect(window.location.pathname).toBe("/agents");
    await waitFor(() => expect(within(dialog).getByLabelText("Display name")).toBe(document.activeElement));
    expect(within(dialog).queryByLabelText("Agent name")).toBeNull();
    expect(within(dialog).getByRole("button", { name: "Edit Agent name" })).toBeTruthy();
    expect(within(dialog).getByRole("heading", { name: "Where it runs" })).toBeTruthy();
    expect(within(dialog).getByText("Ready to run")).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Create Agent" })).toBeTruthy();

    fireEvent.change(within(dialog).getByLabelText("Display name"), { target: { value: "Research Assistant" } });
    expect(within(dialog).getByText("@research-assistant")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Edit Agent name" }));
    const name = within(dialog).getByLabelText("Agent name") as HTMLInputElement;
    expect(name.value).toBe("research-assistant");
    await waitFor(() => expect(name).toBe(document.activeElement));
    fireEvent.change(name, { target: { value: "custom-researcher" } });
    fireEvent.change(within(dialog).getByLabelText("Display name"), { target: { value: "Research Partner" } });
    expect(name.value).toBe("custom-researcher");

    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog", { name: "New Agent" })).toBeNull();
    expect(trigger).toBe(document.activeElement);
  });

  it("lets a Workspace Admin connect another Computer from New Agent", async () => {
    installApi();
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "New Agent" }));

    const dialog = await screen.findByRole("dialog", { name: "New Agent" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Change Computer" }));
    const trigger = within(dialog).getByRole("button", { name: "Connect another Computer" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(trigger);

    expect(within(dialog).getByRole("heading", { name: "Connect a Local Computer" })).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Generate connection command" })).toBeTruthy();
    expect(
      within(dialog).getByRole("button", { name: "Cancel Computer connection" }).getAttribute("aria-expanded"),
    ).toBe("true");
    expect(within(dialog).getByRole("heading", { name: "Where it runs" })).toBeTruthy();
    expect(within(dialog).getByText("Ready to run")).toBeTruthy();
  });

  it("refreshes and selects a newly connected Computer in New Agent", async () => {
    const connectedComputerId = "95fe9af3-d1c6-472b-b78c-8a7ccf512750";
    const existingComputer = {
      id: computerId,
      displayName: "Ada's Mac",
      platform: "darwin",
      arch: "arm64",
      clientVersion: "0.0.1",
      connectionStatus: "online",
      providerReadiness: [{ provider: "codex", status: "ready", observedAt: "2026-08-20T00:00:00.000Z" }],
      connectedAt: "2026-08-20T00:00:00.000Z",
      lastSeenAt: "2026-08-20T00:00:01.000Z",
    };
    const connectedComputer = {
      ...existingComputer,
      id: connectedComputerId,
      displayName: "Ada's Linux Computer",
      platform: "linux",
      connectedAt: "2026-08-20T00:00:02.000Z",
    };
    let finishRefresh: (() => void) | undefined;
    const refreshPending = new Promise<void>((resolve) => {
      finishRefresh = resolve;
    });
    installApi({
      computers: async (connected) => {
        if (connected) await refreshPending;
        return connected ? [existingComputer, connectedComputer] : [existingComputer];
      },
    });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "New Agent" }));
    const dialog = await screen.findByRole("dialog", { name: "New Agent" });
    fireEvent.change(within(dialog).getByLabelText("Display name"), {
      target: { value: "Research Assistant" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Edit Agent name" }));
    fireEvent.change(within(dialog).getByLabelText("Agent name"), {
      target: { value: "research-assistant" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Change Computer" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Connect another Computer" }));

    vi.useFakeTimers();
    vi.setSystemTime("2026-08-20T00:00:00.000Z");
    try {
      const generateButton = within(dialog).getByRole("button", { name: "Generate connection command" });
      generateButton.focus();
      await act(async () => {
        fireEvent.click(generateButton);
      });
      await act(async () => {
        vi.advanceTimersByTime(1_500);
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(dialog.contains(document.activeElement)).toBe(true);
      await act(async () => {
        finishRefresh?.();
        await Promise.resolve();
      });

      expect(within(dialog).getByText("Ada's Linux Computer")).toBeTruthy();
      expect(within(dialog).getByText("Codex")).toBeTruthy();
      expect((within(dialog).getByLabelText("Display name") as HTMLInputElement).value).toBe("Research Assistant");
      expect((within(dialog).getByLabelText("Agent name") as HTMLInputElement).value).toBe("research-assistant");
      expect(within(dialog).queryByRole("heading", { name: "Connect a Local Computer" })).toBeNull();
      expect(within(dialog).getByRole("button", { name: "Change Computer" })).toBe(document.activeElement);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a connection attempt visible when a Computer refresh fails", async () => {
    const connectedComputer = {
      id: "95fe9af3-d1c6-472b-b78c-8a7ccf512750",
      displayName: "Ada's Linux Computer",
      platform: "linux",
      arch: "arm64",
      clientVersion: "0.0.1",
      connectionStatus: "online",
      providerReadiness: [{ provider: "codex", status: "ready", observedAt: "2026-08-20T00:00:02.000Z" }],
      connectedAt: "2026-08-20T00:00:02.000Z",
      lastSeenAt: "2026-08-20T00:00:02.000Z",
    };
    installApi({
      computers: (connected) => (connected ? [connectedComputer] : []),
      computerReadStatus: (connected) => (connected ? 404 : undefined),
    });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "New Agent" }));
    const dialog = await screen.findByRole("dialog", { name: "New Agent" });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-20T00:00:00.000Z");
    try {
      const generateButton = within(dialog).getByRole("button", { name: "Generate connection command" });
      generateButton.focus();
      await act(async () => {
        fireEvent.click(generateButton);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_000);
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(within(dialog).getByRole("alert").textContent).toContain("Request failed");
      const refreshStatus = within(dialog).getByRole("status");
      expect(refreshStatus.textContent).toContain("Waiting for the Computer to connect");
      expect(dialog.contains(document.activeElement)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("completes an existing Computer reconnection in New Agent", async () => {
    const disconnectedAt = "2026-08-20T00:00:00.000Z";
    const reconnectedAt = "2026-08-20T00:00:02.000Z";
    const existingComputer = {
      id: computerId,
      displayName: "Ada's Mac",
      platform: "darwin",
      arch: "arm64",
      clientVersion: "0.0.1",
      connectionStatus: "online",
      providerReadiness: [{ provider: "codex", status: "ready", observedAt: disconnectedAt }],
      connectedAt: disconnectedAt,
      lastSeenAt: "2026-08-20T00:00:01.000Z",
    };
    installApi({
      computers: (connected) =>
        connected ? [{ ...existingComputer, connectedAt: reconnectedAt }] : [existingComputer],
    });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "New Agent" }));
    const dialog = await screen.findByRole("dialog", { name: "New Agent" });
    fireEvent.change(within(dialog).getByLabelText("Display name"), {
      target: { value: "Research Assistant" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Edit Agent name" }));
    fireEvent.change(within(dialog).getByLabelText("Agent name"), {
      target: { value: "research-assistant" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Change Computer" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Connect another Computer" }));

    vi.useFakeTimers();
    vi.setSystemTime(disconnectedAt);
    try {
      const generateButton = within(dialog).getByRole("button", { name: "Generate connection command" });
      generateButton.focus();
      await act(async () => {
        fireEvent.click(generateButton);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_500);
      });

      expect(within(dialog).getByText("Ada's Mac")).toBeTruthy();
      expect(within(dialog).getByText("Codex")).toBeTruthy();
      expect((within(dialog).getByLabelText("Display name") as HTMLInputElement).value).toBe("Research Assistant");
      expect((within(dialog).getByLabelText("Agent name") as HTMLInputElement).value).toBe("research-assistant");
      expect(within(dialog).queryByRole("heading", { name: "Connect a Local Computer" })).toBeNull();
      expect(within(dialog).getByRole("button", { name: "Change Computer" })).toBe(document.activeElement);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps Computer connection inside the New Agent dialog when no runtime is available", async () => {
    const connectedComputer = {
      id: computerId,
      displayName: "Ada's Mac",
      platform: "darwin",
      arch: "arm64",
      clientVersion: "0.0.1",
      connectionStatus: "online",
      providerReadiness: [{ provider: "codex", status: "ready", observedAt: "2026-08-20T00:00:02.000Z" }],
      connectedAt: "2026-08-20T00:00:02.000Z",
      lastSeenAt: "2026-08-20T00:00:02.000Z",
    };
    let finishRefresh: (() => void) | undefined;
    const refreshPending = new Promise<void>((resolve) => {
      finishRefresh = resolve;
    });
    installApi({
      computers: async (connected) => {
        if (connected) await refreshPending;
        return connected ? [connectedComputer] : [];
      },
    });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "New Agent" }));

    const dialog = await screen.findByRole("dialog", { name: "New Agent" });
    expect(within(dialog).getByRole("heading", { name: "Connect a Local Computer" })).toBeTruthy();
    const generateButton = within(dialog).getByRole("button", { name: "Generate connection command" });
    expect(within(dialog).queryByRole("link", { name: "Agent runtime" })).toBeNull();

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-20T00:00:00.000Z");
    try {
      generateButton.focus();
      await act(async () => {
        fireEvent.click(generateButton);
      });
      await act(async () => {
        vi.advanceTimersByTime(1_500);
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(dialog.contains(document.activeElement)).toBe(true);
      await act(async () => {
        finishRefresh?.();
        await Promise.resolve();
      });

      expect(within(dialog).getByText("Ada's Mac")).toBeTruthy();
      expect(within(dialog).getByText("Codex")).toBeTruthy();
      expect(within(dialog).getByRole("button", { name: "Change Computer" })).toBe(document.activeElement);
    } finally {
      vi.useRealTimers();
    }
  });

  it("creates an Agent from the dialog without a second creation screen", async () => {
    installApi();
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "New Agent" }));
    const dialog = await screen.findByRole("dialog", { name: "New Agent" });

    fireEvent.change(within(dialog).getByLabelText("Display name"), { target: { value: "Research Assistant" } });
    expect(within(dialog).queryByLabelText("Agent name")).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Create Agent" }));

    expect(await within(dialog).findByRole("heading", { name: "Connect messaging" })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Set up later" }));
    await waitFor(() => expect(window.location.pathname).toBe(`/agents/${agentId}`));
    const createCall = vi
      .mocked(fetch)
      .mock.calls.find(
        ([input, init]) => String(input) === `/api/v1/workspaces/${workspaceId}/agents` && init?.method === "POST",
      );
    expect(createCall).toBeTruthy();
    expect(JSON.parse(String(createCall?.[1]?.body))).toEqual({
      creationIntentId: expect.any(String),
      name: "research-assistant",
      displayName: "Research Assistant",
      runtimeProvider: "codex",
      computerId,
    });
  });

  it("blocks duplicate Agent submissions synchronously and repairs focus while creation is pending", async () => {
    let resolveCreate: () => void = () => undefined;
    const pendingCreate = new Promise<void>((resolve) => {
      resolveCreate = resolve;
    });
    installApi({ agentCreate: () => pendingCreate });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "New Agent" }));
    const dialog = await screen.findByRole("dialog", { name: "New Agent" });
    fireEvent.change(within(dialog).getByLabelText("Display name"), { target: { value: "Research Assistant" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Edit Agent name" }));
    fireEvent.change(within(dialog).getByLabelText("Agent name"), { target: { value: "research-assistant" } });
    const form = within(dialog).getByRole("button", { name: "Create Agent" }).closest("form");
    const submitButton = within(dialog).getByRole("button", { name: "Create Agent" });
    submitButton.focus();

    if (!form) throw new Error("Expected the New Agent form");
    fireEvent.submit(form);
    fireEvent.submit(form);

    await waitFor(() =>
      expect(
        vi
          .mocked(fetch)
          .mock.calls.filter(
            ([input, init]) => String(input) === `/api/v1/workspaces/${workspaceId}/agents` && init?.method === "POST",
          ),
      ).toHaveLength(1),
    );
    await waitFor(() => expect(dialog).toBe(document.activeElement));
    expect((within(dialog).getByLabelText("Display name") as HTMLInputElement).disabled).toBe(true);
    expect((within(dialog).getByLabelText("Agent name") as HTMLInputElement).disabled).toBe(true);
    expect(within(dialog).getByRole("status").textContent).toContain("Ready to run");
    expect(within(dialog).getByRole("button", { name: "Creating…" }).hasAttribute("disabled")).toBe(true);
    expect(within(dialog).getByRole("button", { name: "Cancel" }).hasAttribute("disabled")).toBe(true);
    expect(within(dialog).getByRole("button", { name: "Close new Agent dialog" }).hasAttribute("disabled")).toBe(true);
    fireEvent.keyDown(document.activeElement ?? dialog, { key: "Escape" });
    expect(screen.getByRole("dialog", { name: "New Agent" })).toBe(dialog);

    resolveCreate();
    expect(await within(dialog).findByRole("heading", { name: "Connect messaging" })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Set up later" }));
    await waitFor(() => expect(window.location.pathname).toBe(`/agents/${agentId}`));
  });

  it("reuses one creation intent when an unchanged Agent request is retried", async () => {
    const attempts: Record<string, unknown>[] = [];
    installApi({
      agentCreate: (input) => {
        attempts.push(input);
        if (attempts.length === 1) throw new Error("Connection lost after creation");
      },
    });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "New Agent" }));
    const dialog = await screen.findByRole("dialog", { name: "New Agent" });
    fireEvent.change(within(dialog).getByLabelText("Display name"), { target: { value: "Research Assistant" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Edit Agent name" }));
    fireEvent.change(within(dialog).getByLabelText("Agent name"), { target: { value: "research-assistant" } });

    fireEvent.click(within(dialog).getByRole("button", { name: "Create Agent" }));
    expect((await within(dialog).findByRole("alert")).textContent).toContain("Connection lost after creation");
    fireEvent.click(within(dialog).getByRole("button", { name: "Create Agent" }));

    expect(await within(dialog).findByRole("heading", { name: "Connect messaging" })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Set up later" }));
    await waitFor(() => expect(window.location.pathname).toBe(`/agents/${agentId}`));
    expect(attempts).toHaveLength(2);
    expect(attempts[0]?.creationIntentId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(attempts[1]?.creationIntentId).toBe(attempts[0]?.creationIntentId);
  });

  it("lets an Account update its global display name", async () => {
    installApi();
    window.history.replaceState({}, "", "/account");
    render(<App />);

    const email = (await screen.findByLabelText("Email")) as HTMLInputElement;
    const displayName = screen.getByLabelText("Display name") as HTMLInputElement;
    expect(email.value).toBe("ada@example.com");
    expect(email.readOnly).toBe(true);
    expect(email.closest(".ds-field")).toBeTruthy();
    expect(displayName.closest(".ds-field")).toBeTruthy();
    fireEvent.change(displayName, { target: { value: "  Ada Lovelace  " } });
    fireEvent.click(await screen.findByRole("button", { name: "Save account profile" }));

    await waitFor(() =>
      expect(vi.mocked(fetch).mock.calls.filter(([input]) => String(input) === "/api/v1/me")).toHaveLength(3),
    );
    expect(await screen.findByText("Ada Lovelace")).toBeTruthy();
    expect((screen.getByLabelText("Display name") as HTMLInputElement).value).toBe("Ada Lovelace");
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      "/api/v1/me",
      expect.objectContaining({ method: "PATCH", body: JSON.stringify({ displayName: "  Ada Lovelace  " }) }),
    );
  });

  it("prevents duplicate account saves while a profile update is pending", async () => {
    let resolveUpdate: (response: Response) => void = () => undefined;
    const update = new Promise<Response>((resolve) => {
      resolveUpdate = resolve;
    });
    installApi({ profileUpdate: () => update });
    window.history.replaceState({}, "", "/account");
    render(<App />);

    const displayName = (await screen.findByLabelText("Display name")) as HTMLInputElement;
    const form = displayName.closest("form");
    if (!form) throw new Error("Account form was not rendered");
    fireEvent.change(displayName, { target: { value: "Pending Name" } });
    fireEvent.click(await screen.findByRole("button", { name: "Save account profile" }));
    fireEvent.submit(form);

    expect(((await screen.findByRole("button", { name: "Saving…" })) as HTMLButtonElement).disabled).toBe(true);
    expect(
      vi.mocked(fetch).mock.calls.filter(([input, init]) => String(input) === "/api/v1/me" && init?.method === "PATCH"),
    ).toHaveLength(1);
    resolveUpdate(json({ id: userId, email: "ada@example.com", displayName: "Pending Name" }));
    await waitFor(() => expect(screen.getByText("Pending Name")).toBeTruthy());
  });

  it("treats a saved name whose refresh failed as needing synchronization, not as unsaved data", async () => {
    installApi({ meFailuresAfterProfileUpdate: 1 });
    window.history.replaceState({}, "", "/account");
    render(<App />);

    const displayName = (await screen.findByLabelText("Display name")) as HTMLInputElement;
    fireEvent.change(displayName, { target: { value: "Ada Lovelace" } });
    fireEvent.click(await screen.findByRole("button", { name: "Save account profile" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(
      "Your display name was saved. OpenTag could not refresh the account, so the rest of the page still shows the previous name.",
    );
    // The write committed, so the page must not offer to repeat it, must not offer to discard it,
    // and must not describe the saved value as unsaved.
    expect(screen.queryByText("Unsaved changes")).toBeNull();
    expect(screen.queryByRole("button", { name: "Save account profile" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Discard" })).toBeNull();
    expect(screen.queryByText("Account profile saved.")).toBeNull();
    expect(screen.getByText("Account not refreshed")).toBeTruthy();
    expect(displayName.value).toBe("Ada Lovelace");

    // Retry re-runs only the refresh; one PATCH was ever sent.
    fireEvent.click(screen.getByRole("button", { name: "Retry refresh" }));

    expect(await screen.findByText("Account profile saved.")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText("Account not refreshed")).toBeNull();
    expect(await screen.findByText("Ada Lovelace")).toBeTruthy();
    expect(
      vi.mocked(fetch).mock.calls.filter(([input, init]) => String(input) === "/api/v1/me" && init?.method === "PATCH"),
    ).toHaveLength(1);
  });

  it("discards back to the saved name, never the stale one, while a refresh is outstanding", async () => {
    installApi({ meFailuresAfterProfileUpdate: 99 });
    window.history.replaceState({}, "", "/account");
    render(<App />);

    const displayName = (await screen.findByLabelText("Display name")) as HTMLInputElement;
    fireEvent.change(displayName, { target: { value: "Ada Lovelace" } });
    fireEvent.click(await screen.findByRole("button", { name: "Save account profile" }));
    await screen.findByText("Account not refreshed");

    // Editing again reopens the unsaved-changes bar, and Discard must return to the saved value.
    fireEvent.change(displayName, { target: { value: "Third Name" } });
    expect(await screen.findByText("Unsaved changes")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));

    expect(displayName.value).toBe("Ada Lovelace");
    expect(await screen.findByText("Account not refreshed")).toBeTruthy();
  });

  it("restores the confirmed server name and shows the error when an account update fails", async () => {
    installApi({ profileUpdateFails: true });
    window.history.replaceState({}, "", "/account");
    render(<App />);

    const displayName = (await screen.findByLabelText("Display name")) as HTMLInputElement;
    fireEvent.change(displayName, { target: { value: "Rejected Name" } });
    fireEvent.click(await screen.findByRole("button", { name: "Save account profile" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Display name update failed");
    expect(displayName.value).toBe("Ada");
    expect(screen.getByText("Ada")).toBeTruthy();
  });

  it.each(["/workspace", "/admins", `/invites/${"A".repeat(43)}`])(
    "does not preserve retired Workspace product route %s",
    async (path) => {
      window.history.replaceState({}, "", path);
      render(<App />);
      expect(await screen.findByRole("heading", { name: "Page not found" })).toBeTruthy();
      expect(window.location.pathname).toBe(path);
      expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    },
  );

  it("keeps the Agent home focused on status, current work, and contact", async () => {
    installApi({ bound: true });
    window.history.replaceState({}, "", `/agents/${agentId}`);
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Reviewer" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Current work" })).toBeTruthy();
    expect(screen.getByText("No active work")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Where to use this Agent" })).toBeTruthy();
    expect(screen.getByText("Send @reviewer a direct message, or mention it in a Feishu group chat.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Settings" }).getAttribute("href")).toBe(`/agents/${agentId}/settings`);
    expect(screen.getByRole("link", { name: "Usage" }).getAttribute("href")).toBe(`/agents/${agentId}/usage`);
    expect(screen.queryByLabelText("More Agent actions")).toBeNull();
    expect(screen.queryByRole("navigation", { name: "Agent sections" })).toBeNull();
    expect(screen.queryByText("Runtime")).toBeNull();
  });

  it("shows another Admin's creation identity as audit information, not management ownership", async () => {
    installApi({ agentCreator: { userId: memberUserId, displayName: "Grace" }, bound: true });
    window.history.replaceState({}, "", `/agents/${agentId}`);
    render(<App />);

    expect(await screen.findByText("Created by Grace")).toBeTruthy();
    expect(screen.queryByText(/Managed by/)).toBeNull();
  });

  it.each([
    ["Usage", "Usage"],
    ["Settings", "Agent settings"],
  ])("keeps Agent context visible while opening %s", async (linkName, destinationHeading) => {
    let agentReads = 0;
    let releaseAgentRead = () => {};
    const pendingAgentRead = new Promise<void>((resolve) => {
      releaseAgentRead = resolve;
    });
    installApi({
      agentRead: () => {
        agentReads += 1;
        return agentReads === 1 ? undefined : pendingAgentRead;
      },
      bound: true,
    });
    window.history.replaceState({}, "", `/agents/${agentId}`);
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Reviewer" })).toBeTruthy();
    fireEvent.click(screen.getByRole("link", { name: linkName }));

    expect(await screen.findByRole("heading", { name: destinationHeading })).toBeTruthy();
    await waitFor(() => expect(agentReads).toBe(2));
    expect(screen.queryByLabelText("Loading current server state")).toBeNull();
    await act(async () => releaseAgentRead());
  });

  it("shows confirmed active work without exposing conversation content", async () => {
    installApi({
      bound: true,
      agentActivity: { state: "working", startedAt: "2026-08-24T09:00:00.000Z" },
    });
    window.history.replaceState({}, "", `/agents/${agentId}`);
    render(<App />);

    expect((await screen.findAllByText("Working")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("Handling a request").length).toBeGreaterThan(0);
    expect(screen.getByText(/^Started /)).toBeTruthy();
    expect(document.body.textContent).not.toContain("Private conversation content");
  });

  it("groups all admin-only controls in a lightweight Settings directory", async () => {
    installApi();
    window.history.replaceState({}, "", `/agents/${agentId}/settings`);
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Agent settings" })).toBeTruthy();
    expect(screen.queryByRole("navigation", { name: "Agent settings" })).toBeNull();
    expect(await screen.findByRole("heading", { name: "How it works" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Where it receives work" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Agent details" })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Instructions & behavior/ })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Model & reasoning/ })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Messaging/ })).toBeTruthy();
    expect(screen.getByRole("link", { name: /^Name Reviewer$/ })).toBeTruthy();
    expect(screen.getByText("Connected computer")).toBeTruthy();
    expect(screen.queryByRole("link", { name: /Connected computer/ })).toBeNull();
    expect(screen.getByRole("link", { name: /Manage Agent/ })).toBeTruthy();
    expect(screen.getByText("Not configured")).toBeTruthy();
    expect(screen.getByText("Codex · Default model · Default reasoning")).toBeTruthy();
    expect(screen.getByText("Reviewer")).toBeTruthy();
    expect(screen.getByText("Ada's Mac · macOS · Online")).toBeTruthy();
    expect(screen.queryByText("Runtime")).toBeNull();
  });

  it("returns to the Agent home when Messaging was opened from its Manage shortcut", async () => {
    installApi({ bound: true });
    window.history.replaceState({}, "", `/agents/${agentId}`);
    render(<App />);

    fireEvent.click(await screen.findByRole("link", { name: "Manage" }));
    expect(await screen.findByRole("heading", { name: "Messaging" })).toBeTruthy();
    const backLink = screen.getByRole("link", { name: "Back to Reviewer" });
    expect(backLink.getAttribute("href")).toBe(`/agents/${agentId}`);
    fireEvent.click(backLink);
    expect(await screen.findByRole("heading", { name: "Reviewer" })).toBeTruthy();
  });

  it("opens Connected computer recovery only when the Computer needs attention", async () => {
    installApi({ computerStatus: () => "offline" });
    window.history.replaceState({}, "", `/agents/${agentId}/settings`);
    render(<App />);

    const computerLabel = await screen.findByText("Connected computer");
    const computerLink = computerLabel.closest("a");
    expect(screen.getByText("Ada's Mac · macOS · Offline")).toBeTruthy();
    expect(screen.getByText("Review")).toBeTruthy();
    if (!(computerLink instanceof HTMLAnchorElement)) {
      throw new Error("Expected the Connected computer recovery row to be a link");
    }
    expect(computerLink.getAttribute("href")).toBe(`/agents/${agentId}/settings/computer`);
  });

  it("edits the Agent display name without exposing its permanent handle", async () => {
    installApi();
    window.history.replaceState({}, "", `/agents/${agentId}/settings/identity`);
    render(<App />);

    const displayName = (await screen.findByLabelText("Display name")) as HTMLInputElement;
    expect(screen.getByRole("heading", { name: "Name" })).toBeTruthy();
    expect(screen.getByText("Choose the name teammates see.")).toBeTruthy();
    expect(screen.queryByLabelText("Handle")).toBeNull();
    expect(screen.queryByText(/handle cannot be changed/i)).toBeNull();
    expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull();

    fireEvent.change(displayName, { target: { value: "Research Reviewer" } });
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(displayName.value).toBe("Reviewer");
    expect(screen.queryByText("Unsaved changes")).toBeNull();
  });

  it("pauses and deletes an Agent from Manage with destructive confirmation", async () => {
    installApi();
    window.history.replaceState({}, "", `/agents/${agentId}/settings/manage`);
    render(<App />);

    const unavailableDeleteButton = await screen.findByRole("button", { name: "Delete permanently" });
    expect(unavailableDeleteButton.hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("Pause this Agent before deleting it permanently.")).toBeTruthy();
    fireEvent.click(unavailableDeleteButton);
    expect(screen.queryByRole("dialog", { name: "Delete Reviewer?" })).toBeNull();

    fireEvent.click(await screen.findByRole("button", { name: "Pause" }));
    expect(await screen.findByRole("button", { name: "Reactivate" })).toBeTruthy();
    const deleteButton = screen.getByRole("button", { name: "Delete permanently" });
    expect(deleteButton.hasAttribute("disabled")).toBe(false);
    fireEvent.click(deleteButton);
    const dialog = await screen.findByRole("dialog", { name: "Delete Reviewer?" });
    expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
    const confirmedDeleteButton = within(dialog).getByRole("button", { name: "Delete permanently" });
    expect(confirmedDeleteButton.hasAttribute("disabled")).toBe(true);
    fireEvent.change(within(dialog).getByLabelText(/Type Reviewer to confirm/), { target: { value: "Reviewer" } });
    expect(confirmedDeleteButton.hasAttribute("disabled")).toBe(false);
    fireEvent.click(confirmedDeleteButton);
    await waitFor(() => expect(window.location.pathname).toBe("/agents"));
  });

  it("keeps lifecycle failures visible inside the confirmation dialog and allows retry", async () => {
    installApi({
      agentActivity: { state: "working", startedAt: "2026-08-24T12:00:00.000Z" },
    });
    const baseFetch = vi.mocked(fetch).getMockImplementation();
    if (!baseFetch) throw new Error("Expected the test API to be installed");
    let failSuspend = true;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input) === `/api/v1/agents/${agentId}/suspend` && init?.method === "POST" && failSuspend) {
        failSuspend = false;
        return json(
          { error: { code: "SERVICE_UNAVAILABLE", category: "transient", message: "Unable to pause right now" } },
          503,
        );
      }
      return baseFetch(input, init);
    });
    window.history.replaceState({}, "", `/agents/${agentId}/settings/manage`);
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Pause" }));
    const dialog = await screen.findByRole("dialog", { name: "Pause Reviewer?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Pause Agent" }));
    expect((await within(dialog).findByRole("alert")).textContent).toContain("Unable to pause right now");

    fireEvent.click(within(dialog).getByRole("button", { name: "Pause Agent" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Pause Reviewer?" })).toBeNull());
    const reactivateButton = await screen.findByRole("button", { name: "Reactivate" });
    await waitFor(() => expect(document.activeElement).toBe(reactivateButton));
  });

  it("keeps delete failures visible inside the confirmation dialog and clears them after retry", async () => {
    installApi({ initialStatus: "suspended" });
    const baseFetch = vi.mocked(fetch).getMockImplementation();
    if (!baseFetch) throw new Error("Expected the test API to be installed");
    let failDelete = true;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input) === `/api/v1/agents/${agentId}` && init?.method === "DELETE" && failDelete) {
        failDelete = false;
        return json(
          { error: { code: "SERVICE_UNAVAILABLE", category: "transient", message: "Unable to delete right now" } },
          503,
        );
      }
      return baseFetch(input, init);
    });
    window.history.replaceState({}, "", `/agents/${agentId}/settings/manage`);
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Delete permanently" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete Reviewer?" });
    fireEvent.change(within(dialog).getByLabelText(/Type Reviewer to confirm/), { target: { value: "Reviewer" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete permanently" }));
    expect((await within(dialog).findByRole("alert")).textContent).toContain("Unable to delete right now");

    fireEvent.click(within(dialog).getByRole("button", { name: "Delete permanently" }));
    await waitFor(() => expect(window.location.pathname).toBe("/agents"));
    expect(screen.queryByText("Unable to delete right now")).toBeNull();
  });

  it("shows detailed Agent Token usage and changes the selected period", async () => {
    installApi();
    window.history.replaceState({}, "", `/agents/${agentId}/usage`);
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Usage" })).toBeTruthy();
    expect(await screen.findByRole("img", { name: /428K Tokens used during the last 30 days/ })).toBeTruthy();
    expect(screen.getByText("Tokens")).toBeTruthy();
    expect(screen.queryByText("Failed Tasks")).toBeNull();
    expect(screen.queryByText("Average per measured Task")).toBeNull();
    expect(screen.getByText("Partial data.")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe(
      "Partial data. Token data is available for 31 of 32 tasks. Token totals and charts are partial.",
    );
    expect(screen.getByRole("heading", { name: "Token usage over time" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Token breakdown" })).toBeTruthy();
    expect(screen.getAllByText(/0 Tokens$/).length).toBeGreaterThan(0);
    expect(screen.getByText("Input")).toBeTruthy();
    expect(screen.getByText("Output")).toBeTruthy();
    expect(screen.getByText("Cached input")).toBeTruthy();
    expect(screen.queryByText("Turns")).toBeNull();

    fireEvent.change(screen.getByLabelText("Usage period"), { target: { value: "7" } });
    await waitFor(() =>
      expect(
        vi.mocked(fetch).mock.calls.some(([input]) => String(input) === `/api/v1/agents/${agentId}/usage?days=7`),
      ).toBe(true),
    );
    expect(await screen.findByRole("img", { name: /428K Tokens used during the last 7 days/ })).toBeTruthy();
  });

  it("explains when no Tasks report Token usage", async () => {
    installApi({
      agentUsage: {
        tasks: 4,
        measuredTasks: 0,
        failed: 0,
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        tokens: 0,
        daily: [],
      },
    });
    window.history.replaceState({}, "", `/agents/${agentId}/usage`);
    render(<App />);

    expect((await screen.findByText("Token data unavailable.")).closest("[role='status']")?.textContent).toBe(
      "Token data unavailable. None of the 4 tasks reported token usage. Token totals and charts may be empty.",
    );
  });

  it("keeps the Usage loading skeleton aligned with the two summary metrics", async () => {
    installApi();
    const baseFetch = vi.mocked(fetch).getMockImplementation();
    let releaseUsage = () => {};
    const pendingUsage = new Promise<void>((resolve) => {
      releaseUsage = resolve;
    });
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input).startsWith(`/api/v1/agents/${agentId}/usage?`)) await pendingUsage;
      if (!baseFetch) throw new Error("Expected the base fetch implementation");
      return baseFetch(input, init);
    });
    window.history.replaceState({}, "", `/agents/${agentId}/usage`);
    render(<App />);

    const loading = await screen.findByLabelText("Loading Agent usage");
    expect(loading.children).toHaveLength(2);
    releaseUsage();
    expect(await screen.findByText("Partial data.")).toBeTruthy();
  });

  it("redirects legacy Agent URLs without keeping the old UI", async () => {
    installApi();
    window.history.replaceState({}, "", `/agents/${agentId}/runtime`);
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Model & reasoning" })).toBeTruthy();
    expect(window.location.pathname).toBe(`/agents/${agentId}/settings/execution`);
    expect(screen.queryByText("Runtime")).toBeNull();
  });

  it.each([
    ["integrations", "Agent integrations are not available here", "Browse integrations"],
    ["skills", "Agent skills are not available here", "Browse skills"],
  ])("keeps legacy Agent %s URLs inside an explicit Agent-scoped boundary", async (section, heading, action) => {
    installApi();
    window.history.replaceState({}, "", `/agents/${agentId}/${section}`);
    render(<App />);

    expect(await screen.findByRole("heading", { name: heading })).toBeTruthy();
    expect(window.location.pathname).toBe(`/agents/${agentId}/${section}`);
    expect(screen.getByText(/assigned to Reviewer.*shared catalog is separate/)).toBeTruthy();
    expect(screen.getByRole("link", { name: action }).getAttribute("href")).toBe(`/${section}`);
  });

  it("does not preserve the removed Agent Access surface", async () => {
    installApi();
    window.history.replaceState({}, "", `/agents/${agentId}/access`);
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Page not found" })).toBeTruthy();
    expect(window.location.pathname).toBe(`/agents/${agentId}/access`);
  });

  it("keeps assigned Computer details in its own Settings page", async () => {
    installApi({ bound: true });
    window.history.replaceState({}, "", `/agents/${agentId}/settings/computer`);
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Ada's Mac · macOS" })).toBeTruthy();
    expect(screen.getByText("Online")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Reviewer" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Execution" })).toBeNull();
    expect(screen.queryByText(/Turn timeout/i)).toBeNull();
    expect(screen.queryByText(/Last seen/i)).toBeNull();
  });

  it("names the machine-level recovery for an offline Computer instead of offering a dead retry", async () => {
    installApi({ bound: true, computerStatus: () => "offline" });
    window.history.replaceState({}, "", `/agents/${agentId}/settings/computer`);
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Ada's Mac · macOS" })).toBeTruthy();
    expect(screen.getByText("Offline")).toBeTruthy();
    expect(screen.getByText(/Last seen/)).toBeTruthy();
    expect(
      screen.getByText("OpenTag is not running on Ada's Mac. Start it there to bring this Computer back online."),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Check again" })).toBeNull();
  });

  it("offers machine recovery on the Connected computer page when the Computer is offline", async () => {
    installApi({ bound: true, computerStatus: () => "offline" });
    window.history.replaceState({}, "", `/agents/${agentId}/settings/computer`);
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Ada's Mac · macOS" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reconnect this Computer" })).toBeTruthy();
  });

  it("withholds machine recovery when the Computer is reachable but its Provider is not", async () => {
    installApi({
      bound: true,
      computerProviderReadiness: [{ provider: "codex", status: "install", observedAt: "2026-08-20T00:00:00.000Z" }],
    });
    window.history.replaceState({}, "", `/agents/${agentId}/settings/computer`);
    render(<App />);

    expect(await screen.findByText("Codex is not installed on Ada's Mac.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Reconnect this Computer" })).toBeNull();
  });

  it("generates a command naming the assigned Computer without leaving the Agent", async () => {
    installApi({ bound: true, computerStatus: () => "offline" });
    window.history.replaceState({}, "", `/agents/${agentId}/settings/computer`);
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Reconnect this Computer" }));

    expect(screen.getByRole("heading", { name: "Reconnect Ada's Mac" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Generate connection command" })).toBeTruthy();
    expect(window.location.pathname).toBe(`/agents/${agentId}/settings/computer`);
  });

  it("observes a Computer coming back online from the recovery page itself", async () => {
    let computerStatus: "online" | "offline" = "offline";
    installApi({ bound: true, computerStatus: () => computerStatus });
    window.history.replaceState({}, "", `/agents/${agentId}/settings/computer`);
    render(<App />);

    expect(await screen.findByText("Offline")).toBeTruthy();
    expect(
      screen.getByText("OpenTag is not running on Ada's Mac. Start it there to bring this Computer back online."),
    ).toBeTruthy();

    computerStatus = "online";
    fireEvent(window, new Event("focus"));

    expect(await screen.findByText("Online")).toBeTruthy();
    await waitFor(() => expect(screen.queryByText(/Start it there/)).toBeNull());
  });

  it("explains an unready Provider on the Computer page instead of the model settings", async () => {
    installApi({
      bound: true,
      runtimeProvider: "claude-code",
      computerProviderReadiness: [
        { provider: "codex", status: "ready", observedAt: "2026-08-20T00:00:00.000Z" },
        { provider: "claude-code", status: "sign-in", observedAt: "2026-08-20T00:00:00.000Z" },
      ],
    });
    window.history.replaceState({}, "", `/agents/${agentId}/settings/computer`);
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Ada's Mac · macOS" })).toBeTruthy();
    expect(screen.getByText("Not ready")).toBeTruthy();
    expect(screen.getByText("Claude Code is not signed in on Ada's Mac.")).toBeTruthy();
  });

  it("refreshes Agent availability when the page regains focus", async () => {
    let computerStatus: "online" | "offline" = "online";
    installApi({ bound: true, computerStatus: () => computerStatus });
    window.history.replaceState({}, "", `/agents/${agentId}`);
    render(<App />);
    expect((await screen.findAllByText("Ready")).length).toBeGreaterThan(0);

    computerStatus = "offline";
    fireEvent(window, new Event("focus"));
    expect(await screen.findByText("The assigned Computer is offline, so new requests cannot start.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "View Computer" })).toBeTruthy();
  });

  it("keeps Agent cards useful when Computer status cannot be confirmed", async () => {
    installApi({ bound: true, computerEvidenceFails: true });
    window.history.replaceState({}, "", "/agents");
    render(<App />);

    expect(await screen.findByText("Reviewer")).toBeTruthy();
    expect(screen.getByText("Unconfirmed")).toBeTruthy();
    expect(screen.getByText("Unable to confirm readiness")).toBeTruthy();
    expect(screen.queryByText("Ada's Mac · macOS")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).includes("/computers"))).toBe(true);
    expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).includes(`/agents/${agentId}/im-binding`))).toBe(
      false,
    );
  });

  it("requires the selected runtime Provider to be ready before an Agent card is Available", async () => {
    installApi({
      bound: true,
      runtimeProvider: "claude-code",
      computerProviderReadiness: [
        { provider: "codex", status: "ready", observedAt: "2026-08-20T00:00:00.000Z" },
        { provider: "claude-code", status: "sign-in", observedAt: "2026-08-20T00:00:00.000Z" },
      ],
    });
    window.history.replaceState({}, "", "/agents");
    render(<App />);

    expect(await screen.findByText("Needs attention")).toBeTruthy();
    expect(screen.getByText("Computer not ready")).toBeTruthy();
    expect(screen.getByRole("link", { name: "View Computer" }).getAttribute("href")).toBe(
      `/agents/${agentId}/settings/computer`,
    );
    expect(screen.queryByText("Available")).toBeNull();
  });

  it("shows a user-facing recovery without readiness implementation details", async () => {
    installApi({ bound: true, handoffReady: false });
    window.history.replaceState({}, "", `/agents/${agentId}`);
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Reviewer" })).toBeTruthy();
    // The detail status names the same state as the Agent list, so one failure has one name.
    expect(screen.getAllByText("Needs attention").length).toBeGreaterThan(0);
    expect(screen.queryByText("Action required")).toBeNull();
    expect(screen.getByText("Messages cannot currently be handed off to this Agent.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "View messaging" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Current work" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Where to use this Agent" })).toBeTruthy();
    expect(screen.queryByText("Handoff")).toBeNull();
    expect(screen.queryByText("Ada's Mac")).toBeNull();
    expect(screen.queryByText("Runtime")).toBeNull();
  });

  it("does not infer an empty contact when messaging evidence cannot be confirmed", async () => {
    installApi({ bound: true, bindingEvidenceFails: true });
    window.history.replaceState({}, "", `/agents/${agentId}`);
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Reviewer" })).toBeTruthy();
    expect(screen.getByText("Unable to confirm messaging")).toBeTruthy();
    expect(screen.queryByText("No messaging connected")).toBeNull();
    expect(screen.queryByText("Handoff")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("offers messaging setup only when the missing binding is confirmed", async () => {
    installApi({ bound: false });
    window.history.replaceState({}, "", `/agents/${agentId}/settings/messaging`);
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Contact channel" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "No messaging channel" })).toBeTruthy();
    expect(screen.getByText(/cannot contact this agent/)).toBeTruthy();
  });

  it("separates a connected contact channel from its trigger rules", async () => {
    installApi({ bound: true });
    window.history.replaceState({}, "", `/agents/${agentId}/settings/messaging`);
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Contact channel" })).toBeTruthy();
    expect(screen.getByText(/Feishu · Connected/)).toBeTruthy();
    expect(screen.getByText(/Validated/)).toBeTruthy();
    expect(screen.getByText("@reviewer")).toBeTruthy();
    expect(screen.getByText("Send @reviewer a direct message, or mention it in a Feishu group chat.")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Trigger rules" })).toBeTruthy();
    expect(screen.getByText("Every direct message starts a task.")).toBeTruthy();
    expect(screen.getByText("Group chats")).toBeTruthy();
    expect(screen.getByRole("group", { name: "Shared conversation trigger rule" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Change Feishu Bot" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Disconnect Feishu" })).toBeTruthy();
  });

  it("shows a Messaging error instead of inferring an empty channel", async () => {
    installApi({ bindingEvidenceFails: true });
    window.history.replaceState({}, "", `/agents/${agentId}/settings/messaging`);
    render(<App />);

    expect((await screen.findByRole("alert")).textContent).toContain("Binding evidence unavailable");
    expect(screen.queryByRole("heading", { name: "No messaging channel" })).toBeNull();
  });

  it("does not overlap focus refreshes while an Agent read is still pending", async () => {
    let agentReads = 0;
    let computerStatus: "online" | "offline" = "online";
    let releaseAgentRead = () => {};
    const pendingAgentRead = new Promise<void>((resolve) => {
      releaseAgentRead = resolve;
    });
    installApi({
      agentRead: () => {
        agentReads += 1;
        return agentReads === 1 ? undefined : pendingAgentRead;
      },
      bound: true,
      computerStatus: () => computerStatus,
    });
    window.history.replaceState({}, "", `/agents/${agentId}`);
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Reviewer" })).toBeTruthy();

    computerStatus = "offline";
    fireEvent(window, new Event("focus"));
    fireEvent(window, new Event("focus"));
    await waitFor(() => expect(agentReads).toBe(2));
    expect(agentReads).toBe(2);

    releaseAgentRead();
    expect(await screen.findByText("The assigned Computer is offline, so new requests cannot start.")).toBeTruthy();
  });

  it("invalidates a stale Agent detail after a background not-found response", async () => {
    let agentReadStatus: number | undefined;
    installApi({ agentReadStatus: () => agentReadStatus, bound: true });
    window.history.replaceState({}, "", `/agents/${agentId}`);
    render(<App />);
    expect((await screen.findAllByText("Ready")).length).toBeGreaterThan(0);

    agentReadStatus = 404;
    fireEvent(window, new Event("focus"));
    expect((await screen.findByRole("alert")).textContent).toContain("Agent unavailable");
    expect(screen.queryByText("Ready")).toBeNull();
  });

  it("marks retained Agent rows unconfirmed after a transient primary refresh failure", async () => {
    let agentListStatus: number | undefined;
    installApi({ agentListStatus: () => agentListStatus, bound: true });
    window.history.replaceState({}, "", "/agents");
    render(<App />);
    expect(await screen.findByText("Available")).toBeTruthy();

    agentListStatus = 503;
    fireEvent(window, new Event("focus"));
    expect(await screen.findByText("Unconfirmed")).toBeTruthy();
    expect(screen.getByText("Reviewer")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("changes Slack receive mode locally without opening Slack configuration", async () => {
    installApi({ bound: true, provider: "slack" });
    window.history.replaceState({}, "", `/agents/${agentId}/settings/messaging`);
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Every message" }));
    const dialog = await screen.findByRole("dialog", { name: "Allow messages without mentions?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Allow every message" }));
    await waitFor(() =>
      expect(
        vi
          .mocked(fetch)
          .mock.calls.filter(
            ([input, init]) => String(input) === `/api/v1/agents/${agentId}` && init?.method === "PATCH",
          ),
      ).toHaveLength(1),
    );
    expect(
      vi.mocked(fetch).mock.calls.filter(([input]) => String(input).includes("/im-binding/slack/configuration")),
    ).toHaveLength(0);
    await waitFor(() =>
      expect(
        vi
          .mocked(fetch)
          .mock.calls.filter(
            ([input, init]) => String(input) === `/api/v1/agents/${agentId}` && (init?.method ?? "GET") === "GET",
          ),
      ).toHaveLength(2),
    );
  });

  it("keeps receive-mode failures inside the active dialog and clears them before retry", async () => {
    installApi({ bound: true });
    const baseFetch = vi.mocked(fetch).getMockImplementation();
    if (!baseFetch) throw new Error("Expected the test API to be installed");
    let failReceiveMode = true;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input) === `/api/v1/agents/${agentId}` && init?.method === "PATCH" && failReceiveMode) {
        failReceiveMode = false;
        return json(
          {
            error: {
              code: "SERVICE_UNAVAILABLE",
              category: "transient",
              message: "Unable to update message access",
            },
          },
          503,
        );
      }
      return baseFetch(input, init);
    });
    window.history.replaceState({}, "", `/agents/${agentId}/settings/messaging`);
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Every message" }));
    const dialog = await screen.findByRole("dialog", { name: "Allow messages without mentions?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Allow every message" }));
    expect((await within(dialog).findByRole("alert")).textContent).toContain("Unable to update message access");

    fireEvent.click(within(dialog).getByRole("button", { name: "Allow every message" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Allow messages without mentions?" })).toBeNull());
    expect(screen.queryByText("Unable to update message access")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Trigger rules" })));
  });

  it("keeps disconnect failures inside the active dialog and allows retry", async () => {
    installApi({ bound: true });
    const baseFetch = vi.mocked(fetch).getMockImplementation();
    if (!baseFetch) throw new Error("Expected the test API to be installed");
    let failDisconnect = true;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input).endsWith("/disable") && init?.method === "POST") {
        if (failDisconnect) {
          failDisconnect = false;
          return json(
            {
              error: {
                code: "SERVICE_UNAVAILABLE",
                category: "transient",
                message: "Unable to disconnect messaging",
              },
            },
            503,
          );
        }
        return new Response(null, { status: 204 });
      }
      return baseFetch(input, init);
    });
    window.history.replaceState({}, "", `/agents/${agentId}/settings/messaging`);
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Disconnect Feishu" }));
    const dialog = await screen.findByRole("dialog", { name: "Disconnect messaging?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Disconnect" }));
    expect((await within(dialog).findByRole("alert")).textContent).toContain("Unable to disconnect messaging");

    fireEvent.click(within(dialog).getByRole("button", { name: "Disconnect" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Disconnect messaging?" })).toBeNull());
    expect(screen.queryByText("Unable to disconnect messaging")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Messaging" })));
  });

  it("shows the Tasks demo and opens a Task detail", async () => {
    installApi();
    window.history.replaceState({}, "", "/tasks");
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Tasks" })).toBeTruthy();
    expect(screen.getByText("Demo data")).toBeTruthy();
    const task = screen.getByRole("link", {
      name: "Review the Q3 launch plan, identify unresolved owners, and flag every item without a confirmed date.",
    });
    fireEvent.click(task);
    expect(
      await screen.findByText(
        "Eight items were checked. Five are ready, two still need owners, and one has no confirmed date.",
      ),
    ).toBeTruthy();
    expect(screen.getByLabelText("Task source").textContent).toContain("Product Launch");
    expect(window.location.pathname).toBe("/tasks/q3-launch-readiness");
  });

  it("labels a directly opened Task detail as demo data", async () => {
    installApi();
    window.history.replaceState({}, "", "/tasks/q3-launch-readiness");
    render(<App />);

    expect(
      await screen.findByText(
        "Eight items were checked. Five are ready, two still need owners, and one has no confirmed date.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Demo data")).toBeTruthy();
  });

  it.each(["/settings", "/settings/members", "/members", "/teams"])(
    "does not preserve removed Team/member settings route %s",
    async (path) => {
      installApi();
      window.history.replaceState({}, "", path);
      render(<App />);

      expect(await screen.findByRole("heading", { name: "Page not found" })).toBeTruthy();
      expect(window.location.pathname).toBe(path);
    },
  );

  it("keeps Skills and Integrations reachable from the object navigation", async () => {
    installApi();
    window.history.replaceState({}, "", "/skills");
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Skills" })).toBeTruthy();
    fireEvent.click(screen.getByRole("link", { name: "Integrations" }));
    expect(await screen.findByRole("heading", { name: "Integrations" })).toBeTruthy();
    expect(screen.getByRole("table", { name: "Demo Integrations" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Settings" })).toBeNull();
  });

  it("uses the server-ordered first membership without a browser Workspace preference", async () => {
    installApi({ multipleMemberships: true });
    window.history.replaceState({}, "", "/agents");
    const getItem = vi.spyOn(Storage.prototype, "getItem");
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Agents" })).toBeTruthy();
    expect(getItem).not.toHaveBeenCalled();
    expect(vi.mocked(fetch).mock.calls.some(([path]) => path === `/api/v1/workspaces/${workspaceId}/agents`)).toBe(
      true,
    );
    expect(
      vi.mocked(fetch).mock.calls.some(([path]) => path === `/api/v1/workspaces/${secondaryWorkspaceId}/agents`),
    ).toBe(false);
    getItem.mockRestore();
  });

  it("keeps Workspace management and switching out of the account menu", async () => {
    installApi({ multipleMemberships: true });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Account menu" }));

    expect(screen.queryByRole("group", { name: "Workspaces" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Workspace" })).toBeNull();
    expect(screen.queryByText("Secondary")).toBeNull();
    expect(screen.getByRole("menuitem", { name: "Computers" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Account" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "Admins" })).toBeNull();
  });

  it("does not create an IM setup attempt while rendering Agent detail", async () => {
    installApi();
    window.history.replaceState({}, "", `/agents/${agentId}/settings/messaging`);
    render(<App />);
    expect(await screen.findByRole("button", { name: "Connect a Feishu Bot" })).toBeTruthy();
    expect(vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
  });

  it("creates a Feishu setup attempt only after an explicit admin click", async () => {
    installApi();
    window.history.replaceState({}, "", `/agents/${agentId}/settings/messaging`);
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Connect a Feishu Bot" }));
    expect(await screen.findByText("Feishu setup started")).toBeTruthy();
    expect(await screen.findByText(/Choose an existing Feishu Bot or create a new one/)).toBeTruthy();
    expect(await screen.findByRole("img", { name: "Scan this QR code in Feishu" })).toBeTruthy();
    await waitFor(() =>
      expect(
        vi
          .mocked(fetch)
          .mock.calls.some(
            ([input, init]) => String(input).endsWith("/im-binding/feishu/setup-attempts") && init?.method === "POST",
          ),
      ).toBe(true),
    );
  });

  it("offers a legacy Feishu Bot permission update without claiming live connectivity", async () => {
    installApi({ bindingReauth: true, bound: true });
    window.history.replaceState({}, "", `/agents/${agentId}/settings/messaging`);
    render(<App />);
    expect(await screen.findByText(/Permissions update required/)).toBeTruthy();
    expect(screen.queryByText(/Online/)).toBeNull();
    expect(screen.getByRole("button", { name: "Reauthorize Feishu" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Change Feishu Bot" }));
    expect(await screen.findByText(/Choose an existing Feishu Bot or create a new one/)).toBeTruthy();
    const request = vi
      .mocked(fetch)
      .mock.calls.find(
        ([input, init]) => String(input).endsWith("/im-binding/feishu/setup-attempts") && init?.method === "POST",
      );
    expect(JSON.parse(String(request?.[1]?.body))).toEqual({ intent: "replace" });
  });

  it("describes an active binding as needing attention when handoff is unavailable", async () => {
    installApi({ bound: true, handoffReady: false });
    window.history.replaceState({}, "", `/agents/${agentId}/settings/messaging`);
    render(<App />);

    expect((await screen.findByText(/Needs attention/)).closest(".ds-status")).toBeTruthy();
    expect(screen.queryByText(/Online/)).toBeNull();
  });

  it("shows a safe occupied-App recovery and retries the original replacement intent", async () => {
    installApi({ bound: true, setupFailureCode: "FEISHU_APP_ALREADY_BOUND" });
    window.history.replaceState({}, "", `/agents/${agentId}/settings/messaging`);
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Change Feishu Bot" }));
    const setupNotice = (await screen.findByText("Feishu setup started")).parentElement;
    expect(setupNotice?.textContent).toContain(
      "This Feishu Bot is already connected to another Agent. Choose a different Bot or disable its current binding first.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry Feishu setup" }));
    await waitFor(() => {
      const requests = vi
        .mocked(fetch)
        .mock.calls.filter(
          ([input, init]) => String(input).endsWith("/im-binding/feishu/setup-attempts") && init?.method === "POST",
        );
      expect(requests).toHaveLength(2);
      expect(requests.map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
        { intent: "replace" },
        { intent: "replace" },
      ]);
    });
  });

  it("opens a stateless customer-owned Slack App configuration from the Agent IM tab", async () => {
    installApi();
    window.history.replaceState({}, "", `/agents/${agentId}/settings/messaging`);
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Connect Slack App" }));

    expect(await screen.findByRole("link", { name: /Create a Slack App from the complete manifest/ })).toBeTruthy();
    expect(screen.getByLabelText("Slack App ID")).toBeTruthy();
    expect(screen.getByLabelText("Bot User OAuth Token")).toBeTruthy();
    expect(screen.getByLabelText("Signing Secret")).toBeTruthy();
    expect(screen.getAllByText(/files:read/)).toHaveLength(2);
    const requests = vi
      .mocked(fetch)
      .mock.calls.filter(([input]) => String(input).endsWith("/im-binding/slack/configuration"));
    expect(requests).toHaveLength(1);
    expect(requests[0]?.[1]?.method ?? "GET").toBe("GET");
  });

  it("creates a Computer connection command only after an explicit admin click", async () => {
    installApi({ computers: [] });
    window.history.replaceState({}, "", "/agents/new");
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Connect a Local Computer" })).toBeTruthy();
    expect(window.location.pathname).toBe("/agents/new");
    const button = await screen.findByRole("button", { name: "Generate connection command" });
    expect(vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
    fireEvent.click(button);
    expect(
      await screen.findByText(/opentag computer connect --server https:\/\/opentag\.example\.com -- example/),
    ).toBeTruthy();
  });

  it("guides Agent creation to Computer setup when none is connected", async () => {
    installApi({ computers: [] });
    window.history.replaceState({}, "", "/agents/new");
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Connect a Local Computer" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Generate connection command" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Agent runtime" })).toBeNull();
  });

  it("validates Agent name locally with an accessible field error before sending a request", async () => {
    installApi();
    window.history.replaceState({}, "", "/agents/new");
    render(<App />);
    await screen.findByLabelText("Display name");
    fireEvent.click(screen.getByRole("button", { name: "Edit Agent name" }));
    const name = screen.getByLabelText("Agent name");
    fireEvent.change(name, { target: { value: "Bestony" } });
    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Bestony" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Agent" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(
      "Agent name must start with a lowercase letter or number and contain only lowercase letters, numbers, and hyphens",
    );
    expect(name.getAttribute("aria-invalid")).toBe("true");
    expect(name.getAttribute("aria-describedby")?.split(" ")).toContain(alert.id);
    expect(
      vi
        .mocked(fetch)
        .mock.calls.filter(
          ([input, init]) => String(input) === `/api/v1/workspaces/${workspaceId}/agents` && init?.method === "POST",
        ),
    ).toHaveLength(0);
  });

  it("asks for an explicit Agent name when the display name cannot produce an ASCII name", async () => {
    installApi();
    window.history.replaceState({}, "", "/agents/new");
    render(<App />);
    fireEvent.change(await screen.findByLabelText("Display name"), { target: { value: "研究助手" } });
    expect(screen.getByRole("button", { name: "Edit Agent name" }).textContent).toBe("Set Agent name");
    expect(screen.queryByLabelText("Agent name")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Create Agent" }));

    const alert = await screen.findByRole("alert");
    const name = screen.getByLabelText("Agent name");
    expect(alert.textContent).toBe("Agent name is required");
    await waitFor(() => expect(name).toBe(document.activeElement));
    expect(
      vi
        .mocked(fetch)
        .mock.calls.filter(
          ([input, init]) => String(input) === `/api/v1/workspaces/${workspaceId}/agents` && init?.method === "POST",
        ),
    ).toHaveLength(0);
  });

  it("creates an Agent with a valid canonical name and keeps the existing payload", async () => {
    installApi();
    window.history.replaceState({}, "", "/agents/new");
    render(<App />);
    fireEvent.change(await screen.findByLabelText("Display name"), { target: { value: "Bestony" } });
    expect(screen.queryByLabelText("Agent name")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Create Agent" }));
    expect(await screen.findByRole("heading", { name: "Connect messaging" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Set up later" }));
    await waitFor(() => expect(window.location.pathname).toBe(`/agents/${agentId}`));
    const createCall = vi
      .mocked(fetch)
      .mock.calls.find(
        ([input, init]) => String(input) === `/api/v1/workspaces/${workspaceId}/agents` && init?.method === "POST",
      );
    expect(JSON.parse(String(createCall?.[1]?.body))).toEqual({
      creationIntentId: expect.any(String),
      name: "bestony",
      displayName: "Bestony",
      runtimeProvider: "codex",
      computerId,
    });
  });

  it("maps a Server name issue back to the Agent name field", async () => {
    installApi({ agentCreateError: "name" });
    window.history.replaceState({}, "", "/agents/new");
    render(<App />);
    fireEvent.change(await screen.findByLabelText("Display name"), { target: { value: "Bestony" } });
    expect(screen.queryByLabelText("Agent name")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Create Agent" }));
    const alert = await screen.findByRole("alert");
    const name = screen.getByLabelText("Agent name");
    expect(alert.textContent).toBe("Use a lowercase Agent name");
    expect(name.getAttribute("aria-describedby")?.split(" ")).toContain(alert.id);
    await waitFor(() => expect(name).toBe(document.activeElement));
    expect(window.location.pathname).toBe("/agents/new");
  });

  it("reveals the Agent name editor when the Server reports a Workspace name conflict", async () => {
    installApi({ agentCreateError: "conflict" });
    window.history.replaceState({}, "", "/agents/new");
    render(<App />);
    fireEvent.change(await screen.findByLabelText("Display name"), { target: { value: "Bestony" } });
    expect(screen.queryByLabelText("Agent name")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Create Agent" }));

    const alert = await screen.findByRole("alert");
    const name = screen.getByLabelText("Agent name");
    expect(alert.textContent).toBe("An active Agent with this name already exists in the Workspace");
    expect(name.getAttribute("aria-invalid")).toBe("true");
    await waitFor(() => expect(name).toBe(document.activeElement));
  });

  it("keeps an unmapped Server validation error at form level", async () => {
    installApi({ agentCreateError: "generic" });
    window.history.replaceState({}, "", "/agents/new");
    render(<App />);
    fireEvent.change(await screen.findByLabelText("Display name"), { target: { value: "Bestony" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Agent" }));
    expect((await screen.findByRole("alert")).textContent).toBe("The request payload is invalid");
    expect(screen.queryByLabelText("Agent name")).toBeNull();
  });

  it("uses only a confirmed ready Computer and Provider route", async () => {
    installApi({
      computers: [
        {
          id: computerId,
          displayName: "Ada's Mac",
          platform: "darwin",
          arch: "arm64",
          clientVersion: "0.0.1",
          connectionStatus: "online",
          providerReadiness: [
            { provider: "codex", status: "ready", observedAt: "2026-08-20T00:00:00.000Z" },
            { provider: "claude-code", status: "sign-in", observedAt: "2026-08-20T00:00:00.000Z" },
          ],
          connectedAt: "2026-08-20T00:00:00.000Z",
          lastSeenAt: "2026-08-20T00:00:00.000Z",
        },
      ],
    });
    window.history.replaceState({}, "", "/agents/new");
    render(<App />);
    expect(await screen.findByText("Ada's Mac")).toBeTruthy();
    expect(screen.getByText("Codex")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Change Runtime" }));
    const claudeCode = screen.getByRole("button", { name: /Claude Code Sign-in required/ });
    expect(claudeCode.hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Create Agent" }).hasAttribute("disabled")).toBe(false);
    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Codex Reviewer" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Agent" }));
    await waitFor(() => {
      const request = vi
        .mocked(fetch)
        .mock.calls.find(
          ([path, init]) => path === `/api/v1/workspaces/${workspaceId}/agents` && init?.method === "POST",
        );
      expect(JSON.parse(String(request?.[1]?.body))).toEqual({
        creationIntentId: expect.any(String),
        name: "codex-reviewer",
        displayName: "Codex Reviewer",
        runtimeProvider: "codex",
        computerId,
      });
    });
  });

  it("revalidates ready routes and disables creation when readiness becomes unavailable", async () => {
    const claudeReadiness: {
      observedAt: string;
      provider: "claude-code";
      status: "ready" | "unavailable";
    } = {
      provider: "claude-code",
      status: "unavailable",
      observedAt: "2026-08-20T00:00:00.000Z",
    };
    let computerReadStatus: number | undefined;
    installApi({
      computers: [
        {
          id: computerId,
          displayName: "Ada's Mac",
          platform: "darwin",
          arch: "arm64",
          clientVersion: "0.0.1",
          connectionStatus: "online",
          providerReadiness: [
            { provider: "codex", status: "ready", observedAt: "2026-08-20T00:00:00.000Z" },
            claudeReadiness,
          ],
          connectedAt: "2026-08-20T00:00:00.000Z",
          lastSeenAt: "2026-08-20T00:00:00.000Z",
        },
      ],
      computerReadStatus: () => computerReadStatus,
    });
    window.history.replaceState({}, "", "/agents");
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "New Agent" }));
    const dialog = await screen.findByRole("dialog", { name: "New Agent" });
    await within(dialog).findByText("Ada's Mac");
    expect(within(dialog).getByText("Codex")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Change Runtime" }));
    expect(
      within(dialog)
        .getByRole("button", { name: /Claude Code Unavailable/ })
        .hasAttribute("disabled"),
    ).toBe(true);

    claudeReadiness.status = "ready";
    window.dispatchEvent(new Event("focus"));
    fireEvent.click(await within(dialog).findByRole("button", { name: /Claude Code Ready/ }));
    expect(await within(dialog).findByText("Claude Code")).toBeTruthy();

    claudeReadiness.status = "unavailable";
    window.dispatchEvent(new Event("focus"));
    expect(await within(dialog).findByText("Codex")).toBeTruthy();

    computerReadStatus = 503;
    window.dispatchEvent(new Event("focus"));
    expect(await within(dialog).findByText("Readiness unconfirmed")).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Create Agent" }).hasAttribute("disabled")).toBe(true);
  });

  it("removes a retained creation route after a terminal Computer refresh error", async () => {
    let computerReadStatus: number | undefined;
    installApi({ computerReadStatus: () => computerReadStatus });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "New Agent" }));
    const dialog = await screen.findByRole("dialog", { name: "New Agent" });
    expect(await within(dialog).findByText("Ready to run")).toBeTruthy();

    computerReadStatus = 404;
    window.dispatchEvent(new Event("focus"));

    expect((await within(dialog).findByRole("alert")).textContent).toContain("Request failed");
    expect(within(dialog).queryByRole("button", { name: "Create Agent" })).toBeNull();
  });

  it("keeps an unprovisioned authenticated account read-only while the server finishes setup", async () => {
    installApi({ workspaceless: true });
    render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
    expect(await screen.findByRole("heading", { name: "OpenTag is not ready for this account" })).toBeTruthy();
    expect(window.location.pathname).toBe("/agents");
    expect(screen.getByRole("status").textContent).toContain("Retry after provisioning finishes");
    expect(screen.getByText(/contact an operator/)).toBeTruthy();
    expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
    const initialMeReads = vi.mocked(fetch).mock.calls.filter(([path]) => path === "/api/v1/me").length;
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() =>
      expect(vi.mocked(fetch).mock.calls.filter(([path]) => path === "/api/v1/me")).toHaveLength(initialMeReads + 1),
    );
    expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  });

  it("keeps standalone onboarding behind the read-only Workspace setup gate", async () => {
    installApi({ workspaceless: true });
    window.history.replaceState({}, "", "/onboarding");
    render(<App />);
    expect(await screen.findByRole("heading", { name: "OpenTag is not ready for this account" })).toBeTruthy();
    expect(window.location.pathname).toBe("/onboarding");
    expect(
      vi.mocked(fetch).mock.calls.some(([path, init]) => path === "/api/v1/workspaces" && init?.method === "POST"),
    ).toBe(false);
  });

  it("routes an admin with incomplete Workspace setup into onboarding", async () => {
    installApi({ setupCompletedAt: null });
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Set up OpenTag" })).toBeTruthy();
    expect(window.location.pathname).toBe("/onboarding");
  });

  it("keeps completed Workspaces out of onboarding even when it is requested directly", async () => {
    installApi();
    window.history.replaceState({}, "", "/onboarding");
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Agents" })).toBeTruthy();
    expect(window.location.pathname).toBe("/agents");
  });

  it("does not preserve the retired self-serve Workspace creation route", async () => {
    installApi();
    window.history.replaceState({}, "", "/workspaces/new");
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Page not found" })).toBeTruthy();
    expect(
      vi.mocked(fetch).mock.calls.some(([path, init]) => path === "/api/v1/workspaces" && init?.method === "POST"),
    ).toBe(false);
  });

  it("keeps account controls personal and signs out from the account menu", async () => {
    installApi();
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Account menu" }));
    expect(screen.queryByRole("group", { name: "Workspaces" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Workspace management" })).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "Account" }));
    expect(await screen.findByRole("heading", { name: "Account" })).toBeTruthy();
    expect(window.location.pathname).toBe("/account");
    const displayName = screen.getByLabelText("Display name") as HTMLInputElement;
    expect(displayName.readOnly).toBe(false);
    fireEvent.change(displayName, { target: { value: "Account Menu" } });
    expect(await screen.findByRole("button", { name: "Save account profile" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Account menu" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Sign out" }));
    expect(await screen.findByRole("heading", { name: "Welcome back" })).toBeTruthy();
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      "/api/v1/auth/browser/logout",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("opens the Computers page from the account menu", async () => {
    installApi();
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Account menu" }));
    const computers = screen.getByRole("menuitem", { name: "Computers" });
    expect(computers.getAttribute("href")).toBe("/agents/computers");
    fireEvent.click(computers);
    expect(await screen.findByRole("heading", { level: 1, name: "Computers" })).toBeTruthy();
    expect(window.location.pathname).toBe("/agents/computers");
    expect(screen.queryByRole("menu", { name: "Account" })).toBeNull();
  });

  it("moves focus into account actions and returns it to the trigger on Escape", async () => {
    installApi({ multipleMemberships: true });
    render(<App />);
    const trigger = await screen.findByRole("button", { name: "Account menu" });
    fireEvent.click(trigger);
    const computers = screen.getByRole("menuitem", { name: "Computers" });
    expect(document.activeElement).toBe(computers);
    fireEvent.keyDown(computers, { key: "Escape" });
    expect(screen.queryByRole("menu", { name: "Account" })).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("supports arrow-key navigation and focus return in the account menu", async () => {
    installApi();
    render(<App />);
    const trigger = await screen.findByRole("button", { name: "Account menu" });
    fireEvent.click(trigger);
    const computers = screen.getByRole("menuitem", { name: "Computers" });
    const account = screen.getByRole("menuitem", { name: "Account" });
    const signOut = screen.getByRole("menuitem", { name: "Sign out" });
    expect(document.activeElement).toBe(computers);
    fireEvent.keyDown(computers, { key: "ArrowDown" });
    expect(document.activeElement).toBe(account);
    fireEvent.keyDown(account, { key: "ArrowDown" });
    expect(document.activeElement).toBe(signOut);
    fireEvent.keyDown(signOut, { key: "ArrowDown" });
    expect(document.activeElement).toBe(computers);
    fireEvent.keyDown(computers, { key: "End" });
    expect(document.activeElement).toBe(signOut);
    fireEvent.keyDown(signOut, { key: "Escape" });
    expect(screen.queryByRole("menu", { name: "Account" })).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("removes the old admin product shell without a redirect", async () => {
    window.history.replaceState({}, "", "/admin");
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Page not found" })).toBeTruthy();
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});
