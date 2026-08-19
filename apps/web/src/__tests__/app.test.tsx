import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { App } from "../app.js";

vi.mock("qrcode", () => ({ default: { toDataURL: vi.fn(async () => "data:image/png;base64,qr") } }));

const teamId = "d3fda800-7ce2-4338-aae8-3d2120401ed6";
const agentId = "1a63a21e-f6c7-4474-91ea-4dabf0566a24";

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function me(role: "admin" | "member") {
  return {
    user: { id: "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e", email: "admin@example.com", displayName: "Ada" },
    memberships: [{ teamId, teamName: "example", teamDisplayName: "Example", role }],
  };
}

function feishuIntegrationFetch(diagnostics: Record<string, unknown>) {
  return async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path === "/api/v1/me") return response(me("admin"));
    if (path === `/api/v1/agents/${agentId}`) {
      return response({
        id: agentId,
        teamId,
        managerUserId: "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e",
        computerId: "85fe9af3-d1c6-472b-b78c-8a7ccf512750",
        name: "assistant",
        displayName: "Assistant",
        runtimeProvider: "codex",
        receiveMode: "all_message",
        revision: 1,
        createdAt: "2026-08-19T00:00:00.000Z",
        updatedAt: "2026-08-19T00:00:00.000Z",
      });
    }
    if (path === `/api/v1/agents/${agentId}/integration`) {
      return response({
        integration: {
          id: "6d93de68-ec32-4ac9-a41e-e96ed2d7dac0",
          agentId,
          provider: "feishu",
          status: "active",
          disabledAt: null,
          createdAt: "2026-08-19T00:00:00.000Z",
          updatedAt: "2026-08-19T00:00:00.000Z",
        },
        identity: {
          provider: "feishu",
          appId: "cli_1",
          teamId: "team_1",
          botOpenId: "ou_bot",
          teamBrand: "feishu",
        },
        receiveMode: "all_message",
        credentialGeneration: 1,
        grantedCapabilities: ["im:message:send_as_bot"],
        reauthorizationRequired: false,
        lastInboundAt: null,
        lastOutboundAt: null,
      });
    }
    if (path === "/api/v1/integrations/6d93de68-ec32-4ac9-a41e-e96ed2d7dac0/diagnostics") {
      return response(diagnostics);
    }
    throw new Error(`Unexpected request: ${path}`);
  };
}

