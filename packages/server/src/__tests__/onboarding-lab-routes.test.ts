import { randomUUID } from "node:crypto";
import { INTERNAL_ONBOARDING_LAB_PATH } from "@opentag/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { OnboardingResetError, OnboardingResetService } from "../services/onboarding-lab/index.js";

const PUBLIC_ORIGIN = "https://staging.example.com";
const apps: ReturnType<typeof createApp>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function fixture(
  options: {
    environment?: "dev" | "staging" | "prod";
    labAccountId?: string | "unconfigured";
    registered?: boolean;
  } = {},
) {
  const accountId = randomUUID();
  const labAccountId = options.labAccountId ?? accountId;
  const resetOnboarding = vi.fn().mockResolvedValue(undefined);
  const reset = new OnboardingResetService({
    agents: { suspendById: vi.fn(), deleteById: vi.fn() },
    database: {} as never,
    environment: options.environment ?? "staging",
    ...(labAccountId === "unconfigured" ? {} : { labAccountId }),
    workspaceAdmins: {} as never,
  });
  vi.spyOn(reset, "resetOnboarding").mockImplementation(resetOnboarding);
  const app = createApp({
    authService: {
      getAuthenticatedUser: vi.fn().mockResolvedValue({
        me: { user: { id: accountId }, workspaces: [] },
        tokenExpiresAt: new Date("2030-01-01T00:00:00.000Z"),
      }),
    } as never,
    browserAuth: { publicOrigin: PUBLIC_ORIGIN, refreshTokenTtlSeconds: 3600, secureCookies: true } as never,
    ...(options.registered === false ? {} : { stagingOnboardingLab: { reset } }),
  });
  apps.push(app);
  return { accountId, app, resetOnboarding };
}

function browserHeaders(extra: Record<string, string> = {}) {
  return {
    cookie: "opentag_access=account-token; opentag_csrf=csrf-token",
    origin: PUBLIC_ORIGIN,
    "x-opentag-csrf": "csrf-token",
    ...extra,
  };
}

describe("internal Onboarding Lab interface", () => {
  it("registers no Lab route when the deployment configures no Lab Account", async () => {
    const value = fixture({ registered: false });

    expect(value.app.hasRoute({ method: "GET", url: INTERNAL_ONBOARDING_LAB_PATH })).toBe(false);
    expect(value.app.hasRoute({ method: "POST", url: INTERNAL_ONBOARDING_LAB_PATH })).toBe(false);

    const [read, reset] = await Promise.all([
      value.app.inject({ method: "GET", url: INTERNAL_ONBOARDING_LAB_PATH, headers: browserHeaders() }),
      value.app.inject({ method: "POST", url: INTERNAL_ONBOARDING_LAB_PATH, headers: browserHeaders() }),
    ]);
    expect(read.statusCode).toBe(404);
    expect(reset.statusCode).toBe(404);
    expect(value.resetOnboarding).not.toHaveBeenCalled();
  });

  it("reports the reset half as available to the configured staging Lab Account", async () => {
    const value = fixture();

    const read = await value.app.inject({
      method: "GET",
      url: INTERNAL_ONBOARDING_LAB_PATH,
      headers: browserHeaders(),
    });

    expect(read.statusCode).toBe(200);
    expect(read.json()).toEqual({ reset: true });
  });

  it("offers Preview but no reset owner where staging configures no Lab Account", async () => {
    const value = fixture({ labAccountId: "unconfigured" });

    const [read, reset] = await Promise.all([
      value.app.inject({ method: "GET", url: INTERNAL_ONBOARDING_LAB_PATH, headers: browserHeaders() }),
      value.app.inject({ method: "POST", url: INTERNAL_ONBOARDING_LAB_PATH, headers: browserHeaders() }),
    ]);

    expect(read.statusCode).toBe(200);
    expect(read.json()).toEqual({ reset: false });
    expect(reset.statusCode).toBe(404);
    expect(value.resetOnboarding).not.toHaveBeenCalled();
  });

  it("resets the authenticated Account and never a client-selected Account", async () => {
    const value = fixture();

    const reset = await value.app.inject({
      method: "POST",
      url: INTERNAL_ONBOARDING_LAB_PATH,
      headers: { ...browserHeaders(), "content-type": "application/json" },
      payload: { accountId: randomUUID() },
    });

    expect(reset.statusCode).toBe(204);
    expect(value.resetOnboarding).toHaveBeenCalledExactlyOnceWith(value.accountId);
  });

  it("opens the read half to another Account while refusing that Account the reset", async () => {
    const value = fixture({ labAccountId: randomUUID() });

    const [read, reset] = await Promise.all([
      value.app.inject({ method: "GET", url: INTERNAL_ONBOARDING_LAB_PATH, headers: browserHeaders() }),
      value.app.inject({ method: "POST", url: INTERNAL_ONBOARDING_LAB_PATH, headers: browserHeaders() }),
    ]);

    expect(read.statusCode).toBe(200);
    expect(read.json()).toEqual({ reset: false });
    expect(reset.statusCode).toBe(404);
    expect(value.resetOnboarding).not.toHaveBeenCalled();
  });

  it("hides the Lab outside staging even when a route is registered", async () => {
    for (const environment of ["dev", "prod"] as const) {
      const value = fixture({ environment });

      const [read, reset] = await Promise.all([
        value.app.inject({ method: "GET", url: INTERNAL_ONBOARDING_LAB_PATH, headers: browserHeaders() }),
        value.app.inject({ method: "POST", url: INTERNAL_ONBOARDING_LAB_PATH, headers: browserHeaders() }),
      ]);

      expect(read.statusCode).toBe(404);
      expect(reset.statusCode).toBe(404);
      expect(value.resetOnboarding).not.toHaveBeenCalled();
    }
  });

  it("requires authentication", async () => {
    const value = fixture();

    const read = await value.app.inject({ method: "GET", url: INTERNAL_ONBOARDING_LAB_PATH });

    expect(read.statusCode).toBe(401);
    expect(value.resetOnboarding).not.toHaveBeenCalled();
  });

  it("reports a failed reset as a retryable deterministic error", async () => {
    const value = fixture();
    value.resetOnboarding.mockRejectedValueOnce(
      new OnboardingResetError("ONBOARDING_RESET_UNVERIFIED", 409, "The Account still has active OpenTag resources"),
    );

    const reset = await value.app.inject({
      method: "POST",
      url: INTERNAL_ONBOARDING_LAB_PATH,
      headers: browserHeaders(),
    });

    expect(reset.statusCode).toBe(409);
    expect(reset.json()).toMatchObject({
      error: {
        code: "ONBOARDING_RESET_UNVERIFIED",
        category: "deterministic",
        message: "The Account still has active OpenTag resources",
      },
    });
  });

  it("requires browser CSRF protection for the reset", async () => {
    const value = fixture();

    const [missingHeader, foreignOrigin] = await Promise.all([
      value.app.inject({
        method: "POST",
        url: INTERNAL_ONBOARDING_LAB_PATH,
        headers: { cookie: "opentag_access=account-token; opentag_csrf=csrf-token", origin: PUBLIC_ORIGIN },
      }),
      value.app.inject({
        method: "POST",
        url: INTERNAL_ONBOARDING_LAB_PATH,
        headers: browserHeaders({ origin: "https://attacker.example.com" }),
      }),
    ]);

    expect(missingHeader.statusCode).toBe(403);
    expect(foreignOrigin.statusCode).toBe(403);
    expect(value.resetOnboarding).not.toHaveBeenCalled();
  });
});
