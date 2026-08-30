import { describe, expect, it, vi } from "vitest";
import { ApiError, BrowserApi } from "../api.js";

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

  it("exposes no Workspace management or invitation API", () => {
    const api = new BrowserApi();
    expect("admins" in api).toBe(false);
    expect("revokeWorkspaceAdmin" in api).toBe(false);
    expect("updateWorkspace" in api).toBe(false);
    expect("invitationPreview" in api).toBe(false);
    expect("acceptAdminInvitation" in api).toBe(false);
    expect("createAdminInvitation" in api).toBe(false);
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
            setupCompletedAt: null,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchImpl);

    await expect(new BrowserApi().me()).resolves.toMatchObject({ user: { email: "admin@example.com" } });
    expect(fetchImpl.mock.contexts).toEqual([globalThis]);
  });

  it("surfaces a 401 instead of trying to exchange it for a new credential", async () => {
    /*
     * A session renews itself as it is used, so a 401 means it is genuinely gone. The refresh call this used to make
     * had nothing left to exchange: it could only fail, and the retry behind it could only fail again.
     */
    setDocumentCookie("opentag_csrf=no-refresh; Path=/");
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 401 }));
    const api = new BrowserApi(fetchImpl);

    await expect(api.imBinding("1a63a21e-f6c7-4474-91ea-4dabf0566a24")).rejects.toMatchObject({ status: 401 });
    await expect(api.disableImBinding("2a63a21e-f6c7-4474-91ea-4dabf0566a24")).rejects.toMatchObject({ status: 401 });

    expect(fetchImpl.mock.calls.map(([input]) => String(input))).toEqual([
      "/api/v1/agents/1a63a21e-f6c7-4474-91ea-4dabf0566a24/im-binding",
      "/api/v1/im-bindings/2a63a21e-f6c7-4474-91ea-4dabf0566a24/disable",
    ]);
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

  it("mints a connect command with CSRF and lists the Account enrollments", async () => {
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
      if (String(input) === "/api/v1/computers") {
        expect(new Headers(init?.headers).get("x-opentag-provider-readiness")).toBe("1");
        return new Response(JSON.stringify({ computers: [computer] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      expect(String(input)).toBe("/api/v1/computer-connect-codes");
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
    await expect(api.computers()).resolves.toEqual({ computers: [computer] });
    await expect(api.issueComputerConnectCode()).resolves.toMatchObject({ expiresIn: 900 });
    setDocumentCookie("opentag_csrf=; Path=/; Max-Age=0");
  });

  it("routes the remaining browser API operations with their documented methods", async () => {
    const calls: Array<{ path: string; method: string | undefined }> = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      calls.push({ path: String(input), method: init?.method });
      return new Response(null, { status: 204 });
    });
    const api = new BrowserApi(fetchImpl);
    const operations = [
      api.completeSetup(userId),
      api.agents(),
      api.tasks({ cursor: "next", agentId: userId, kind: "thread" }),
      api.task(userId, "older"),
      api.agent(userId),
      api.agentUsage(userId, 7),
      api.agentConfig(userId),
      api.createAgent({} as never),
      api.updateAgent(userId, {} as never),
      api.suspendAgent(userId),
      api.reactivateAgent(userId),
      api.deleteAgent(userId),
      api.imBindingConfig(userId),
      api.createFeishuSetupAttempt(userId, "reauthorize"),
      api.feishuSetupAttempt(userId),
      api.startSlackOAuth(userId, { intent: "create" }),
      api.imBindingDiagnostics(userId),
      api.computers(),
      api.issueComputerConnectCode(),
      api.resetOnboardingLab(),
      api.signUpWithPassword({ email: "ada@example.com", password: "password-password", name: "Ada" }),
      api.signInWithPassword({ email: "ada@example.com", password: "password-password" }),
      api.logout(),
    ];
    const results = await Promise.allSettled(operations);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(6);
    expect(calls).toEqual(
      expect.arrayContaining([
        { path: "/api/v1/me/setup/complete", method: "POST" },
        { path: "/api/v1/sessions?cursor=next&agentId=" + userId + "&kind=thread", method: undefined },
        { path: "/api/v1/sessions/" + userId + "?cursor=older", method: undefined },
        { path: "/api/v1/agents/" + userId + "/config", method: undefined },
        { path: "/api/v1/agents/" + userId, method: "DELETE" },
        { path: "/api/v1/internal/onboarding-lab", method: "POST" },
        { path: "/api/v1/auth/email/sign-up", method: "POST" },
        { path: "/api/v1/auth/browser/logout", method: "POST" },
      ]),
    );
  });

  it("reports staging Lab reachability, health status, and malformed CSRF cookies", async () => {
    const responses = [
      new Response(null, { status: 204 }),
      new Response(null, { status: 404 }),
      new Response(
        JSON.stringify({ error: { code: "SERVICE_UNAVAILABLE", category: "transient", message: "Lab failed" } }),
        { status: 503 },
      ),
      new Response(JSON.stringify({ status: "ok" }), { status: 200, headers: { "content-type": "application/json" } }),
      new Response(JSON.stringify({ status: 42 }), { status: 200, headers: { "content-type": "application/json" } }),
    ];
    const fetchImpl = vi.fn<typeof fetch>(async () => responses.shift() ?? new Response(null, { status: 500 }));
    const api = new BrowserApi(fetchImpl);
    await expect(api.onboardingLabOffered()).resolves.toBe(true);
    await expect(api.onboardingLabOffered()).resolves.toBe(false);
    await expect(api.onboardingLabOffered()).rejects.toMatchObject({ status: 503, message: "Lab failed" });
    await expect(api.health("/healthz")).resolves.toMatchObject({ status: "ok" });
    await expect(api.health("/readyz")).rejects.toMatchObject({ status: 200, message: "Health check failed" });

    setDocumentCookie("opentag_csrf=%E0%A4%A; Path=/");
    const malformedCookieFetch = vi.fn<typeof fetch>(async (_input, init) => {
      expect(new Headers(init?.headers).get("X-OpenTag-CSRF")).toBeNull();
      return new Response(null, { status: 204 });
    });
    await expect(new BrowserApi(malformedCookieFetch).logout()).resolves.toBeUndefined();
    setDocumentCookie("opentag_csrf=; Path=/; Max-Age=0");
  });
});