describe("Admin Web", () => {
  it("renders only browser sign-in methods reported by the server", async () => {
    window.history.replaceState({}, "", "/admin/login");
    vi.mocked(fetch).mockResolvedValueOnce(
      response({
        providers: [
          { id: "google", enabled: true, startUrl: "/api/v1/auth/google/start" },
          { id: "dev", enabled: false, startUrl: null },
        ],
      }),
    );
    render(<App />);
    expect((await screen.findByRole("link", { name: "Continue with Google" })).getAttribute("href")).toBe(
      "/api/v1/auth/google/start?next=%2Fadmin",
    );
    expect(screen.queryByRole("link", { name: "Dev: bypass Google" })).toBeNull();
    expect(document.body.textContent).not.toContain("accessToken");
  });

  it("offers the explicit development bypass on localhost and preserves the destination", async () => {
    window.history.replaceState({}, "", "/admin/login?next=%2Finvite%2FAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    vi.mocked(fetch).mockResolvedValueOnce(
      response({
        providers: [
          { id: "google", enabled: false, startUrl: null },
          { id: "dev", enabled: true, startUrl: "/api/v1/auth/dev/callback" },
        ],
      }),
    );
    render(<App />);
    expect((await screen.findByRole("link", { name: "Dev: bypass Google" })).getAttribute("href")).toBe(
      "/api/v1/auth/dev/callback?next=%2Finvite%2FAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    );
    expect(screen.queryByRole("link", { name: "Continue with Google" })).toBeNull();
  });

  it("uses live memberships for the Team selector", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response(me("admin")));
    render(<App />);
    const link = await screen.findByRole("link", { name: /Example/ });
    expect(link.getAttribute("href")).toBe(`/admin/teams/${teamId}`);
  });

  it("shows an explicit forbidden page for a non-admin Team member", async () => {
    window.history.replaceState({}, "", `/admin/teams/${teamId}`);
    vi.mocked(fetch).mockResolvedValueOnce(response(me("member")));
    render(<App />);
    expect(await screen.findByText("Admin access required")).toBeTruthy();
    expect(screen.getByText(/current Team role is member/)).toBeTruthy();
  });

  it("starts the same-page Feishu QR flow automatically for an unbound Agent", async () => {
    window.history.replaceState({}, "", `/admin/teams/${teamId}/agents/${agentId}`);
    const agent = {
      id: agentId,
      teamId,
      managerUserId: "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e",
      computerId: "85fe9af3-d1c6-472b-b78c-8a7ccf512750",
      name: "assistant",
      displayName: "Assistant",
      runtimeProvider: "codex",
      receiveMode: "all_message",
      revision: 1,
      createdAt: "2026-08-19T00:00:00.000Z",
      updatedAt: "2026-08-19T00:00:00.000Z",
    };
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const path = String(input);
      if (path === "/api/v1/me") return response(me("admin"));
      if (path === `/api/v1/agents/${agentId}`) return response(agent);
      if (path === `/api/v1/agents/${agentId}/integration`) return new Response(null, { status: 204 });
      if (path === `/api/v1/agents/${agentId}/integrations/feishu/setup-attempts`) {
        expect(init?.method).toBe("POST");
        expect(init?.body).toBe(JSON.stringify({ intent: "create" }));
        return response({
          id: "f645f26d-9184-4f2f-98a1-4ee83ae6a603",
          agentId,
          intent: "create",
          state: "awaiting_user",
          qrUrl: "https://open.feishu.cn/qr/example",
          expiresAt: "2026-08-19T01:00:00.000Z",
          errorCode: null,
          completedAt: null,
          createdAt: "2026-08-19T00:00:00.000Z",
        });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    render(<App />);
    expect(await screen.findByRole("img", { name: "Scan with Feishu to create this Agent Bot" })).toBeTruthy();
    expect(screen.getByText("Waiting for visible Feishu consent…")).toBeTruthy();
    expect(screen.queryByText(/developer console/i)).toBeNull();
  });

  it("does not hand off work while the controlled runtime message tool is unavailable", async () => {
    window.history.replaceState({}, "", `/admin/teams/${teamId}/agents/${agentId}`);
    vi.mocked(fetch).mockImplementation(async (input) => {
      const path = String(input);
      if (path === "/api/v1/me") return response(me("admin"));
      if (path === `/api/v1/agents/${agentId}`) {
        return response({
          id: agentId,
          teamId,
          managerUserId: me("admin").user.id,
          computerId: "85fe9af3-d1c6-472b-b78c-8a7ccf512750",
          name: "assistant",
          displayName: "Assistant",
          runtimeProvider: "codex",
          receiveMode: "all_message",
          revision: 1,
          createdAt: "2026-08-19T00:00:00.000Z",
          updatedAt: "2026-08-19T00:00:00.000Z",
        });
      }
      if (path === `/api/v1/agents/${agentId}/integration`) {
        return response({
          integration: {
            id: "6d93de68-ec32-4ac9-a41e-e96ed2d7dac0",
            agentId,
            provider: "feishu",
            status: "active",
            disabledAt: null,
            createdAt: "2026-08-19T00:00:00.000Z",
            updatedAt: "2026-08-19T00:00:00.000Z",
          },
          identity: {
            provider: "feishu",
            appId: "cli_1",
            teamId: null,
            botOpenId: "ou_bot",
            teamBrand: "feishu",
          },
          receiveMode: "all_message",
          credentialGeneration: 1,
          grantedCapabilities: ["im:message:send_as_bot"],
          reauthorizationRequired: false,
          lastInboundAt: null,
          lastOutboundAt: null,
        });
      }
      if (path === "/api/v1/integrations/6d93de68-ec32-4ac9-a41e-e96ed2d7dac0/diagnostics") {
        return response({
          integrationId: "6d93de68-ec32-4ac9-a41e-e96ed2d7dac0",
          provider: "feishu",
          ready: false,
          runtimeToolAvailable: false,
          credentialGeneration: 1,
          reauthorizationRequired: false,
          lastInboundAt: null,
          lastOutboundAt: null,
          lastErrorCode: null,
          connection: null,
        });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    render(<App />);
    expect(await screen.findByText(/runtime message tool unavailable/)).toBeTruthy();
    expect(screen.queryByText(/^Ready/)).toBeNull();
    expect(screen.queryByText(/Message the Bot directly/)).toBeNull();
  });

  it.each([
    ["a disconnected Channel", false, "disconnected", "2026-08-19T00:01:00.000Z"],
    ["an expired Channel lease", false, "disconnected", "2026-08-19T00:02:00.000Z"],
    ["a reconnected Channel", true, "connected", "2026-08-19T00:03:00.000Z"],
  ])("gates Feishu work handoff for %s", async (_label, ready, connectionState, observedAt) => {
    window.history.replaceState({}, "", `/admin/teams/${teamId}/agents/${agentId}`);
    vi.mocked(fetch).mockImplementation(
      feishuIntegrationFetch({
        integrationId: "6d93de68-ec32-4ac9-a41e-e96ed2d7dac0",
        provider: "feishu",
        ready,
        runtimeToolAvailable: true,
        credentialGeneration: 1,
        reauthorizationRequired: false,
        lastInboundAt: null,
        lastOutboundAt: null,
        lastErrorCode: null,
        connection: { state: connectionState, observedAt },
      }),
    );
    render(<App />);
    if (ready) {
      expect(await screen.findByText(/^Ready as/)).toBeTruthy();
      expect(screen.getByText(/Message the Bot directly/)).toBeTruthy();
    } else {
      expect(await screen.findByText(/^Validating as/)).toBeTruthy();
      expect(screen.queryByText(/Message the Bot directly/)).toBeNull();
    }
  });
});
