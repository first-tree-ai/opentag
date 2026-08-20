import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../app.js";

const teamId = "d3fda800-7ce2-4338-aae8-3d2120401ed6";
const userId = "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e";
const agentId = "1a63a21e-f6c7-4474-91ea-4dabf0566a24";
const computerId = "85fe9af3-d1c6-472b-b78c-8a7ccf512750";
const createdTeamId = "6b1f0c9a-2d4e-4a77-9c31-8f0c5b2ad741";

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
    bound?: boolean;
    provider?: "feishu" | "slack";
    scopeReauth?: boolean;
    unauthenticated?: boolean;
    teamless?: boolean;
    teamNameConflict?: boolean;
  } = {},
) {
  const teamProfile = { name: "example", displayName: "Example" };
  const createdMemberships: { teamId: string; teamName: string; teamDisplayName: string; role: "admin" }[] = [];
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    const path = String(input);
    if (path === "/api/v1/auth/providers") {
      return json({ providers: [{ id: "dev", enabled: true, startUrl: "/api/v1/auth/dev/callback" }] });
    }
    if (path === "/api/v1/me") {
      if (options.unauthenticated) return json({ error: { message: "Sign in required" } }, 401);
      const existing = options.teamless
        ? []
        : [{ teamId, teamName: teamProfile.name, teamDisplayName: teamProfile.displayName, role }];
      return json({
        user: { id: userId, email: "ada@example.com", displayName: "Ada" },
        memberships: [...existing, ...createdMemberships],
      });
    }
    if (path === "/api/v1/teams" && init?.method === "POST") {
      if (options.teamNameConflict) {
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
    if (/^\/api\/v1\/teams\/[^/]+\/agents$/.test(path)) return json({ agents: [agentSummary] });
    if (/^\/api\/v1\/teams\/[^/]+\/computers$/.test(path)) return json({ computers: [] });
    if (path === "/api/v1/me/computers") return json({ computers: [] });
    if (path === "/api/v1/me/connect-codes" && init?.method === "POST") {
      return json(
        {
          bootstrapCommand: "npm i -g @opentag/cli && opentag login --code example",
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
      return json({ ...agentSummary, viewerCapabilities: { canManage: role === "admin" } });
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
    expect(await screen.findByText(/opentag login --code example/)).toBeTruthy();
  });

  it("guides Agent creation to Computer setup when none is connected", async () => {
    installApi("admin");
    window.history.replaceState({}, "", "/agents/new");
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Connect a Local Computer first" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Computer settings" }).getAttribute("href")).toBe("/settings/computers");
  });

  it("sends a Team-less session to Team creation and lands it on Agents", async () => {
    installApi("admin", { teamless: true });
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Create Team" })).toBeTruthy();
    expect(window.location.pathname).toBe("/teams/new");
    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "First Tree AI" } });
    expect((screen.getByLabelText("Canonical name") as HTMLInputElement).value).toBe("first-tree-ai");
    fireEvent.click(screen.getByRole("button", { name: "Create Team" }));
    expect(await screen.findByRole("heading", { name: "Agents" })).toBeTruthy();
    expect(window.location.pathname).toBe("/agents");
    expect(window.localStorage.getItem("opentag.selectedTeamId")).toBe(createdTeamId);
  });

  it("keeps a canonical name collision on the form with a readable message", async () => {
    installApi("admin", { teamless: true, teamNameConflict: true });
    window.history.replaceState({}, "", "/teams/new");
    render(<App />);
    fireEvent.change(await screen.findByLabelText("Display name"), { target: { value: "Example" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Team" }));
    expect(await screen.findByText("Another Team already uses this canonical name")).toBeTruthy();
    expect(window.location.pathname).toBe("/teams/new");
    expect((screen.getByLabelText("Display name") as HTMLInputElement).value).toBe("Example");
    expect(window.localStorage.getItem("opentag.selectedTeamId")).toBeNull();
  });

  it("stops deriving the canonical name once the user writes their own", async () => {
    installApi("admin", { teamless: true });
    window.history.replaceState({}, "", "/teams/new");
    render(<App />);
    fireEvent.change(await screen.findByLabelText("Display name"), { target: { value: "First Tree" } });
    fireEvent.change(screen.getByLabelText("Canonical name"), { target: { value: "ft" } });
    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "First Tree AI" } });
    expect((screen.getByLabelText("Canonical name") as HTMLInputElement).value).toBe("ft");
  });

  it("lets an existing member create a second Team and offers both in the picker", async () => {
    installApi("admin");
    render(<App />);
    fireEvent.click(await screen.findByRole("link", { name: "Create Team" }));
    fireEvent.change(await screen.findByLabelText("Display name"), { target: { value: "Second Team" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Team" }));
    expect(await screen.findByRole("heading", { name: "Agents" })).toBeTruthy();
    const picker = screen.getByLabelText("Team") as HTMLSelectElement;
    expect([...picker.options].map((option) => option.textContent)).toEqual(["Example", "Second Team"]);
    expect(picker.value).toBe(createdTeamId);
  });

  it("removes the old admin product shell without a redirect", async () => {
    window.history.replaceState({}, "", "/admin");
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Page not found" })).toBeTruthy();
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});
