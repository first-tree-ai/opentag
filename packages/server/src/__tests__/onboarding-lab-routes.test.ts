import { randomUUID } from "node:crypto";
import { INTERNAL_ONBOARDING_LAB_PATH } from "@opentag/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { OnboardingResetError, OnboardingResetService } from "../services/onboarding-lab/index.js";
import { signedInBrowser } from "./signed-in-browser.js";

const PUBLIC_ORIGIN = "https://staging.example.com";
const apps: ReturnType<typeof createApp>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function fixture(options: { environment?: "dev" | "staging" | "prod"; registered?: boolean } = {}) {
  const accountId = randomUUID();
  const resetOnboarding = vi.fn().mockResolvedValue(undefined);
  const reboard = vi.fn().mockResolvedValue(undefined);
  const reset = new OnboardingResetService({
    agents: { suspendById: vi.fn(), deleteById: vi.fn() },
    database: {} as never,
    environment: options.environment ?? "staging",
  });
  vi.spyOn(reset, "resetOnboarding").mockImplementation(resetOnboarding);
  vi.spyOn(reset, "reboard").mockImplementation(reboard);
  const betterAuth = signedInBrowser(accountId, { publicUrl: PUBLIC_ORIGIN });
  const app = createApp({
    authService: {
      getActiveUserById: vi.fn().mockResolvedValue({ user: { id: accountId }, setupCompletedAt: null }),
    } as never,
    betterAuth,
    browserAuth: { publicOrigin: PUBLIC_ORIGIN, secureCookies: true, sessionTtlSeconds: 3600 } as never,
    ...(options.registered === false ? {} : { stagingOnboardingLab: { reset } }),
  });
  apps.push(app);
  return { accountId, app, reboard, resetOnboarding };
}

function resetRequest(mode: unknown, extra: Record<string, unknown> = {}) {
  return {
    method: "POST" as const,
    url: INTERNAL_ONBOARDING_LAB_PATH,
    headers: { ...browserHeaders(), "content-type": "application/json" },
    payload: { mode, ...extra },
  };
}

function browserHeaders(extra: Record<string, string> = {}) {
  return {
    cookie: "opentag.session_token=account-session; opentag_csrf=csrf-token",
    origin: PUBLIC_ORIGIN,
    "x-opentag-csrf": "csrf-token",
    ...extra,
  };
}

