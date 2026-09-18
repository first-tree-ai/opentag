import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseServerConfig } from "../config.js";

const required = {
  BETTER_AUTH_SECRET: "a-better-auth-secret-of-at-least-32-characters",
  OPENTAG_DATABASE_URL: "postgresql://opentag:opentag@localhost:5432/opentag",
  OPENTAG_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  OPENTAG_JWT_SECRET: "a-secret-that-is-at-least-32-characters",
  OPENTAG_PUBLIC_URL: "http://localhost:8000",
};

const ACCOUNT = randomUUID();

describe("web tools server config", () => {
  it("is disabled by default with no Router wiring", () => {
    const config = parseServerConfig(required);
    expect(config.web).toEqual({ enabled: false });
  });

  it("resolves tenant keys from referenced secret variables only when enabled", () => {
    const config = parseServerConfig({
      ...required,
      OPENTAG_WEB_ENABLED: "true",
      OPENTAG_WEB_ROUTER_BASE_URL: "https://router.internal",
      OPENTAG_WEB_ROUTER_TENANTS: JSON.stringify([
        { accountId: ACCOUNT, tenantId: "internal-test", keyEnv: "OPENTAG_WEB_ROUTER_KEY_INTERNAL" },
      ]),
      OPENTAG_WEB_ROUTER_KEY_INTERNAL: "tvly-test-secret",
    });
    expect(config.web.enabled).toBe(true);
    if (config.web.enabled) {
      expect(config.web.routerBaseUrl).toBe("https://router.internal");
      expect(config.web.tenants.get(ACCOUNT)).toEqual({ tenantId: "internal-test", routerKey: "tvly-test-secret" });
    }
  });

  it("requires the Router origin and at least one tenant mapping when enabled", () => {
    expect(() => parseServerConfig({ ...required, OPENTAG_WEB_ENABLED: "true" })).toThrow(
      /ROUTER_BASE_URL|Router origin/,
    );
    expect(() =>
      parseServerConfig({
        ...required,
        OPENTAG_WEB_ENABLED: "true",
        OPENTAG_WEB_ROUTER_BASE_URL: "https://router.internal",
      }),
    ).toThrow(/TENANTS|tenant mapping/);
  });

  it("rejects credential-bearing or pathed Router origins", () => {
    for (const bad of ["https://user:pass@router.internal", "https://router.internal/v1", "ftp://router.internal"]) {
      expect(() =>
        parseServerConfig({
          ...required,
          OPENTAG_WEB_ENABLED: "true",
          OPENTAG_WEB_ROUTER_BASE_URL: bad,
          OPENTAG_WEB_ROUTER_TENANTS: JSON.stringify([
            { accountId: ACCOUNT, tenantId: "t", keyEnv: "OPENTAG_WEB_ROUTER_KEY_A" },
          ]),
          OPENTAG_WEB_ROUTER_KEY_A: "k",
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
        OPENTAG_WEB_ROUTER_TENANTS: JSON.stringify([
          { accountId: ACCOUNT, tenantId: "t", keyEnv: "OPENTAG_WEB_ROUTER_KEY_A" },
        ]),
        OPENTAG_WEB_ROUTER_KEY_A: "k",
      }),
    ).toThrow(/HTTPS/);
  });

  it("fails startup when a referenced key variable is missing or malformed", () => {
    expect(() =>
      parseServerConfig({
        ...required,
        OPENTAG_WEB_ENABLED: "true",
        OPENTAG_WEB_ROUTER_BASE_URL: "https://router.internal",
        OPENTAG_WEB_ROUTER_TENANTS: JSON.stringify([
          { accountId: ACCOUNT, tenantId: "t", keyEnv: "OPENTAG_WEB_ROUTER_KEY_A" },
        ]),
      }),
    ).toThrow(/key variable/);
    expect(() =>
      parseServerConfig({
        ...required,
        OPENTAG_WEB_ENABLED: "true",
        OPENTAG_WEB_ROUTER_BASE_URL: "https://router.internal",
        OPENTAG_WEB_ROUTER_TENANTS: JSON.stringify([
          { accountId: ACCOUNT, tenantId: "t", keyEnv: "OPENTAG_WEB_ROUTER_KEY_A" },
        ]),
        OPENTAG_WEB_ROUTER_KEY_A: " padded ",
      }),
    ).toThrow(/key variable/);
  });

  it("rejects duplicate Accounts, shared key variables, and malformed mappings", () => {
    const enabled = {
      ...required,
      OPENTAG_WEB_ENABLED: "true",
      OPENTAG_WEB_ROUTER_BASE_URL: "https://router.internal",
    };
    expect(() =>
      parseServerConfig({
        ...enabled,
        OPENTAG_WEB_ROUTER_TENANTS: JSON.stringify([
          { accountId: ACCOUNT, tenantId: "a", keyEnv: "OPENTAG_WEB_ROUTER_KEY_A" },
          { accountId: ACCOUNT, tenantId: "b", keyEnv: "OPENTAG_WEB_ROUTER_KEY_B" },
        ]),
      }),
    ).toThrow(/Duplicate/);
    expect(() =>
      parseServerConfig({
        ...enabled,
        OPENTAG_WEB_ROUTER_TENANTS: JSON.stringify([
          { accountId: ACCOUNT, tenantId: "a", keyEnv: "OPENTAG_WEB_ROUTER_KEY_A" },
          { accountId: randomUUID(), tenantId: "b", keyEnv: "OPENTAG_WEB_ROUTER_KEY_A" },
        ]),
      }),
    ).toThrow(/share one key variable/);
    expect(() =>
      parseServerConfig({
        ...enabled,
        OPENTAG_WEB_ROUTER_TENANTS: JSON.stringify([
          { accountId: ACCOUNT, tenantId: "a", keyEnv: "OPENTAG_WEB_ROUTER_KEY_A", key: "inline" },
        ]),
      }),
    ).toThrow();
    expect(() => parseServerConfig({ ...enabled, OPENTAG_WEB_ROUTER_TENANTS: "not json" })).toThrow(/JSON/);
  });

  it("validates tenant shape but stays disabled-tolerant when off", () => {
    expect(() =>
      parseServerConfig({
        ...required,
        OPENTAG_WEB_ROUTER_TENANTS: JSON.stringify([
          { accountId: "not-a-uuid", tenantId: "t", keyEnv: "OPENTAG_WEB_ROUTER_KEY_A" },
        ]),
      }),
    ).toThrow();
    // A disabled deployment may carry staged mapping config without requiring key material.
    const config = parseServerConfig({
      ...required,
      OPENTAG_WEB_ROUTER_TENANTS: JSON.stringify([
        { accountId: ACCOUNT, tenantId: "t", keyEnv: "OPENTAG_WEB_ROUTER_KEY_A" },
      ]),
    });
    expect(config.web.enabled).toBe(false);
  });
});
