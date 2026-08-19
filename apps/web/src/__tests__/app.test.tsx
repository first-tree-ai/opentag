import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../app.js";

vi.mock("qrcode", () => ({ default: { toDataURL: vi.fn(async () => "data:image/png;base64,qr") } }));

const teamId = "d3fda800-7ce2-4338-aae8-3d2120401ed6";
const agentId = "1a63a21e-f6c7-4474-91ea-4dabf0566a24";
const runtimeConfig = {
  revision: 1,
  model: null,
  reasoningEffort: null,
  instructions: "Act as the configured OpenTag Agent.",
  allowedTools: ["opentag_message_react", "opentag_message_reply", "opentag_message_send"],
  maxDurationMs: null,
};

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
        runtimeConfig,
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

const connectedComputer = {
  id: "11111111-1111-4111-8111-111111111111",
  ownerUserId: "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e",
  displayName: "Ada's Mac",
  platform: "darwin",
  arch: "arm64",
  clientVersion: "0.1.0",
  connectionStatus: "online",
  connectedAt: "2030-01-01T00:00:03.000Z",
  lastSeenAt: "2030-01-01T00:00:03.000Z",
};

const ownTeamComputer = {
  ...connectedComputer,
  ownerDisplayName: "Ada",
  observedAt: "2030-01-01T00:00:04.000Z",
  agentIds: [],
};

const teammateComputer = {
  ...ownTeamComputer,
  id: "33333333-3333-4333-8333-333333333333",
  ownerUserId: "22222222-2222-4222-8222-222222222222",
  ownerDisplayName: "Grace",
  displayName: "Grace's Linux",
  platform: "linux",
  arch: "x64",
};

