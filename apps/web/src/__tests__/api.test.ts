import { describe, expect, it, vi } from "vitest";
import { ApiError, BrowserApi } from "../api.js";

const workspaceId = "d3fda800-7ce2-4338-aae8-3d2120401ed6";
const userId = "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e";

function setDocumentCookie(value: string): void {
  const setter = Object.getOwnPropertyDescriptor(Document.prototype, "cookie")?.set;
  if (!setter) throw new Error("The test DOM does not expose a cookie setter");
  setter.call(document, value);
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}

describe("BrowserApi", () => {
  it("updates the current user profile with PATCH, response parsing, and browser CSRF", async () => {
    setDocumentCookie("opentag_csrf=profile-csrf; Path=/");
    const profile = { id: userId, email: "ada@example.com", displayName: "Ada Lovelace" };
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe("/api/v1/me");
      expect(init?.method).toBe("PATCH");
      expect(init?.body).toBe(JSON.stringify({ displayName: "Ada Lovelace" }));
      expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
      expect(new Headers(init?.headers).get("X-OpenTag-CSRF")).toBe("profile-csrf");
      return new Response(JSON.stringify(profile), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    await expect(new BrowserApi(fetchImpl).updateProfile({ displayName: "Ada Lovelace" })).resolves.toEqual(profile);
    setDocumentCookie("opentag_csrf=; Path=/; Max-Age=0");
  });

  it("uses explicit CSRF-protected Agent lifecycle commands", async () => {
    setDocumentCookie("opentag_csrf=lifecycle-csrf; Path=/");
    const agentId = "1a63a21e-f6c7-4474-91ea-4dabf0566a24";
    const config = {
      id: agentId,
      workspaceId,
      createdByUserId: "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e",
      computerId: "98db056b-730c-4263-9d3d-8ec079833dba",
      name: "reviewer",
      displayName: "Reviewer",
      runtimeProvider: "codex",
      receiveMode: "mention_only",
      status: "suspended",
      revision: 2,
      runtimeConfig: {
        revision: 1,
        model: null,
        reasoningEffort: null,
        instructions: "",
        maxDurationMs: null,
      },
      createdAt: "2030-01-01T00:00:00.000Z",
      updatedAt: "2030-01-01T00:01:00.000Z",
    };
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      expect(init?.method).toBe(String(input).endsWith(`/agents/${agentId}`) ? "DELETE" : "POST");
      expect(new Headers(init?.headers).get("X-OpenTag-CSRF")).toBe("lifecycle-csrf");
      return init?.method === "DELETE" ? new Response(null, { status: 204 }) : jsonResponse(config);
    });
    const api = new BrowserApi(fetchImpl);
    await expect(api.suspendAgent(agentId)).resolves.toMatchObject({ status: "suspended" });
    await expect(api.reactivateAgent(agentId)).resolves.toMatchObject({ id: agentId });
    await expect(api.deleteAgent(agentId)).resolves.toBeUndefined();
    setDocumentCookie("opentag_csrf=; Path=/; Max-Age=0");
  });

  it("revokes a Workspace Admin with the browser mutation contract", async () => {
    setDocumentCookie("opentag_csrf=member-csrf; Path=/");
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe(`/api/v1/workspaces/${workspaceId}/admins/${userId}`);
      expect(init?.method).toBe("DELETE");
      expect(new Headers(init?.headers).get("X-OpenTag-CSRF")).toBe("member-csrf");
      return new Response(null, { status: 204 });
    });

    await expect(new BrowserApi(fetchImpl).revokeWorkspaceAdmin(workspaceId, userId)).resolves.toBeUndefined();
    setDocumentCookie("opentag_csrf=; Path=/; Max-Age=0");
  });

  it("updates Workspace profile fields with the browser mutation contract", async () => {
    setDocumentCookie("opentag_csrf=workspace-csrf; Path=/");
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe(`/api/v1/workspaces/${workspaceId}`);
      expect(init?.method).toBe("PATCH");
      expect(init?.body).toBe(JSON.stringify({ name: "renamed-workspace", displayName: "Renamed Workspace" }));
      expect(new Headers(init?.headers).get("X-OpenTag-CSRF")).toBe("workspace-csrf");
      return new Response(
        JSON.stringify({
          id: workspaceId,
          name: "renamed-workspace",
          displayName: "Renamed Workspace",
          updatedAt: "2030-01-01T00:00:00.000Z",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    await expect(
      new BrowserApi(fetchImpl).updateWorkspace(workspaceId, {
        name: "renamed-workspace",
        displayName: "Renamed Workspace",
      }),
    ).resolves.toMatchObject({ id: workspaceId, name: "renamed-workspace" });
    setDocumentCookie("opentag_csrf=; Path=/; Max-Age=0");
  });

  it("loads strict browser provider availability without retrying as an authenticated request", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            providers: [
              { id: "google", enabled: false, startUrl: null },
              { id: "dev", enabled: true, startUrl: "/api/v1/auth/dev/callback" },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    await expect(new BrowserApi(fetchImpl).authProviders()).resolves.toMatchObject({
      providers: [{ id: "google" }, { id: "dev", enabled: true }],
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("loads the authoritative handoff facts used by onboarding", async () => {
    const agentId = "1a63a21e-f6c7-4474-91ea-4dabf0566a24";
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      expect(String(input)).toBe(`/api/v1/agents/${agentId}/im-binding/handoff`);
      return jsonResponse({ bindingState: "active", handoffReady: false });
    });

    await expect(new BrowserApi(fetchImpl).imBindingHandoff(agentId)).resolves.toEqual({
      bindingState: "active",
      handoffReady: false,
    });
  });

  it("binds the default fetch implementation to the browser global", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            user: {
              id: "498ee47d-16dc-4798-8e20-3608a2973dcf",
              email: "admin@example.com",
              displayName: "Admin",
            },
            workspaces: [],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchImpl);

    await expect(new BrowserApi().me()).resolves.toMatchObject({ user: { email: "admin@example.com" } });
    expect(fetchImpl.mock.contexts).toEqual([globalThis]);
  });

  it("rebuilds mutation CSRF headers after refreshing an expired access token", async () => {
    setDocumentCookie("opentag_csrf=old-token; Path=/");
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      if (fetchImpl.mock.calls.length === 1) {
        expect(url).toContain("/accept");
        expect(headers.get("X-OpenTag-CSRF")).toBe("old-token");
        return new Response(null, { status: 401 });
      }
      if (fetchImpl.mock.calls.length === 2) {
        expect(url).toBe("/api/v1/auth/browser/refresh");
        setDocumentCookie("opentag_csrf=new-token; Path=/");
        return new Response(null, { status: 204 });
      }
      expect(url).toContain("/accept");
      expect(headers.get("X-OpenTag-CSRF")).toBe("new-token");
      return new Response(
        JSON.stringify({
          workspace: {
            id: workspaceId,
            name: "example",
            displayName: "Example",
            setupCompletedAt: null,
            grantedAt: "2030-01-01T00:00:00.000Z",
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    await expect(new BrowserApi(fetchImpl).acceptAdminInvitation("A".repeat(32))).resolves.toMatchObject({
      workspace: { id: workspaceId },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    setDocumentCookie("opentag_csrf=; Path=/; Max-Age=0");
  });

  it("exposes no client method that creates an Admin invitation", () => {
    expect("createAdminInvitation" in new BrowserApi(vi.fn<typeof fetch>())).toBe(false);
  });

  it("shares refresh behavior across optional and no-content requests", async () => {
    setDocumentCookie("opentag_csrf=shared-refresh; Path=/");
    let protectedCalls = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      if (String(input) === "/api/v1/auth/browser/refresh") return new Response(null, { status: 204 });
      protectedCalls += 1;
      if (protectedCalls === 1 || protectedCalls === 3 || protectedCalls === 5)
        return new Response(null, { status: 401 });
      return new Response(null, { status: 204 });
    });
    const api = new BrowserApi(fetchImpl);
    await expect(api.imBinding("1a63a21e-f6c7-4474-91ea-4dabf0566a24")).resolves.toBeUndefined();
    await expect(api.imBindingHandoff("1a63a21e-f6c7-4474-91ea-4dabf0566a24")).resolves.toBeUndefined();
    await expect(api.disableImBinding("2a63a21e-f6c7-4474-91ea-4dabf0566a24")).resolves.toBeUndefined();
    expect(fetchImpl.mock.calls.filter(([input]) => String(input) === "/api/v1/auth/browser/refresh")).toHaveLength(3);
    setDocumentCookie("opentag_csrf=; Path=/; Max-Age=0");
  });

  it("preserves structured server error codes for recovery actions", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              code: "IM_BINDING_SCOPE_REAUTH_REQUIRED",
              category: "deterministic",
              message: "Additional scopes are required",
            },
          }),
          { status: 409, headers: { "content-type": "application/json" } },
        ),
    );
    const error = await new BrowserApi(fetchImpl)
      .agentConfig("1a63a21e-f6c7-4474-91ea-4dabf0566a24")
      .catch((cause) => cause);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 409,
      code: "IM_BINDING_SCOPE_REAUTH_REQUIRED",
      category: "deterministic",
    });
  });

  it("preserves validated issues and rejects untyped error payloads", async () => {
    const issue = { path: ["name"], code: "invalid_format", message: "Use a lowercase Agent name" };
    const typedFetch = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              code: "VALIDATION_ERROR",
              category: "validation",
              message: "The request payload is invalid",
              issues: [issue],
            },
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        ),
    );
    const typedError = await new BrowserApi(typedFetch)
      .agentConfig("1a63a21e-f6c7-4474-91ea-4dabf0566a24")
      .catch((cause) => cause);
    expect(typedError).toMatchObject({ message: "The request payload is invalid", issues: [issue] });

    const untypedFetch = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              code: "VALIDATION_ERROR",
              category: "validation",
              message: "Do not trust this",
              issues: [{ ...issue, input: "secret" }],
            },
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        ),
    );
    const untypedError = await new BrowserApi(untypedFetch)
      .agentConfig("1a63a21e-f6c7-4474-91ea-4dabf0566a24")
      .catch((cause) => cause);
    expect(untypedError).toMatchObject({ status: 400, message: "Request failed" });
    expect(untypedError.issues).toBeUndefined();
  });

  it("mints a connect command with CSRF and lists the Workspace enrollments", async () => {
    setDocumentCookie("opentag_csrf=connect-csrf; Path=/");
    const computer = {
      computerId: userId,
      displayName: "workstation",
      platform: "linux",
      connectionStatus: "online",
      providerReadiness: [
        {
          provider: "codex",
          status: "ready",
          observedAt: "2030-01-01T00:00:01.000Z",
        },
      ],
      connectedAt: "2030-01-01T00:00:00.000Z",
      lastSeenAt: "2030-01-01T00:00:01.000Z",
      observedAt: "2030-01-01T00:00:01.000Z",
      enrolledAt: "2030-01-01T00:00:00.000Z",
      agentIds: [],
    };
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input) === `/api/v1/workspaces/${workspaceId}/computers`) {
        expect(new Headers(init?.headers).get("x-opentag-provider-readiness")).toBe("1");
        return new Response(JSON.stringify({ computers: [computer] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      expect(String(input)).toBe(`/api/v1/workspaces/${workspaceId}/computer-connect-codes`);
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("X-OpenTag-CSRF")).toBe("connect-csrf");
      expect(init?.body).toBeUndefined();
      return new Response(
        JSON.stringify({
          bootstrapCommand: `opentag computer connect --server http://127.0.0.1:8000 -- code`,
          expiresIn: 900,
          issuedAt: "2030-01-01T00:00:00.000Z",
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    });
    const api = new BrowserApi(fetchImpl);
    await expect(api.computers(workspaceId)).resolves.toEqual({ computers: [computer] });
    await expect(api.issueComputerConnectCode(workspaceId)).resolves.toMatchObject({ expiresIn: 900 });
    setDocumentCookie("opentag_csrf=; Path=/; Max-Age=0");
  });
});