describe("internal Onboarding Lab interface", () => {
  it("registers no Lab route where the deployment offers no Lab at all", async () => {
    const value = fixture({ registered: false });

    expect(value.app.hasRoute({ method: "GET", url: INTERNAL_ONBOARDING_LAB_PATH })).toBe(false);
    expect(value.app.hasRoute({ method: "POST", url: INTERNAL_ONBOARDING_LAB_PATH })).toBe(false);

    const [read, reset] = await Promise.all([
      value.app.inject({ method: "GET", url: INTERNAL_ONBOARDING_LAB_PATH, headers: browserHeaders() }),
      value.app.inject(resetRequest("reset-all")),
    ]);
    expect(read.statusCode).toBe(404);
    expect(reset.statusCode).toBe(404);
    expect(value.resetOnboarding).not.toHaveBeenCalled();
    expect(value.reboard).not.toHaveBeenCalled();
  });

  it("answers any authenticated staging Account, since both halves are open to it", async () => {
    const value = fixture();

    const read = await value.app.inject({
      method: "GET",
      url: INTERNAL_ONBOARDING_LAB_PATH,
      headers: browserHeaders(),
    });

    expect(read.statusCode).toBe(204);
    expect(read.body).toBe("");
  });

  it("resets the authenticated Account and never a client-selected Account", async () => {
    const value = fixture();

    const reset = await value.app.inject(resetRequest("reset-all", { accountId: randomUUID() }));

    expect(reset.statusCode).toBe(204);
    expect(value.resetOnboarding).toHaveBeenCalledExactlyOnceWith(value.accountId);
  });

  it("passes each caller its own Account, so one tester's reset can never name another's", async () => {
    const first = fixture();
    const second = fixture();

    await Promise.all([
      first.app.inject(resetRequest("reset-all")),
      second.app.inject(resetRequest("reset-all", { accountId: first.accountId })),
    ]);

    expect(first.resetOnboarding).toHaveBeenCalledExactlyOnceWith(first.accountId);
    expect(second.resetOnboarding).toHaveBeenCalledExactlyOnceWith(second.accountId);
    expect(second.resetOnboarding).not.toHaveBeenCalledWith(first.accountId);
  });

  it("hides the Lab outside staging even when a route is registered", async () => {
    for (const environment of ["dev", "prod"] as const) {
      const value = fixture({ environment });

      const [read, reset] = await Promise.all([
        value.app.inject({ method: "GET", url: INTERNAL_ONBOARDING_LAB_PATH, headers: browserHeaders() }),
        value.app.inject(resetRequest("reset-all")),
      ]);

      expect(read.statusCode).toBe(404);
      expect(reset.statusCode).toBe(404);
      expect(value.resetOnboarding).not.toHaveBeenCalled();
      expect(value.reboard).not.toHaveBeenCalled();
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

    const reset = await value.app.inject(resetRequest("reset-all"));

    expect(reset.statusCode).toBe(409);
    expect(reset.json()).toMatchObject({
      error: {
        code: "ONBOARDING_RESET_UNVERIFIED",
        category: "deterministic",
        message: "The Account still has active OpenTag resources",
      },
    });
  });

  it("re-boards without destroying anything when the caller asks for the lighter mode", async () => {
    const value = fixture();

    const reboard = await value.app.inject(resetRequest("reboard", { accountId: randomUUID() }));

    expect(reboard.statusCode).toBe(204);
    expect(value.reboard).toHaveBeenCalledExactlyOnceWith(value.accountId);
    expect(value.resetOnboarding).not.toHaveBeenCalled();
  });

  it("refuses a request that names no mode rather than choosing the destructive one", async () => {
    const value = fixture();

    const [absent, empty] = await Promise.all([
      value.app.inject({
        method: "POST",
        url: INTERNAL_ONBOARDING_LAB_PATH,
        headers: { ...browserHeaders(), "content-type": "application/json" },
        payload: {},
      }),
      value.app.inject({ method: "POST", url: INTERNAL_ONBOARDING_LAB_PATH, headers: browserHeaders() }),
    ]);

    expect(absent.statusCode).toBe(400);
    expect(empty.statusCode).toBe(400);
    expect(absent.json()).toMatchObject({ error: { category: "validation", code: "VALIDATION_ERROR" } });
    expect(value.resetOnboarding).not.toHaveBeenCalled();
    expect(value.reboard).not.toHaveBeenCalled();
  });

  it("refuses a mode it does not recognise", async () => {
    const value = fixture();

    for (const mode of ["reset", "RESET-ALL", "", 1, null]) {
      const refused = await value.app.inject(resetRequest(mode));

      expect(refused.statusCode).toBe(400);
    }
    expect(value.resetOnboarding).not.toHaveBeenCalled();
    expect(value.reboard).not.toHaveBeenCalled();
  });

  it("requires browser CSRF protection for the reset", async () => {
    const value = fixture();

    const [missingHeader, foreignOrigin] = await Promise.all([
      value.app.inject({
        ...resetRequest("reset-all"),
        headers: {
          "content-type": "application/json",
          cookie: "opentag.session_token=account-session; opentag_csrf=csrf-token",
          origin: PUBLIC_ORIGIN,
        },
      }),
      value.app.inject({
        ...resetRequest("reset-all"),
        headers: { ...browserHeaders({ origin: "https://attacker.example.com" }), "content-type": "application/json" },
      }),
    ]);

    expect(missingHeader.statusCode).toBe(403);
    expect(foreignOrigin.statusCode).toBe(403);
    expect(value.resetOnboarding).not.toHaveBeenCalled();
  });
});