afterEach(() => vi.useRealTimers());

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
      runtimeConfig,
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
          runtimeConfig,
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

  it("lets an active member mint and copy a user-scoped connection command", async () => {
    window.history.replaceState({}, "", "/admin");
    const copy = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: copy } });
    vi.mocked(fetch).mockImplementation(async (input) => {
      const url = String(input);
      if (url === "/api/v1/me") return response(me("member"));
      if (url === "/api/v1/me/computers") return response({ computers: [] });
      if (url === "/api/v1/me/connect-codes") {
        return response(
          {
            bootstrapCommand: "npm i -g open-tag && opentag login member_code --server https://opentag.example.com",
            expiresIn: 900,
            issuedAt: "2030-01-01T00:00:02.000Z",
          },
          201,
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Connect computer" }));
    const command = await screen.findByText(/opentag login member_code/);
    fireEvent.click(screen.getByRole("button", { name: "Copy command" }));
    await act(async () => Promise.resolve());
    expect(copy).toHaveBeenCalledWith(command.textContent);
    expect(screen.queryByText("Admin access required")).toBeNull();
  });

  it("mints, copies, and detects a newly connected user Computer", async () => {
    window.history.replaceState({}, "", `/admin/teams/${teamId}/computers`);
    const copy = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: copy } });
    let ownComputerReads = 0;
    vi.mocked(fetch).mockImplementation(async (input) => {
      const url = String(input);
      if (url === "/api/v1/me") return response(me("admin"));
      if (url === `/api/v1/teams/${teamId}/computers`) {
        return response({ computers: [ownTeamComputer, teammateComputer] });
      }
      if (url === "/api/v1/me/computers") {
        ownComputerReads += 1;
        return response({ computers: ownComputerReads <= 2 ? [] : [connectedComputer] });
      }
      if (url === "/api/v1/me/connect-codes") {
        return response(
          {
            bootstrapCommand: "npm i -g open-tag && opentag login fresh_code --server https://opentag.example.com",
            expiresIn: 900,
            issuedAt: "2030-01-01T00:00:02.000Z",
          },
          201,
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<App />);
    expect(await screen.findByRole("cell", { name: "Grace's Linux" })).toBeTruthy();
    expect(screen.queryByRole("cell", { name: "Ada's Mac" })).toBeNull();
    const connectButton = await screen.findByRole("button", { name: "Connect computer" });
    vi.useFakeTimers();
    await act(async () => {
      fireEvent.click(connectButton);
      await Promise.resolve();
      await Promise.resolve();
    });
    const command = screen.getByText(/opentag login fresh_code/);
    fireEvent.click(screen.getByRole("button", { name: "Copy command" }));
    await act(async () => Promise.resolve());
    expect(copy).toHaveBeenCalledWith(command.textContent);
    expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy();

    await act(async () => {
      vi.advanceTimersByTime(2000);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByRole("status").textContent).toContain("Ada's Mac connected");
    vi.useRealTimers();
    expect(await screen.findByRole("cell", { name: "Ada's Mac" })).toBeTruthy();
    expect(ownComputerReads).toBe(4);
  });

  it("ignores a reconnect before the Server-issued command boundary", async () => {
    window.history.replaceState({}, "", `/admin/teams/${teamId}/computers`);
    const baselineComputer = {
      ...connectedComputer,
      connectedAt: "2030-01-01T00:00:00.000Z",
      connectionStatus: "offline",
    };
    const preIssueReconnect = { ...connectedComputer, connectedAt: "2030-01-01T00:00:01.000Z" };
    let ownComputerReads = 0;
    vi.mocked(fetch).mockImplementation(async (input) => {
      const url = String(input);
      if (url === "/api/v1/me") return response(me("admin"));
      if (url === `/api/v1/teams/${teamId}/computers`) return response({ computers: [] });
      if (url === "/api/v1/me/computers") {
        ownComputerReads += 1;
        if (ownComputerReads <= 2) return response({ computers: [baselineComputer] });
        if (ownComputerReads === 3) return response({ computers: [preIssueReconnect] });
        return response({ computers: [connectedComputer] });
      }
      if (url === "/api/v1/me/connect-codes") {
        return response(
          {
            bootstrapCommand: `./scripts/dev-install.sh && PATH="$HOME/.local/bin\${PATH:+:$PATH}" "$HOME/.local/bin/opentag-dev" login boundary_code --server http://127.0.0.1:8000`,
            expiresIn: 900,
            issuedAt: "2030-01-01T00:00:02.000Z",
          },
          201,
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<App />);
    const connectButton = await screen.findByRole("button", { name: "Connect computer" });
    vi.useFakeTimers();
    await act(async () => {
      fireEvent.click(connectButton);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText(/login boundary_code/)).toBeTruthy();
    await act(async () => {
      vi.advanceTimersByTime(2000);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.queryByRole("status")).toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(2000);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByRole("status").textContent).toContain("Ada's Mac connected");
  });

  it("expires a command and generates a fresh one on demand", async () => {
    window.history.replaceState({}, "", `/admin/teams/${teamId}/computers`);
    let issueCount = 0;
    vi.mocked(fetch).mockImplementation(async (input) => {
      const url = String(input);
      if (url === "/api/v1/me") return response(me("admin"));
      if (url === `/api/v1/teams/${teamId}/computers` || url === "/api/v1/me/computers") {
        return response({ computers: [] });
      }
      if (url === "/api/v1/me/connect-codes") {
        issueCount += 1;
        return response(
          {
            bootstrapCommand: `./scripts/dev-install.sh && PATH="$HOME/.local/bin\${PATH:+:$PATH}" "$HOME/.local/bin/opentag-dev" login code_${issueCount} --server http://127.0.0.1:8000`,
            expiresIn: issueCount === 1 ? 1 : 900,
            issuedAt: "2030-01-01T00:00:02.000Z",
          },
          201,
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<App />);
    const connectButton = await screen.findByRole("button", { name: "Connect computer" });
    vi.useFakeTimers();
    await act(async () => {
      fireEvent.click(connectButton);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText(/login code_1/)).toBeTruthy();
    await act(async () => vi.advanceTimersByTime(1000));
    fireEvent.click(screen.getByRole("button", { name: "Generate new command" }));
    vi.useRealTimers();
    expect(await screen.findByText(/login code_2/)).toBeTruthy();
    expect(issueCount).toBe(2);
  });

  it("does not let a closed dialog's pending baseline request mint into a reopened dialog", async () => {
    window.history.replaceState({}, "", `/admin/teams/${teamId}/computers`);
    let resolveOldBaseline: ((value: Response) => void) | undefined;
    const oldBaseline = new Promise<Response>((resolve) => {
      resolveOldBaseline = resolve;
    });
    let baselineReads = 0;
    let issueCount = 0;
    vi.mocked(fetch).mockImplementation(async (input) => {
      const url = String(input);
      if (url === "/api/v1/me") return response(me("admin"));
      if (url === `/api/v1/teams/${teamId}/computers`) return response({ computers: [] });
      if (url === "/api/v1/me/computers") {
        baselineReads += 1;
        if (baselineReads === 2) return oldBaseline;
        return response({ computers: [] });
      }
      if (url === "/api/v1/me/connect-codes") {
        issueCount += 1;
        return response(
          {
            bootstrapCommand: `./scripts/dev-install.sh && PATH="$HOME/.local/bin\${PATH:+:$PATH}" "$HOME/.local/bin/opentag-dev" login current_code --server http://127.0.0.1:8000`,
            expiresIn: 900,
            issuedAt: "2030-01-01T00:00:02.000Z",
          },
          201,
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<App />);
    expect(await screen.findByText("No computers connected to your account.")).toBeTruthy();
    expect(await screen.findByText("No other active Team members have connected computers.")).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Connect computer" }));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByRole("button", { name: "Connect computer" }));
    expect(await screen.findByText(/login current_code/)).toBeTruthy();
    expect(baselineReads).toBe(3);
    resolveOldBaseline?.(response({ computers: [] }));
    await act(async () => Promise.resolve());
    expect(issueCount).toBe(1);
  });
});
