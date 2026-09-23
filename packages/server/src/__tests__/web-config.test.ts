import { describe, expect, it } from "vitest";
import { parseServerConfig } from "../config.js";

const required = {
  BETTER_AUTH_SECRET: "a-better-auth-secret-of-at-least-32-characters",
  OPENTAG_DATABASE_URL: "postgresql://opentag:opentag@localhost:5432/opentag",
  OPENTAG_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  OPENTAG_JWT_SECRET: "a-secret-that-is-at-least-32-characters",
  OPENTAG_PUBLIC_URL: "http://localhost:8000",
};

describe("web tools server config", () => {
  it("is disabled by default with no Router wiring", () => {
    const config = parseServerConfig(required);
    expect(config.web).toEqual({ enabled: false });
  });

  it("resolves one deployment-wide Router web-only key when enabled", () => {
    const config = parseServerConfig({
      ...required,
      OPENTAG_WEB_ENABLED: "true",
      OPENTAG_WEB_ROUTER_BASE_URL: "https://router.internal",
      OPENTAG_WEB_ROUTER_KEY: "tvly-test-secret",
    });
    expect(config.web.enabled).toBe(true);
    if (config.web.enabled) {
      expect(config.web.routerBaseUrl).toBe("https://router.internal");
      expect(config.web.routerKey).toBe("tvly-test-secret");
    }
  });

  it("requires the Router origin and the Router key when enabled", () => {
    expect(() => parseServerConfig({ ...required, OPENTAG_WEB_ENABLED: "true" })).toThrow(
      /ROUTER_BASE_URL|Router origin/,
    );
    expect(() =>
      parseServerConfig({
        ...required,
        OPENTAG_WEB_ENABLED: "true",
        OPENTAG_WEB_ROUTER_BASE_URL: "https://router.internal",
      }),
    ).toThrow(/ROUTER_KEY|Router key/);
  });

  it("rejects credential-bearing or pathed Router origins", () => {
    for (const bad of ["https://user:pass@router.internal", "https://router.internal/v1", "ftp://router.internal"]) {
      expect(() =>
        parseServerConfig({
          ...required,
          OPENTAG_WEB_ENABLED: "true",
          OPENTAG_WEB_ROUTER_BASE_URL: bad,
          OPENTAG_WEB_ROUTER_KEY: "k",
        }),
      ).toThrow();
    }
  });

  it("requires HTTPS for the Router origin in hosted environments", () => {
    expect(() =>
      parseServerConfig({
        ...required,
        OPENTAG_ENV: "prod",
        OPENTAG_PUBLIC_URL: "https://app.example.com",
        OPENTAG_WEB_ENABLED: "true",
        OPENTAG_WEB_ROUTER_BASE_URL: "http://router.internal",
        OPENTAG_WEB_ROUTER_KEY: "k",
      }),
    ).toThrow(/HTTPS/);
  });

  it("fails startup when the Router key is missing, empty, or malformed", () => {
    const enabled = {
      ...required,
      OPENTAG_WEB_ENABLED: "true",
      OPENTAG_WEB_ROUTER_BASE_URL: "https://router.internal",
    };
    expect(() => parseServerConfig(enabled)).toThrow(/ROUTER_KEY/);
    // An explicitly empty variable is indistinguishable from an absent one.
    expect(() => parseServerConfig({ ...enabled, OPENTAG_WEB_ROUTER_KEY: "" })).toThrow(/ROUTER_KEY/);
  });

  it("tolerates a staged base URL while disabled and never reads a key", () => {
    const config = parseServerConfig({
      ...required,
      OPENTAG_WEB_ROUTER_BASE_URL: "https://router.internal",
      OPENTAG_WEB_ROUTER_KEY: "staged-but-unused",
    });
    expect(config.web.enabled).toBe(false);
  });

  it("fails closed for a deployment that still carries only the removed tenant mapping", () => {
    // The per-Account map is gone. A deployment that left the old variable set and enabled web
    // tools has no Router key, so startup refuses instead of silently serving a stale config.
    expect(() =>
      parseServerConfig({
        ...required,
        OPENTAG_WEB_ENABLED: "true",
        OPENTAG_WEB_ROUTER_BASE_URL: "https://router.internal",
        OPENTAG_WEB_ROUTER_TENANTS: JSON.stringify([
          { accountId: "00000000-0000-4000-8000-000000000001", tenantId: "t", keyEnv: "OPENTAG_WEB_ROUTER_KEY_A" },
        ]),
        OPENTAG_WEB_ROUTER_KEY_A: "k",
      }),
    ).toThrow(/ROUTER_KEY/);
  });
});
