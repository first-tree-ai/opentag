import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../app.js";

const teamId = "d3fda800-7ce2-4338-aae8-3d2120401ed6";
const invitedTeamId = "3928e3dc-99b0-4a79-97c8-bf9c26b91add";
const userId = "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e";
const memberUserId = "63e2babe-e4ac-4e2c-b7d1-d092d5a4568e";
const otherMemberUserId = "73e2babe-e4ac-4e2c-b7d1-d092d5a4568e";
const agentId = "1a63a21e-f6c7-4474-91ea-4dabf0566a24";
const computerId = "85fe9af3-d1c6-472b-b78c-8a7ccf512750";
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
  createdAt: "2026-08-20T00:00:00.000Z",
  updatedAt: "2026-08-20T00:00:00.000Z",
};

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function installApi(
  role: "admin" | "member",
  options: {
    alreadyJoinedInvitation?: boolean;
    bound?: boolean;
    invitationExists?: boolean;
    provider?: "feishu" | "slack";
    redeemFails?: boolean;
    roleUpdate?: (targetUserId: string, role: "admin" | "member") => Promise<Response> | Response;
    roleUpdateFails?: boolean;
    scopeReauth?: boolean;
    unauthenticated?: boolean;
  } = {},
) {
  const teamProfile = { name: "example", displayName: "Example" };
  let currentRole = role;
  let memberRole: "admin" | "member" = "member";
  let otherMemberRole: "admin" | "member" = "member";
  let invitationExists = options.invitationExists ?? false;
  let invitationVersion: "A" | "B" = "A";
  let joinedInvitation = options.alreadyJoinedInvitation ?? false;
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
    if (path === "/api/v1/me") {
      if (options.unauthenticated) return json({ error: { message: "Sign in required" } }, 401);
      return json({
        user: { id: userId, email: "ada@example.com", displayName: "Ada" },
        memberships: [
          { teamId, teamName: teamProfile.name, teamDisplayName: teamProfile.displayName, role: currentRole },
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
        ],
      });
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
    if (path === `/api/v1/teams/${teamId}/agents` || path === `/api/v1/teams/${invitedTeamId}/agents`) {
      return json({
        agents: [path.includes(invitedTeamId) ? { ...agentSummary, teamId: invitedTeamId } : agentSummary],
      });
    }
    if (path === `/api/v1/teams/${teamId}/members`) {
      return json({
        members: [
          { userId, displayName: "Ada", role: currentRole },
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
      invitationExists = true;
      return json(invitation(), 201);
    }
    if (path === `/api/v1/teams/${teamId}/invitation/rotate` && init?.method === "POST") {
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
    if (path === `/api/v1/teams/${teamId}/computers`) return json({ computers: [] });
    if (path === "/api/v1/me/computers") return json({ computers: [] });
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
      return json({ ...agentSummary, viewerCapabilities: { canManage: currentRole === "admin" } });
    }
    if (path === `/api/v1/agents/${agentId}/config`) {
      return json({
        id: agentId,
        teamId,
        name: agentSummary.name,
        displayName: agentSummary.displayName,
        runtimeProvider: agentSummary.runtimeProvider,
        receiveMode: agentSummary.receiveMode,
        createdAt: agentSummary.createdAt,
        updatedAt: agentSummary.updatedAt,
        managerUserId: userId,
        computerId,
        revision: 1,
        runtimeConfig: {
          revision: 1,
          model: null,
          reasoningEffort: null,
          instructions: "",
          allowedTools: [],
          maxDurationMs: null,
        },
      });
    }
    if (path === `/api/v1/agents/${agentId}/im-binding`) {
      if (!options.bound) return new Response(null, { status: 204 });
      return json({
        id: crypto.randomUUID(),
        agentId,
        provider: options.provider ?? "feishu",
        bindingState: "active",
        bot: { displayName: "Reviewer", avatarUrl: null },
        receiveMode: "mention_only",
        lastInboundAt: null,
        lastOutboundAt: null,
        lastConfirmedAt: "2026-08-20T00:00:00.000Z",
      });
    }
    if (path === `/api/v1/agents/${agentId}/im-binding/feishu/setup-attempts` && init?.method === "POST") {
      return json(
        {
          id: crypto.randomUUID(),
          agentId,
          intent: "create",
          state: "awaiting_user",
          qrUrl: "https://open.feishu.cn/setup",
          expiresAt: "2026-08-20T00:15:00.000Z",
          errorCode: null,
          completedAt: null,
          createdAt: "2026-08-20T00:00:00.000Z",
        },
        201,
      );
    }
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${path}`);
  });
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
    expect(screen.getByRole("link", { name: "Create Agent" })).toBeTruthy();
    expect(screen.queryByText("Tasks")).toBeNull();
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
    expect(screen.getByText("Member · read only")).toBeTruthy();
    expect(await screen.findByText("Reviewer")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Create Agent" })).toBeNull();
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
    expect((screen.getByRole("combobox", { name: "Team" }) as HTMLSelectElement).value).toBe(invitedTeamId);
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
    window.history.replaceState({}, "", "/settings/members");
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

  it("keeps invitation-link management hidden from regular members", async () => {
    installApi("member");
    window.history.replaceState({}, "", "/settings/members");
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Team members" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Invite people" })).toBeNull();
    expect(screen.queryByLabelText("Role for Ada")).toBeNull();
    expect(await screen.findAllByText("member")).toHaveLength(3);
  });

  it("lets Team admins update another member role from the member list", async () => {
    installApi("admin");
    window.history.replaceState({}, "", "/settings/members");
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
    window.history.replaceState({}, "", "/settings/members");
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
    window.history.replaceState({}, "", "/settings/members");
    render(<App />);
    fireEvent.change(await screen.findByLabelText("Role for Ada"), { target: { value: "member" } });
    await waitFor(() =>
      expect(vi.mocked(fetch).mock.calls.filter(([input]) => String(input) === "/api/v1/me")).toHaveLength(2),
    );
    expect(await screen.findByText("Member · read only")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Invite people" })).toBeNull();
    expect(screen.queryByLabelText("Role for Ada")).toBeNull();
  });

  it("keeps the confirmed role and displays the server error when an update is rejected", async () => {
    installApi("admin", { roleUpdateFails: true });
    window.history.replaceState({}, "", "/settings/members");
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
    expect(await screen.findByRole("button", { name: "Connect Feishu" })).toBeTruthy();
    expect(vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
  });

  it("creates a Feishu setup attempt only after an explicit admin click", async () => {
    installApi("admin");
    window.history.replaceState({}, "", `/agents/${agentId}/im`);
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Connect Feishu" }));
    expect(await screen.findByText("Feishu setup started")).toBeTruthy();
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

  it("removes the old admin product shell without a redirect", async () => {
    window.history.replaceState({}, "", "/admin");
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Page not found" })).toBeTruthy();
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});
