import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../app.js";

const teamId = "d3fda800-7ce2-4338-aae8-3d2120401ed6";
const invitedTeamId = "3928e3dc-99b0-4a79-97c8-bf9c26b91add";
const userId = "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e";
const memberUserId = "63e2babe-e4ac-4e2c-b7d1-d092d5a4568e";
const otherMemberUserId = "73e2babe-e4ac-4e2c-b7d1-d092d5a4568e";
const agentId = "1a63a21e-f6c7-4474-91ea-4dabf0566a24";
const computerId = "85fe9af3-d1c6-472b-b78c-8a7ccf512750";
const createdTeamId = "6b1f0c9a-2d4e-4a77-9c31-8f0c5b2ad741";
const invitationToken = "A".repeat(43);

const agentSummary = {
  id: agentId,
  teamId,
  name: "reviewer",
  displayName: "Reviewer",
  manager: { userId, displayName: "Ada" },
  computer: { id: computerId, displayName: "Ada's Mac", platform: "darwin" },
  runtimeProvider: "codex",
  receiveMode: "mention_only",
  status: "active",
  createdAt: "2026-08-20T00:00:00.000Z",
  updatedAt: "2026-08-20T00:00:00.000Z",
};

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function installApi(
  role: "admin" | "member",
  options: {
    agentRead?: () => Promise<void> | void;
    agentReadStatus?: () => number | undefined;
    agentListStatus?: () => number | undefined;
    agentCreate?: (input: Record<string, unknown>) => Promise<void> | void;
    alreadyJoinedInvitation?: boolean;
    bindingReauth?: boolean;
    bindingEvidenceFails?: boolean;
    bound?: boolean;
    computers?: readonly Record<string, unknown>[];
    computerEvidenceFails?: boolean;
    computerStatus?: () => "online" | "offline";
    ownComputerReadStatus?: () => number | undefined;
    handoffReady?: boolean;
    initialStatus?: "active" | "suspended";
    invitationCreate?: () => Promise<Response> | Response;
    invitationExists?: boolean;
    invitationRotate?: () => Promise<Response> | Response;
    ownComputer?: boolean;
    provider?: "feishu" | "slack";
    profileUpdate?: (displayName: string) => Promise<Response> | Response;
    profileUpdateFails?: boolean;
    redeemFails?: boolean;
    roleUpdate?: (targetUserId: string, role: "admin" | "member") => Promise<Response> | Response;
    roleUpdateFails?: boolean;
    setupFailureCode?: string;
    scopeReauth?: boolean;
    unauthenticated?: boolean;
    teamless?: boolean;
    teamNameConflict?: boolean;
    teamNameConflicts?: number;
  } = {},
) {
  const teamProfile = { name: "example", displayName: "Example" };
  let lifecycleStatus = options.initialStatus ?? "active";
  let revision = lifecycleStatus === "active" ? 1 : 2;
  const adminConfig = () => ({
    id: agentId,
    teamId,
    name: agentSummary.name,
    displayName: agentSummary.displayName,
    runtimeProvider: agentSummary.runtimeProvider,
    receiveMode: agentSummary.receiveMode,
    status: lifecycleStatus,
    createdAt: agentSummary.createdAt,
    updatedAt: agentSummary.updatedAt,
    managerUserId: userId,
    computerId,
    revision,
    runtimeConfig: {
      revision: 1,
      model: null,
      reasoningEffort: null,
      instructions: "",
      allowedTools: [],
      maxDurationMs: null,
    },
  });
  const createdMemberships: { teamId: string; teamName: string; teamDisplayName: string; role: "admin" }[] = [];
  let currentRole = role;
  let currentDisplayName = "Ada";
  let memberRole: "admin" | "member" = "member";
  let otherMemberRole: "admin" | "member" = "member";
  let invitationExists = options.invitationExists ?? false;
  let invitationVersion: "A" | "B" | "C" = "A";
  let joinedInvitation = options.alreadyJoinedInvitation ?? false;
  let teamNameConflicts = options.teamNameConflicts ?? (options.teamNameConflict ? 1 : 0);
  const invitation = () => ({
    token: invitationVersion.repeat(43),
    inviteUrl: `https://opentag.example.com/invites/${invitationVersion.repeat(43)}`,
    role: "member" as const,
    expiresAt: "2026-08-27T00:00:00.000Z",
  });
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    const path = String(input);
    if (path === "/api/v1/auth/providers") {
      return json({ providers: [{ id: "dev", enabled: true, startUrl: "/api/v1/auth/dev/callback" }] });
    }
    if (path === "/api/v1/me" && init?.method === "PATCH") {
      const body = JSON.parse(String(init.body)) as { displayName: string };
      const response = options.profileUpdate
        ? await options.profileUpdate(body.displayName)
        : options.profileUpdateFails
          ? json({ error: { message: "Display name update failed" } }, 409)
          : json({ id: userId, email: "ada@example.com", displayName: body.displayName.trim() });
      if (response.ok) currentDisplayName = body.displayName.trim();
      return response;
    }
    if (path === "/api/v1/me") {
      if (options.unauthenticated) return json({ error: { message: "Sign in required" } }, 401);
      const existing = options.teamless
        ? []
        : [{ teamId, teamName: teamProfile.name, teamDisplayName: teamProfile.displayName, role: currentRole }];
      return json({
        user: { id: userId, email: "ada@example.com", displayName: currentDisplayName },
        memberships: [
          ...existing,
          ...(joinedInvitation
            ? [
                {
                  teamId: invitedTeamId,
                  teamName: "invited-team",
                  teamDisplayName: "Invited Team",
                  role: "member" as const,
                },
              ]
            : []),
          ...createdMemberships,
        ],
      });
    }
    if (path === "/api/v1/teams" && init?.method === "POST") {
      if (teamNameConflicts > 0) {
        teamNameConflicts -= 1;
        return json(
          {
            error: {
              code: "TEAM_NAME_CONFLICT",
              category: "deterministic",
              message: "Another Team already uses this canonical name",
            },
          },
          409,
        );
      }
      const body = JSON.parse(String(init.body)) as { displayName: string; name: string };
      createdMemberships.push({
        teamId: createdTeamId,
        teamName: body.name,
        teamDisplayName: body.displayName,
        role: "admin",
      });
      return json(
        {
          id: createdTeamId,
          name: body.name,
          displayName: body.displayName,
          role: "admin",
          createdAt: "2026-08-20T00:00:00.000Z",
          updatedAt: "2026-08-20T00:00:00.000Z",
        },
        201,
      );
    }
    if (path === `/api/v1/teams/${teamId}` && init?.method === "PATCH") {
      const body = JSON.parse(String(init.body)) as { displayName?: string; name?: string };
      if (body.name !== undefined) teamProfile.name = body.name.trim().toLowerCase();
      if (body.displayName !== undefined) teamProfile.displayName = body.displayName.trim();
      return json({
        id: teamId,
        name: teamProfile.name,
        displayName: teamProfile.displayName,
        updatedAt: "2026-08-20T00:01:00.000Z",
      });
    }
    if (/^\/api\/v1\/teams\/[^/]+\/agents$/.test(path) && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      await options.agentCreate?.(body);
      return json(adminConfig(), 201);
    }
    // Any Team id, so a Team created during the test is served like the seeded and invited ones.
    if (/^\/api\/v1\/teams\/[^/]+\/agents$/.test(path) && init?.method === undefined) {
      const failureStatus = options.agentListStatus?.();
      if (failureStatus) return json({ error: { message: "Agent list unavailable" } }, failureStatus);
      return json({
        agents: [
          path.includes(invitedTeamId)
            ? { ...agentSummary, teamId: invitedTeamId, status: lifecycleStatus }
            : { ...agentSummary, status: lifecycleStatus },
        ],
      });
    }
    if (path === `/api/v1/teams/${teamId}/members`) {
      return json({
        members: [
          { userId, displayName: currentDisplayName, role: currentRole },
          { userId: memberUserId, displayName: "Grace", role: memberRole },
          { userId: otherMemberUserId, displayName: "Lin", role: otherMemberRole },
        ],
      });
    }
    if (path.startsWith(`/api/v1/teams/${teamId}/members/`) && init?.method === "PATCH") {
      const targetUserId = path.slice(path.lastIndexOf("/") + 1);
      const body = JSON.parse(String(init.body)) as { role: "admin" | "member" };
      const response = options.roleUpdate
        ? await options.roleUpdate(targetUserId, body.role)
        : options.roleUpdateFails
          ? json({ error: { message: "The last active Team admin cannot be demoted" } }, 409)
          : json({
              teamId,
              userId: targetUserId,
              email:
                targetUserId === userId
                  ? "ada@example.com"
                  : targetUserId === memberUserId
                    ? "grace@example.com"
                    : "lin@example.com",
              displayName: targetUserId === userId ? "Ada" : targetUserId === memberUserId ? "Grace" : "Lin",
              role: body.role,
              status: "active",
              createdAt: "2026-08-20T00:00:00.000Z",
              updatedAt: "2026-08-20T00:01:00.000Z",
            });
      if (!response.ok) return response;
      if (targetUserId === userId) currentRole = body.role;
      if (targetUserId === memberUserId) memberRole = body.role;
      if (targetUserId === otherMemberUserId) otherMemberRole = body.role;
      return response;
    }
    if (path === `/api/v1/teams/${teamId}/invitation` && init?.method === undefined) {
      return invitationExists ? json(invitation()) : new Response(null, { status: 204 });
    }
    if (path === `/api/v1/teams/${teamId}/invitation` && init?.method === "POST") {
      if (options.invitationCreate) {
        const response = await options.invitationCreate();
        if (response.ok) invitationExists = true;
        return response;
      }
      invitationExists = true;
      return json(invitation(), 201);
    }
    if (path === `/api/v1/teams/${teamId}/invitation/rotate` && init?.method === "POST") {
      if (options.invitationRotate) {
        const response = await options.invitationRotate();
        if (response.ok) invitationVersion = "B";
        return response;
      }
      invitationVersion = "B";
      return json(invitation());
    }
    if (path === `/api/v1/invitations/${invitationToken}/preview`) {
      return json({ teamDisplayName: "Invited Team", role: "member", expiresAt: "2026-08-27T00:00:00.000Z" });
    }
    if (path === `/api/v1/invitations/${invitationToken}/redeem` && init?.method === "POST") {
      if (options.unauthenticated) return json({ error: { message: "Sign in required" } }, 401);
      if (options.redeemFails) return json({ error: { message: "The invitation is invalid or expired" } }, 404);
      joinedInvitation = true;
      return json({
        membership: {
          teamId: invitedTeamId,
          teamName: "invited-team",
          teamDisplayName: "Invited Team",
          role: "member",
        },
      });
    }
    if (/^\/api\/v1\/teams\/[^/]+\/computers$/.test(path)) {
      if (options.computerEvidenceFails) return json({ error: { message: "Computer evidence unavailable" } }, 503);
      return json({
        computers: [
          {
            id: computerId,
            ownerUserId: userId,
            ownerDisplayName: "Ada",
            displayName: "Ada's Mac",
            platform: "darwin",
            connectionStatus: options.computerStatus?.() ?? "online",
            connectedAt: "2026-08-20T00:00:00.000Z",
            lastSeenAt: "2026-08-20T00:00:00.000Z",
            observedAt: "2026-08-20T00:00:00.000Z",
            agentIds: [agentId],
          },
        ],
      });
    }
    if (path === "/api/v1/me/computers") {
      const failureStatus = options.ownComputerReadStatus?.();
      if (failureStatus) return json({ error: { message: "Computer readiness unavailable" } }, failureStatus);
      return json({
        computers:
          options.computers ??
          (options.ownComputer
            ? [
                {
                  id: computerId,
                  ownerUserId: userId,
                  displayName: "Ada's Mac",
                  platform: "darwin",
                  arch: "arm64",
                  clientVersion: "0.0.1",
                  connectionStatus: "online",
                  connectedAt: "2026-08-20T00:00:00.000Z",
                  lastSeenAt: "2026-08-20T00:00:01.000Z",
                },
              ]
            : []),
      });
    }
    if (path === "/api/v1/me/connect-codes" && init?.method === "POST") {
      return json(
        {
          bootstrapCommand: "npm i -g @opentag/cli && opentag login --server https://opentag.example.com -- example",
          expiresIn: 900,
          issuedAt: "2026-08-20T00:00:00.000Z",
        },
        201,
      );
    }
    if (path === `/api/v1/agents/${agentId}`) {
      if (init?.method === "PATCH" && options.scopeReauth) {
        return json(
          {
            error: {
              code: "IM_BINDING_SCOPE_REAUTH_REQUIRED",
              category: "deterministic",
              message: "Additional IM scopes are required",
            },
          },
          409,
        );
      }
      if (init?.method === "PATCH") return json(adminConfig());
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      await options.agentRead?.();
      const failureStatus = options.agentReadStatus?.();
      if (failureStatus) return json({ error: { message: "Agent unavailable" } }, failureStatus);
      return json({
        ...agentSummary,
        status: lifecycleStatus,
        viewerCapabilities: { canManage: currentRole === "admin" },
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
      if (options.bindingEvidenceFails) return json({ error: { message: "Handoff evidence unavailable" } }, 503);
      if (!options.bound) return new Response(null, { status: 204 });
      const bindingState = options.bindingReauth ? "reauthorization_required" : "active";
      return json({ bindingState, handoffReady: options.handoffReady ?? bindingState === "active" });
    }
    if (path === `/api/v1/agents/${agentId}/im-binding`) {
      if (options.bindingEvidenceFails) return json({ error: { message: "Binding evidence unavailable" } }, 503);
      if (!options.bound) return new Response(null, { status: 204 });
      return json({
        id: crypto.randomUUID(),
        agentId,
        provider: options.provider ?? "feishu",
        bindingState: options.bindingReauth ? "reauthorization_required" : "active",
        bot: { displayName: "Reviewer", avatarUrl: null },
        receiveMode: "mention_only",
        lastInboundAt: null,
        lastOutboundAt: null,
        lastConfirmedAt: "2026-08-20T00:00:00.000Z",
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
    if (path === "/api/v1/auth/browser/logout" && init?.method === "POST") return new Response(null, { status: 204 });
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${path}`);
  });
  return {
    setInvitationVersion(value: "A" | "B" | "C") {
      invitationVersion = value;
    },
  };
}

describe("OpenTag Web App Shell", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    window.history.replaceState({}, "", "/agents");
  });

  it("uses the same Agents-first shell for admins", async () => {
    installApi("admin");
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Agents" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Agents" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Settings" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "New Agent" })).toBeTruthy();
    expect(screen.getByText("Tasks").getAttribute("aria-disabled")).toBe("true");
    const workspaceNavigation = screen.getByRole("navigation", { name: "Workspace" });
    expect(
      within(workspaceNavigation)
        .getAllByText(/Agents|Tasks|Settings/)
        .map((item) => item.textContent),
    ).toEqual(["Agents", "Tasks", "Settings"]);
    const navigationIcons = workspaceNavigation.querySelectorAll(".primary-nav-icon");
    expect(navigationIcons).toHaveLength(3);
    expect(Array.from(navigationIcons).every((icon) => icon.getAttribute("aria-hidden") === "true")).toBe(true);
  });

  it.each(["/", "/agents"])("redirects unauthenticated protected path %s to login", async (path) => {
    installApi("member", { unauthenticated: true });
    window.history.replaceState({}, "", path);
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeTruthy();
    const expectedNext = path === "/" ? "/agents" : path;
    expect(window.location.search).toBe(`?next=${encodeURIComponent(expectedNext)}`);
  });

  it("lets members enter the same shell without admin controls", async () => {
    installApi("member");
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Agents" })).toBeTruthy();
    expect(screen.queryByText("ada@example.com")).toBeNull();
    expect(await screen.findByText("Reviewer")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "New Agent" })).toBeNull();
  });

  it("opens the complete New Agent form in a dialog and returns focus when cancelled", async () => {
    installApi("admin", { ownComputer: true });
    render(<App />);
    const trigger = await screen.findByRole("button", { name: "New Agent" });

    fireEvent.click(trigger);

    const dialog = await screen.findByRole("dialog", { name: "New Agent" });
    expect(window.location.pathname).toBe("/agents");
    await waitFor(() => expect(within(dialog).getByLabelText("Display name")).toBe(document.activeElement));
    expect(within(dialog).getByLabelText("Agent name")).toBeTruthy();
    expect(within(dialog).getByLabelText("Provider")).toBeTruthy();
    expect(within(dialog).getByLabelText("Computer")).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Create Agent" })).toBeTruthy();

    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog", { name: "New Agent" })).toBeNull();
    expect(trigger).toBe(document.activeElement);
  });

  it("creates an Agent from the dialog without a second creation screen", async () => {
    installApi("admin", { ownComputer: true });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "New Agent" }));
    const dialog = await screen.findByRole("dialog", { name: "New Agent" });

    fireEvent.change(within(dialog).getByLabelText("Display name"), { target: { value: "Research Assistant" } });
    fireEvent.change(within(dialog).getByLabelText("Agent name"), { target: { value: "research-assistant" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create Agent" }));

    await waitFor(() => expect(window.location.pathname).toBe(`/agents/${agentId}/general`));
    const createCall = vi
      .mocked(fetch)
      .mock.calls.find(
        ([input, init]) => String(input) === `/api/v1/teams/${teamId}/agents` && init?.method === "POST",
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
    installApi("admin", { ownComputer: true, agentCreate: () => pendingCreate });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "New Agent" }));
    const dialog = await screen.findByRole("dialog", { name: "New Agent" });
    fireEvent.change(within(dialog).getByLabelText("Display name"), { target: { value: "Research Assistant" } });
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
            ([input, init]) => String(input) === `/api/v1/teams/${teamId}/agents` && init?.method === "POST",
          ),
      ).toHaveLength(1),
    );
    await waitFor(() => expect(dialog).toBe(document.activeElement));
    expect((within(dialog).getByLabelText("Display name") as HTMLInputElement).disabled).toBe(true);
    expect((within(dialog).getByLabelText("Agent name") as HTMLInputElement).disabled).toBe(true);
    expect((within(dialog).getByLabelText("Provider") as HTMLSelectElement).disabled).toBe(true);
    expect((within(dialog).getByLabelText("Computer") as HTMLSelectElement).disabled).toBe(true);
    expect(within(dialog).getByRole("button", { name: "Creating…" }).hasAttribute("disabled")).toBe(true);
    expect(within(dialog).getByRole("button", { name: "Cancel" }).hasAttribute("disabled")).toBe(true);
    expect(within(dialog).getByRole("button", { name: "Close new Agent dialog" }).hasAttribute("disabled")).toBe(true);
    fireEvent.keyDown(document.activeElement ?? dialog, { key: "Escape" });
    expect(screen.getByRole("dialog", { name: "New Agent" })).toBe(dialog);

    resolveCreate();
    await waitFor(() => expect(window.location.pathname).toBe(`/agents/${agentId}/general`));
  });

  it("reuses one creation intent when an unchanged Agent request is retried", async () => {
    const attempts: Record<string, unknown>[] = [];
    installApi("admin", {
      ownComputer: true,
      agentCreate: (input) => {
        attempts.push(input);
        if (attempts.length === 1) throw new Error("Connection lost after creation");
      },
    });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "New Agent" }));
    const dialog = await screen.findByRole("dialog", { name: "New Agent" });
    fireEvent.change(within(dialog).getByLabelText("Display name"), { target: { value: "Research Assistant" } });
    fireEvent.change(within(dialog).getByLabelText("Agent name"), { target: { value: "research-assistant" } });

    fireEvent.click(within(dialog).getByRole("button", { name: "Create Agent" }));
    expect((await within(dialog).findByRole("alert")).textContent).toContain("Connection lost after creation");
    fireEvent.click(within(dialog).getByRole("button", { name: "Create Agent" }));

    await waitFor(() => expect(window.location.pathname).toBe(`/agents/${agentId}/general`));
    expect(attempts).toHaveLength(2);
    expect(attempts[0]?.creationIntentId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(attempts[1]?.creationIntentId).toBe(attempts[0]?.creationIntentId);
  });

  it.each(["admin", "member"] as const)("lets a %s update their global account display name", async (role) => {
    installApi(role);
    window.history.replaceState({}, "", "/account");
    render(<App />);

    const email = (await screen.findByLabelText("Email")) as HTMLInputElement;
    const displayName = screen.getByLabelText("Display name") as HTMLInputElement;
    expect(email.value).toBe("ada@example.com");
    expect(email.readOnly).toBe(true);
    fireEvent.change(displayName, { target: { value: "  Ada Lovelace  " } });
    fireEvent.click(screen.getByRole("button", { name: "Save account profile" }));

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
    installApi("member", { profileUpdate: () => update });
    window.history.replaceState({}, "", "/account");
    render(<App />);

    const displayName = (await screen.findByLabelText("Display name")) as HTMLInputElement;
    const form = displayName.closest("form");
    if (!form) throw new Error("Account form was not rendered");
    fireEvent.change(displayName, { target: { value: "Pending Name" } });
    fireEvent.submit(form);
    fireEvent.submit(form);

    expect(((await screen.findByRole("button", { name: "Saving…" })) as HTMLButtonElement).disabled).toBe(true);
    expect(
      vi.mocked(fetch).mock.calls.filter(([input, init]) => String(input) === "/api/v1/me" && init?.method === "PATCH"),
    ).toHaveLength(1);
    resolveUpdate(json({ id: userId, email: "ada@example.com", displayName: "Pending Name" }));
    await waitFor(() => expect(screen.getByText("Pending Name")).toBeTruthy());
  });

  it("restores the confirmed server name and shows the error when an account update fails", async () => {
    installApi("member", { profileUpdateFails: true });
    window.history.replaceState({}, "", "/account");
    render(<App />);

    const displayName = (await screen.findByLabelText("Display name")) as HTMLInputElement;
    fireEvent.change(displayName, { target: { value: "Rejected Name" } });
    fireEvent.click(screen.getByRole("button", { name: "Save account profile" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Display name update failed");
    expect(displayName.value).toBe("Ada");
    expect(screen.getByText("Ada")).toBeTruthy();
  });

  it("keeps account profile editing out of the merged Team page", async () => {
    installApi("admin");
    window.history.replaceState({}, "", "/settings/team");
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Team members" })).toBeTruthy();
    expect(screen.getAllByLabelText("Display name")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Save account profile" })).toBeNull();
  });

  it("keeps suspended lifecycle visible but read-only for members", async () => {
    installApi("member", { initialStatus: "suspended" });
    window.history.replaceState({}, "", `/agents/${agentId}/general`);
    render(<App />);
    expect(await screen.findByText("Suspended")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Reactivate Agent" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete Agent permanently" })).toBeNull();
  });

  it("requires suspension and destructive confirmation before an admin deletes an Agent", async () => {
    installApi("admin");
    window.history.replaceState({}, "", `/agents/${agentId}/general`);
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit Agent settings" }));
    fireEvent.click(await screen.findByRole("button", { name: "Suspend Agent" }));
    await waitFor(() =>
      expect(
        vi
          .mocked(fetch)
          .mock.calls.filter(
            ([input, init]) => String(input) === `/api/v1/agents/${agentId}` && (init?.method ?? "GET") === "GET",
          ),
      ).toHaveLength(2),
    );
    expect(await screen.findByText("Agent is suspended")).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Reactivate Agent" })).toBeTruthy();
    const deleteButton = await screen.findByRole("button", { name: "Delete Agent permanently" });
    fireEvent.click(deleteButton);
    expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
    fireEvent.click(deleteButton);
    await waitFor(() => expect(window.location.pathname).toBe("/agents"));
    expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(true);
    expect(confirm).toHaveBeenLastCalledWith(
      expect.stringMatching(/end its active Sessions.*IM credential.*runtime configuration/),
    );
    confirm.mockRestore();
  });

  it("uses a flat local navigation for Agent detail", async () => {
    installApi("admin");
    window.history.replaceState({}, "", `/agents/${agentId}/general`);
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Reviewer" })).toBeTruthy();
    const navigation = screen.getByRole("navigation", { name: "Agent settings" });
    expect(
      within(navigation)
        .getAllByRole("link")
        .map((link) => link.textContent),
    ).toEqual(["Overview", "Runtime", "IM", "Resources", "Integrations", "Access"]);
  });

  it("refreshes Agent availability when the page regains focus", async () => {
    let computerStatus: "online" | "offline" = "online";
    installApi("admin", { bound: true, computerStatus: () => computerStatus });
    window.history.replaceState({}, "", `/agents/${agentId}/general`);
    render(<App />);
    expect((await screen.findAllByText("Ready")).length).toBeGreaterThan(0);

    computerStatus = "offline";
    fireEvent(window, new Event("focus"));
    expect(await screen.findByText("Computer is offline")).toBeTruthy();
  });

  it("keeps the Agent list bounded to Team-level evidence", async () => {
    installApi("admin", { bound: true, computerEvidenceFails: true });
    window.history.replaceState({}, "", "/agents");
    render(<App />);

    expect(await screen.findByText("Reviewer")).toBeTruthy();
    expect(screen.getByText("Unconfirmed")).toBeTruthy();
    expect(screen.getByText("Unable to confirm Computer")).toBeTruthy();
    expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).includes(`/agents/${agentId}/im-binding`))).toBe(
      false,
    );
  });

  it("reports one combined handoff dependency without inventing component causes", async () => {
    installApi("admin", { bound: true, handoffReady: false });
    window.history.replaceState({}, "", `/agents/${agentId}/general`);
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Reviewer" })).toBeTruthy();
    const handoffCard = screen.getByText("Handoff").closest("article");
    expect(handoffCard).toBeTruthy();
    expect(within(handoffCard as HTMLElement).getByText("Needs attention")).toBeTruthy();
    expect(within(handoffCard as HTMLElement).getByText("Handoff needs attention")).toBeTruthy();
    expect(screen.queryByText("Runtime capability unavailable")).toBeNull();
  });

  it("preserves the Agent detail when handoff evidence cannot be confirmed", async () => {
    installApi("admin", { bound: true, bindingEvidenceFails: true });
    window.history.replaceState({}, "", `/agents/${agentId}/general`);
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Reviewer" })).toBeTruthy();
    expect((await screen.findAllByText("Unable to confirm handoff")).length).toBeGreaterThan(0);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("does not overlap focus refreshes while an Agent read is still pending", async () => {
    let agentReads = 0;
    let computerStatus: "online" | "offline" = "online";
    let releaseAgentRead = () => {};
    const pendingAgentRead = new Promise<void>((resolve) => {
      releaseAgentRead = resolve;
    });
    installApi("admin", {
      agentRead: () => {
        agentReads += 1;
        return agentReads === 1 ? undefined : pendingAgentRead;
      },
      bound: true,
      computerStatus: () => computerStatus,
    });
    window.history.replaceState({}, "", `/agents/${agentId}/general`);
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Reviewer" })).toBeTruthy();

    computerStatus = "offline";
    fireEvent(window, new Event("focus"));
    fireEvent(window, new Event("focus"));
    await waitFor(() => expect(agentReads).toBe(2));
    expect(agentReads).toBe(2);

    releaseAgentRead();
    expect(await screen.findByText("Computer is offline")).toBeTruthy();
  });

  it("invalidates a stale Agent detail after a background not-found response", async () => {
    let agentReadStatus: number | undefined;
    installApi("admin", { agentReadStatus: () => agentReadStatus, bound: true });
    window.history.replaceState({}, "", `/agents/${agentId}/general`);
    render(<App />);
    expect((await screen.findAllByText("Ready")).length).toBeGreaterThan(0);

    agentReadStatus = 404;
    fireEvent(window, new Event("focus"));
    expect((await screen.findByRole("alert")).textContent).toContain("Agent unavailable");
    expect(screen.queryByText("Ready")).toBeNull();
  });

  it("marks retained Agent rows unconfirmed after a transient primary refresh failure", async () => {
    let agentListStatus: number | undefined;
    installApi("admin", { agentListStatus: () => agentListStatus });
    window.history.replaceState({}, "", "/agents");
    render(<App />);
    expect(await screen.findByText("Computer online")).toBeTruthy();

    agentListStatus = 503;
    fireEvent(window, new Event("focus"));
    expect(await screen.findByText("Unconfirmed")).toBeTruthy();
    expect(screen.getByText("Reviewer")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("refreshes the parent Agent projection after an IM mutation", async () => {
    installApi("admin", { bound: true });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    window.history.replaceState({}, "", `/agents/${agentId}/im`);
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Enable all messages" }));
    await waitFor(() =>
      expect(
        vi
          .mocked(fetch)
          .mock.calls.filter(
            ([input, init]) => String(input) === `/api/v1/agents/${agentId}` && (init?.method ?? "GET") === "GET",
          ),
      ).toHaveLength(2),
    );
    confirm.mockRestore();
  });

  it("uses a flat local navigation for Settings", async () => {
    installApi("admin");
    window.history.replaceState({}, "", "/settings/team");
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Settings" })).toBeTruthy();
    const navigation = screen.getByRole("navigation", { name: "Settings" });
    expect(
      within(navigation)
        .getAllByRole("link")
        .map((link) => link.textContent),
    ).toEqual(["Team", "Computers", "Resources", "Integrations", "Access", "Usage", "Security"]);
    expect(navigation.querySelector(".local-nav-group-label")).toBeNull();
    const mobileNavigation = screen.getByLabelText("Settings section");
    expect(Array.from(mobileNavigation.querySelectorAll("option"), (option) => option.textContent)).toEqual([
      "Team",
      "Computers",
      "Resources",
      "Integrations",
      "Access",
      "Usage",
      "Security",
    ]);
    expect(mobileNavigation.querySelector("optgroup")).toBeNull();
  });

  it("opens Settings on Team and keeps account scope out of the Settings shell", async () => {
    installApi("admin");
    window.history.replaceState({}, "", "/settings");
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Team" })).toBeTruthy();
    expect(window.location.pathname).toBe("/settings/team");
    expect(screen.getByText("Manage the current Team's identity, infrastructure, access, and security.")).toBeTruthy();
    expect(
      within(screen.getByRole("navigation", { name: "Settings" })).queryByRole("link", { name: "Account" }),
    ).toBeNull();
  });

  it("combines Team profile, members, and invitations in task order", async () => {
    installApi("admin");
    window.history.replaceState({}, "", "/settings/team");
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Team members" })).toBeTruthy();
    const teamSettings = document.querySelector<HTMLElement>(".settings-team-stack");
    if (!teamSettings) throw new Error("Merged Team settings were not rendered");
    expect(
      within(teamSettings)
        .getAllByRole("heading", { level: 2 })
        .map((heading) => heading.textContent),
    ).toEqual(["Team profile", "Team members", "Invite people"]);
  });

  it("redirects the legacy Members URL to the merged Team page", async () => {
    installApi("member");
    window.history.replaceState({}, "", "/settings/members");
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Team members" })).toBeTruthy();
    expect(window.location.pathname).toBe("/settings/team");
    expect(window.location.hash).toBe("#members");
  });

  it("redirects the legacy Settings account URL to the editable Account page", async () => {
    installApi("member");
    window.history.replaceState({}, "", "/settings/account");
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Account" })).toBeTruthy();
    expect(window.location.pathname).toBe("/account");
    const displayName = screen.getByLabelText("Display name") as HTMLInputElement;
    expect(displayName.readOnly).toBe(false);
    fireEvent.change(displayName, { target: { value: "Legacy Account" } });
    expect(screen.getByRole("button", { name: "Save account profile" })).toBeTruthy();
  });

  it("keeps unavailable Team capabilities explicit instead of inventing records", async () => {
    installApi("admin");
    window.history.replaceState({}, "", "/settings/resources");
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Team Resources are not enabled" })).toBeTruthy();
    expect(screen.getByText("This page does not create or infer Team Resource records.")).toBeTruthy();
    expect(screen.getByText("No Resource assignment projection is exposed by the current API.")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Review Agent resources" })).toBeNull();
    fireEvent.click(screen.getByRole("link", { name: "Integrations" }));
    expect(await screen.findByRole("heading", { name: "Team Integrations are not enabled" })).toBeTruthy();
    expect(
      screen.getByText("Open an Agent's IM tab to review its current Feishu or Slack connection state."),
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open Agents" })).toBeTruthy();
    fireEvent.click(screen.getByRole("link", { name: "Usage" }));
    expect(await screen.findByRole("heading", { name: "Usage reporting is not enabled" })).toBeTruthy();
  });

  it("shows the server-returned membership without inventing a capability matrix", async () => {
    installApi("admin");
    window.history.replaceState({}, "", "/settings/access");
    render(<App />);

    expect(await screen.findByText("Server-returned membership")).toBeTruthy();
    expect(screen.getByText("Your role: Admin")).toBeTruthy();
    expect(screen.getByText("The current API does not publish a complete Team capability matrix.")).toBeTruthy();
    expect(screen.getByText("Not exposed by the API")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("lets admins rename a Team and refreshes the UUID-selected Team context from /me", async () => {
    installApi("admin");
    window.localStorage.setItem("opentag.selectedTeamId", teamId);
    window.history.replaceState({}, "", "/settings/team");
    render(<App />);
    const name = await screen.findByLabelText("Canonical name");
    const displayName = screen.getByLabelText("Display name");
    fireEvent.change(name, { target: { value: "RENAMED-TEAM" } });
    fireEvent.change(displayName, { target: { value: "Renamed Team" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Team profile" }));
    await waitFor(() =>
      expect(vi.mocked(fetch).mock.calls.filter(([input]) => String(input) === "/api/v1/me")).toHaveLength(2),
    );
    expect(await screen.findByDisplayValue("renamed-team")).toBeTruthy();
    expect((screen.getByLabelText("Display name") as HTMLInputElement).value).toBe("Renamed Team");
    expect(window.localStorage.getItem("opentag.selectedTeamId")).toBe(teamId);
  });

  it("keeps Team profile fields read-only for members", async () => {
    installApi("member");
    window.history.replaceState({}, "", "/settings/team");
    render(<App />);
    expect(await screen.findByText("example")).toBeTruthy();
    expect(screen.getByText("Display name").parentElement?.querySelector("dd")?.textContent).toBe("Example");
    expect(screen.queryByRole("button", { name: "Save Team profile" })).toBeNull();
    expect(screen.queryByLabelText("Canonical name")).toBeNull();
  });

  it("accepts an invitation and selects the newly joined Team", async () => {
    installApi("admin");
    window.history.replaceState({}, "", `/invites/${invitationToken}`);
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Join Team" }));
    expect(await screen.findByRole("heading", { name: "Agents" })).toBeTruthy();
    expect(window.localStorage.getItem("opentag.selectedTeamId")).toBe(invitedTeamId);
    expect(window.sessionStorage.getItem("opentag.pendingInvitationToken")).toBeNull();
    expect(screen.getByRole("button", { name: "Invited Team" }).getAttribute("aria-expanded")).toBe("false");
  });

  it("resumes a pending invitation after sign-in without requiring a second click", async () => {
    installApi("admin");
    window.sessionStorage.setItem("opentag.pendingInvitationToken", invitationToken);
    window.history.replaceState({}, "", `/invites/${invitationToken}`);
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Agents" })).toBeTruthy();
    expect(window.localStorage.getItem("opentag.selectedTeamId")).toBe(invitedTeamId);
  });

  it("uses a server-selected Team after OAuth without replaying an invalidated invitation", async () => {
    installApi("admin", { alreadyJoinedInvitation: true, redeemFails: true });
    window.sessionStorage.setItem("opentag.pendingInvitationToken", invitationToken);
    window.history.replaceState({}, "", `/invites/${invitationToken}?joinedTeamId=${invitedTeamId}`);
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Agents" })).toBeTruthy();
    expect(window.localStorage.getItem("opentag.selectedTeamId")).toBe(invitedTeamId);
    expect(vi.mocked(fetch)).not.toHaveBeenCalledWith(
      `/api/v1/invitations/${invitationToken}/redeem`,
      expect.anything(),
    );
  });

  it("preserves the pending invitation while redirecting an unauthenticated join to sign-in", async () => {
    installApi("member", { unauthenticated: true });
    window.history.replaceState({}, "", `/invites/${invitationToken}`);
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Join Team" }));
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeTruthy();
    expect(window.location.search).toBe(`?next=${encodeURIComponent(`/invites/${invitationToken}`)}`);
    expect(window.sessionStorage.getItem("opentag.pendingInvitationToken")).toBe(invitationToken);
  });

  it("lets Team admins create, copy, and rotate the invitation link", async () => {
    installApi("admin");
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, "clipboard", { configurable: true, value: { writeText } });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    window.history.replaceState({}, "", "/settings/team");
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Create invitation link" }));
    const link = (await screen.findByLabelText("Invitation link")) as HTMLInputElement;
    expect(link.value).toBe(`https://opentag.example.com/invites/${"A".repeat(43)}`);
    fireEvent.click(screen.getByRole("button", { name: "Copy invitation link" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith((link as HTMLInputElement).value));
    fireEvent.click(screen.getByRole("button", { name: "Rotate invitation link" }));
    await waitFor(() => expect(link.value).toBe(`https://opentag.example.com/invites/${"B".repeat(43)}`));
    expect(confirm).toHaveBeenCalledOnce();
    confirm.mockRestore();
  });

  it("opens invitation-link management directly from the Team picker", async () => {
    installApi("admin", { invitationExists: true });
    render(<App />);
    const teamTrigger = await screen.findByRole("button", { name: "Example" });
    fireEvent.click(teamTrigger);
    const teamPicker = screen.getByRole("dialog", { name: "Switch Team" });
    fireEvent.click(within(teamPicker).getByRole("button", { name: "Invite people" }));

    const invitationDialog = await screen.findByRole("dialog", { name: "Invite people" });
    expect(screen.queryByRole("dialog", { name: "Switch Team" })).toBeNull();
    expect((within(invitationDialog).getByLabelText("Invitation link") as HTMLInputElement).value).toBe(
      `https://opentag.example.com/invites/${"A".repeat(43)}`,
    );
    const closeButton = within(invitationDialog).getByRole("button", { name: "Close invitation dialog" });
    expect(document.activeElement).toBe(closeButton);
    fireEvent.keyDown(closeButton, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Invite people" })).toBeNull();
    expect(document.activeElement).toBe(teamTrigger);
  });

  it("keeps the Members invitation panel in sync after rotating from the Team-picker dialog", async () => {
    installApi("admin", { invitationExists: true });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, "clipboard", { configurable: true, value: { writeText } });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    window.history.replaceState({}, "", "/settings/team");
    render(<App />);

    const pageLink = (await screen.findByLabelText("Invitation link")) as HTMLInputElement;
    expect(pageLink.value).toContain("/invites/AAA");
    fireEvent.click(screen.getByRole("button", { name: "Example" }));
    fireEvent.click(
      within(screen.getByRole("dialog", { name: "Switch Team" })).getByRole("button", { name: "Invite people" }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Invite people" });
    expect(screen.getAllByLabelText("Invitation link")).toHaveLength(1);
    fireEvent.click(within(dialog).getByRole("button", { name: "Rotate invitation link" }));
    await waitFor(() =>
      expect((within(dialog).getByLabelText("Invitation link") as HTMLInputElement).value).toContain("/invites/BBB"),
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Close invitation dialog" }));

    const refreshedPageLink = (await screen.findByLabelText("Invitation link")) as HTMLInputElement;
    expect(refreshedPageLink.value).toContain("/invites/BBB");
    fireEvent.click(screen.getByRole("button", { name: "Copy invitation link" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(refreshedPageLink.value));
    confirm.mockRestore();
  });

  it("prevents switching invitation surfaces while a rotation is pending", async () => {
    let resolveRotate: (response: Response) => void = () => undefined;
    const pendingRotate = new Promise<Response>((resolve) => {
      resolveRotate = resolve;
    });
    installApi("admin", { invitationExists: true, invitationRotate: () => pendingRotate });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    window.history.replaceState({}, "", "/settings/team");
    render(<App />);

    await screen.findByLabelText("Invitation link");
    fireEvent.click(screen.getByRole("button", { name: "Rotate invitation link" }));
    fireEvent.click(screen.getByRole("button", { name: "Example" }));
    const teamPicker = screen.getByRole("dialog", { name: "Switch Team" });
    const inviteAction = within(teamPicker).getByRole("button", { name: "Invite people" }) as HTMLButtonElement;
    expect(inviteAction.disabled).toBe(true);
    fireEvent.click(inviteAction);
    expect(screen.queryByRole("dialog", { name: "Invite people" })).toBeNull();

    resolveRotate(
      json({
        token: "B".repeat(43),
        inviteUrl: `https://opentag.example.com/invites/${"B".repeat(43)}`,
        role: "member",
        expiresAt: "2026-08-27T00:00:00.000Z",
      }),
    );
    await waitFor(() => expect(inviteAction.disabled).toBe(false));
    fireEvent.click(inviteAction);
    const dialog = await screen.findByRole("dialog", { name: "Invite people" });
    await waitFor(() =>
      expect((within(dialog).getByLabelText("Invitation link") as HTMLInputElement).value).toContain("/invites/BBB"),
    );
    confirm.mockRestore();
  });

  it("keeps focus inside the invitation dialog while a rotation is pending", async () => {
    let resolveRotate: (response: Response) => void = () => undefined;
    const pendingRotate = new Promise<Response>((resolve) => {
      resolveRotate = resolve;
    });
    installApi("admin", { invitationExists: true, invitationRotate: () => pendingRotate });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<App />);

    const teamTrigger = await screen.findByRole("button", { name: "Example" });
    fireEvent.click(teamTrigger);
    fireEvent.click(
      within(screen.getByRole("dialog", { name: "Switch Team" })).getByRole("button", { name: "Invite people" }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Invite people" });
    fireEvent.click(await within(dialog).findByRole("button", { name: "Rotate invitation link" }));

    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(teamTrigger);
    fireEvent.keyDown(document.activeElement ?? dialog, { key: "Escape" });
    expect(screen.getByRole("dialog", { name: "Invite people" })).toBe(dialog);

    resolveRotate(
      json({
        token: "B".repeat(43),
        inviteUrl: `https://opentag.example.com/invites/${"B".repeat(43)}`,
        role: "member",
        expiresAt: "2026-08-27T00:00:00.000Z",
      }),
    );
    await waitFor(() =>
      expect(
        (within(dialog).getByRole("button", { name: "Close invitation dialog" }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    confirm.mockRestore();
  });

  it("uses the dialog card as the focus fallback while invitation creation is pending", async () => {
    let resolveCreate: (response: Response) => void = () => undefined;
    const pendingCreate = new Promise<Response>((resolve) => {
      resolveCreate = resolve;
    });
    installApi("admin", { invitationCreate: () => pendingCreate });
    render(<App />);

    const teamTrigger = await screen.findByRole("button", { name: "Example" });
    fireEvent.click(teamTrigger);
    fireEvent.click(
      within(screen.getByRole("dialog", { name: "Switch Team" })).getByRole("button", { name: "Invite people" }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Invite people" });
    fireEvent.click(await within(dialog).findByRole("button", { name: "Create invitation link" }));

    teamTrigger.focus();
    fireEvent.keyDown(teamTrigger, { key: "Tab" });
    expect(document.activeElement).toBe(dialog);
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.getByRole("dialog", { name: "Invite people" })).toBe(dialog);

    resolveCreate(
      json(
        {
          token: "A".repeat(43),
          inviteUrl: `https://opentag.example.com/invites/${"A".repeat(43)}`,
          role: "member",
          expiresAt: "2026-08-27T00:00:00.000Z",
        },
        201,
      ),
    );
    expect(await within(dialog).findByLabelText("Invitation link")).toBeTruthy();
    await waitFor(() => {
      expect(dialog.contains(document.activeElement)).toBe(true);
      expect(document.activeElement).not.toBe(dialog);
    });

    dialog.focus();
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(teamTrigger);
  });

  it("replaces a locally rotated invitation with a newer successful server read", async () => {
    const api = installApi("admin", { invitationExists: true });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    window.history.replaceState({}, "", "/settings/team");
    render(<App />);

    expect(((await screen.findByLabelText("Invitation link")) as HTMLInputElement).value).toContain("/invites/AAA");
    fireEvent.click(screen.getByRole("button", { name: "Rotate invitation link" }));
    await waitFor(() =>
      expect((screen.getByLabelText("Invitation link") as HTMLInputElement).value).toContain("/invites/BBB"),
    );

    api.setInvitationVersion("C");
    fireEvent.click(screen.getByRole("link", { name: "Agents" }));
    expect(await screen.findByRole("heading", { name: "Agents" })).toBeTruthy();
    fireEvent.click(screen.getByRole("link", { name: "Settings" }));
    expect(await screen.findByRole("heading", { name: "Team members" })).toBeTruthy();

    await waitFor(() =>
      expect((screen.getByLabelText("Invitation link") as HTMLInputElement).value).toContain("/invites/CCC"),
    );
    confirm.mockRestore();
  });

  it("does not expose the Team-picker invitation shortcut to regular members", async () => {
    installApi("member");
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Example" }));
    const teamPicker = screen.getByRole("dialog", { name: "Switch Team" });
    expect(within(teamPicker).queryByRole("button", { name: "Invite people" })).toBeNull();
  });

  it("keeps invitation-link management hidden from regular members", async () => {
    installApi("member");
    window.history.replaceState({}, "", "/settings/team");
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Team members" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Invite people" })).toBeNull();
    expect(screen.queryByLabelText("Role for Ada")).toBeNull();
    expect(await screen.findAllByText("member")).toHaveLength(3);
  });

  it("lets Team admins update another member role from the member list", async () => {
    installApi("admin");
    window.history.replaceState({}, "", "/settings/team");
    render(<App />);
    const role = (await screen.findByLabelText("Role for Grace")) as HTMLSelectElement;
    fireEvent.change(role, { target: { value: "admin" } });
    await waitFor(() => expect((screen.getByLabelText("Role for Grace") as HTMLSelectElement).value).toBe("admin"));
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      `/api/v1/teams/${teamId}/members/${memberUserId}`,
      expect.objectContaining({ method: "PATCH", body: JSON.stringify({ role: "admin" }) }),
    );
  });

  it("tracks overlapping role updates per member and prevents duplicate submissions", async () => {
    let resolveGrace: (response: Response) => void = () => undefined;
    let resolveLin: (response: Response) => void = () => undefined;
    const graceUpdate = new Promise<Response>((resolve) => {
      resolveGrace = resolve;
    });
    const linUpdate = new Promise<Response>((resolve) => {
      resolveLin = resolve;
    });
    installApi("admin", {
      roleUpdate: (targetUserId) => (targetUserId === memberUserId ? graceUpdate : linUpdate),
    });
    window.history.replaceState({}, "", "/settings/team");
    render(<App />);
    const graceRole = (await screen.findByLabelText("Role for Grace")) as HTMLSelectElement;
    const linRole = screen.getByLabelText("Role for Lin") as HTMLSelectElement;

    fireEvent.change(graceRole, { target: { value: "admin" } });
    fireEvent.change(linRole, { target: { value: "admin" } });
    fireEvent.change(graceRole, { target: { value: "admin" } });

    await waitFor(() => {
      expect((screen.getByLabelText("Role for Grace") as HTMLSelectElement).disabled).toBe(true);
      expect((screen.getByLabelText("Role for Lin") as HTMLSelectElement).disabled).toBe(true);
    });
    expect(
      vi
        .mocked(fetch)
        .mock.calls.filter(
          ([input, init]) => String(input).endsWith(`/members/${memberUserId}`) && init?.method === "PATCH",
        ),
    ).toHaveLength(1);

    resolveGrace(
      json({
        teamId,
        userId: memberUserId,
        email: "grace@example.com",
        displayName: "Grace",
        role: "admin",
        status: "active",
        createdAt: "2026-08-20T00:00:00.000Z",
        updatedAt: "2026-08-20T00:01:00.000Z",
      }),
    );
    await waitFor(() => {
      expect((screen.getByLabelText("Role for Grace") as HTMLSelectElement).disabled).toBe(false);
      expect((screen.getByLabelText("Role for Lin") as HTMLSelectElement).disabled).toBe(true);
    });

    resolveLin(
      json({
        teamId,
        userId: otherMemberUserId,
        email: "lin@example.com",
        displayName: "Lin",
        role: "admin",
        status: "active",
        createdAt: "2026-08-20T00:00:00.000Z",
        updatedAt: "2026-08-20T00:01:00.000Z",
      }),
    );
    await waitFor(() => expect((screen.getByLabelText("Role for Lin") as HTMLSelectElement).disabled).toBe(false));
  });

  it("refreshes current membership authority after an admin demotes themself", async () => {
    installApi("admin");
    window.history.replaceState({}, "", "/settings/team");
    render(<App />);
    fireEvent.change(await screen.findByLabelText("Role for Ada"), { target: { value: "member" } });
    await waitFor(() =>
      expect(vi.mocked(fetch).mock.calls.filter(([input]) => String(input) === "/api/v1/me")).toHaveLength(2),
    );
    fireEvent.click(screen.getByRole("button", { name: "Example" }));
    expect(await screen.findByText("Member")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Invite people" })).toBeNull();
    expect(screen.queryByLabelText("Role for Ada")).toBeNull();
  });

  it("keeps the confirmed role and displays the server error when an update is rejected", async () => {
    installApi("admin", { roleUpdateFails: true });
    window.history.replaceState({}, "", "/settings/team");
    render(<App />);
    const role = (await screen.findByLabelText("Role for Ada")) as HTMLSelectElement;
    fireEvent.change(role, { target: { value: "member" } });
    expect((await screen.findByRole("alert")).textContent).toBe("The last active Team admin cannot be demoted");
    expect(role.value).toBe("admin");
  });

  it("does not create an IM setup attempt while rendering Agent detail", async () => {
    installApi("admin");
    window.history.replaceState({}, "", `/agents/${agentId}/im`);
    render(<App />);
    expect(await screen.findByRole("button", { name: "Connect existing or new Feishu Bot" })).toBeTruthy();
    expect(vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
  });

  it("creates a Feishu setup attempt only after an explicit admin click", async () => {
    installApi("admin");
    window.history.replaceState({}, "", `/agents/${agentId}/im`);
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Connect existing or new Feishu Bot" }));
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
    installApi("admin", { bindingReauth: true, bound: true });
    window.history.replaceState({}, "", `/agents/${agentId}/im`);
    render(<App />);
    expect(await screen.findByText("Permissions update required")).toBeTruthy();
    expect(screen.queryByText(/Online/)).toBeNull();
    expect(screen.getByRole("button", { name: "Reauthorize Feishu" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Replace with existing or new Feishu Bot" }));
    expect(await screen.findByText(/Choose an existing Feishu Bot or create a new one/)).toBeTruthy();
    const request = vi
      .mocked(fetch)
      .mock.calls.find(
        ([input, init]) => String(input).endsWith("/im-binding/feishu/setup-attempts") && init?.method === "POST",
      );
    expect(JSON.parse(String(request?.[1]?.body))).toEqual({ intent: "replace" });
  });

  it("describes an active binding as configured when handoff is unavailable", async () => {
    installApi("admin", { bound: true, handoffReady: false });
    window.history.replaceState({}, "", `/agents/${agentId}/im`);
    render(<App />);

    expect(await screen.findByText("Configured")).toBeTruthy();
    expect(screen.queryByText(/Online/)).toBeNull();
  });

  it("shows a safe occupied-App recovery and retries the original replacement intent", async () => {
    installApi("admin", { bound: true, setupFailureCode: "FEISHU_APP_ALREADY_BOUND" });
    window.history.replaceState({}, "", `/agents/${agentId}/im`);
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Replace with existing or new Feishu Bot" }));
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

  it.each([
    ["feishu", "Reauthorize Feishu"],
    ["slack", "Slack reauthorization is not available in this release."],
  ] as const)("offers provider-correct recovery when %s needs additional scopes", async (provider, recovery) => {
    installApi("admin", { bound: true, provider, scopeReauth: true });
    window.history.replaceState({}, "", `/agents/${agentId}/im`);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Enable all messages" }));
    expect(await screen.findByText("Additional IM scopes are required")).toBeTruthy();
    expect(await screen.findByText(recovery)).toBeTruthy();
    if (provider === "slack") expect(screen.queryByRole("button", { name: "Reauthorize Feishu" })).toBeNull();
    confirm.mockRestore();
  });

  it("creates a Computer connection command only after an explicit admin click", async () => {
    installApi("admin");
    window.history.replaceState({}, "", "/settings/computers");
    render(<App />);
    const button = await screen.findByRole("button", { name: "Generate connection command" });
    expect(vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
    fireEvent.click(button);
    expect(await screen.findByText(/opentag login --server https:\/\/opentag\.example\.com -- example/)).toBeTruthy();
  });

  it("guides Agent creation to Computer setup when none is connected", async () => {
    installApi("admin");
    window.history.replaceState({}, "", "/agents/new");
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Connect a Local Computer first" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Computer settings" }).getAttribute("href")).toBe("/settings/computers");
  });

  it("shows exact Computer and Provider readiness without blocking Agent creation or offering fallback", async () => {
    installApi("admin", {
      computers: [
        {
          id: computerId,
          ownerUserId: userId,
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
    expect(await screen.findByText("Codex is ready on Ada's Mac.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Provider"), { target: { value: "claude-code" } });
    expect(await screen.findByText(/Claude Code requires sign-in/)).toBeTruthy();
    expect(screen.getByText(/No other Provider will be substituted/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create Agent" }).hasAttribute("disabled")).toBe(false);
    fireEvent.change(screen.getByLabelText("Agent name"), { target: { value: "claude-reviewer" } });
    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Claude Reviewer" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Agent" }));
    await waitFor(() => {
      const request = vi
        .mocked(fetch)
        .mock.calls.find(([path, init]) => path === `/api/v1/teams/${teamId}/agents` && init?.method === "POST");
      expect(JSON.parse(String(request?.[1]?.body))).toEqual({
        creationIntentId: expect.any(String),
        name: "claude-reviewer",
        displayName: "Claude Reviewer",
        runtimeProvider: "claude-code",
        computerId,
      });
    });
  });

  it("revalidates Agent creation readiness while preserving Provider and Computer selections", async () => {
    const claudeReadiness: {
      observedAt: string;
      provider: "claude-code";
      status: "ready" | "unavailable";
    } = {
      provider: "claude-code",
      status: "unavailable",
      observedAt: "2026-08-20T00:00:00.000Z",
    };
    let ownComputerReadStatus: number | undefined;
    installApi("admin", {
      computers: [
        {
          id: computerId,
          ownerUserId: userId,
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
      ownComputerReadStatus: () => ownComputerReadStatus,
    });
    window.history.replaceState({}, "", "/agents");
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "New Agent" }));
    const dialog = await screen.findByRole("dialog", { name: "New Agent" });
    await within(dialog).findByText("Codex is ready on Ada's Mac.");
    const provider = within(dialog).getByLabelText("Provider") as HTMLSelectElement;
    const computer = within(dialog).getByLabelText("Computer") as HTMLSelectElement;
    fireEvent.change(provider, { target: { value: "claude-code" } });
    expect(await within(dialog).findByText(/Claude Code is currently unavailable/)).toBeTruthy();

    claudeReadiness.status = "ready";
    window.dispatchEvent(new Event("focus"));
    expect(await within(dialog).findByText("Claude Code is ready on Ada's Mac.")).toBeTruthy();
    expect(provider.value).toBe("claude-code");
    expect(computer.value).toBe(computerId);

    claudeReadiness.status = "unavailable";
    window.dispatchEvent(new Event("focus"));
    expect(await within(dialog).findByText(/Claude Code is currently unavailable/)).toBeTruthy();

    ownComputerReadStatus = 503;
    window.dispatchEvent(new Event("focus"));
    expect(await within(dialog).findByText(/Claude Code readiness has not been reported/)).toBeTruthy();
    expect(provider.value).toBe("claude-code");
    expect(computer.value).toBe(computerId);
    expect(within(dialog).getByRole("button", { name: "Create Agent" }).hasAttribute("disabled")).toBe(false);
  });

  it("sends a Team-less session to Team creation and lands it on Agents", async () => {
    installApi("admin", { teamless: true });
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Create your team" })).toBeTruthy();
    expect(window.location.pathname).toBe("/teams/new");
    expect(screen.getAllByRole("textbox")).toHaveLength(1);
    expect(screen.queryByText(/canonical name/i)).toBeNull();
    fireEvent.change(screen.getByLabelText("Team name"), { target: { value: "First Tree AI" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Team" }));
    expect(await screen.findByRole("heading", { name: "Agents" })).toBeTruthy();
    expect(window.location.pathname).toBe("/agents");
    expect(window.localStorage.getItem("opentag.selectedTeamId")).toBe(createdTeamId);
  });

  it("resolves an internal Team handle collision without asking the user for another name", async () => {
    installApi("admin", { teamless: true, teamNameConflict: true });
    window.history.replaceState({}, "", "/teams/new");
    render(<App />);
    fireEvent.change(await screen.findByLabelText("Team name"), { target: { value: "Example" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Team" }));
    expect(await screen.findByRole("heading", { name: "Agents" })).toBeTruthy();
    const createRequests = vi
      .mocked(fetch)
      .mock.calls.filter(([path, init]) => path === "/api/v1/teams" && init?.method === "POST");
    expect(createRequests).toHaveLength(2);
    expect(JSON.parse(String(createRequests[0]?.[1]?.body))).toEqual({ name: "example", displayName: "Example" });
    expect(JSON.parse(String(createRequests[1]?.[1]?.body))).toMatchObject({
      displayName: "Example",
      name: expect.stringMatching(/^example-[a-f0-9]{8}$/),
    });
  });

  it("uses a fresh internal handle for every collision on a Team name without ASCII characters", async () => {
    installApi("admin", { teamless: true, teamNameConflicts: 2 });
    window.history.replaceState({}, "", "/teams/new");
    render(<App />);
    fireEvent.change(await screen.findByLabelText("Team name"), { target: { value: "示例团队" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Team" }));
    await screen.findByRole("heading", { name: "Agents" });
    const requests = vi
      .mocked(fetch)
      .mock.calls.filter(([path, init]) => path === "/api/v1/teams" && init?.method === "POST");
    expect(requests).toHaveLength(3);
    const bodies = requests.map(
      (request) => JSON.parse(String(request[1]?.body)) as { displayName: string; name: string },
    );
    expect(bodies.every((body) => body.displayName === "示例团队")).toBe(true);
    expect(bodies.every((body) => /^team-[a-f0-9]{8}$/.test(body.name))).toBe(true);
    expect(new Set(bodies.map((body) => body.name))).toHaveProperty("size", 3);
  });

  it("lets an existing member create a second Team and offers both in the picker", async () => {
    installApi("admin");
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Example" }));
    fireEvent.click(screen.getByRole("link", { name: "Create Team" }));
    fireEvent.change(await screen.findByLabelText("Team name"), { target: { value: "Second Team" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Team" }));
    expect(await screen.findByRole("heading", { name: "Agents" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Second Team" }));
    const menu = screen.getByRole("dialog", { name: "Switch Team" });
    expect(within(menu).getByRole("button", { name: /Example Admin/ })).toBeTruthy();
    expect(
      within(menu)
        .getByRole("button", { name: /Second Team Admin/ })
        .getAttribute("aria-current"),
    ).toBe("true");
    expect(within(menu).queryByText("Team settings")).toBeNull();
  });

  it("keeps account controls personal and signs out from the account menu", async () => {
    installApi("admin");
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Account menu" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Account settings" }));
    expect(await screen.findByRole("heading", { name: "Account" })).toBeTruthy();
    expect(window.location.pathname).toBe("/account");
    const displayName = screen.getByLabelText("Display name") as HTMLInputElement;
    expect(displayName.readOnly).toBe(false);
    fireEvent.change(displayName, { target: { value: "Account Menu" } });
    expect(screen.getByRole("button", { name: "Save account profile" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Account menu" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Sign out" }));
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeTruthy();
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      "/api/v1/auth/browser/logout",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("moves focus into the Team picker and returns it to the trigger on Escape", async () => {
    installApi("admin");
    render(<App />);
    const trigger = await screen.findByRole("button", { name: "Example" });
    fireEvent.click(trigger);
    const currentTeam = screen.getByRole("button", { name: /Example Admin/ });
    expect(document.activeElement).toBe(currentTeam);
    fireEvent.keyDown(currentTeam, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Switch Team" })).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("supports arrow-key navigation and focus return in the account menu", async () => {
    installApi("admin");
    render(<App />);
    const trigger = await screen.findByRole("button", { name: "Account menu" });
    fireEvent.click(trigger);
    const accountSettings = screen.getByRole("menuitem", { name: "Account settings" });
    const signOut = screen.getByRole("menuitem", { name: "Sign out" });
    expect(document.activeElement).toBe(accountSettings);
    fireEvent.keyDown(accountSettings, { key: "ArrowDown" });
    expect(document.activeElement).toBe(signOut);
    fireEvent.keyDown(signOut, { key: "ArrowDown" });
    expect(document.activeElement).toBe(accountSettings);
    fireEvent.keyDown(accountSettings, { key: "End" });
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
