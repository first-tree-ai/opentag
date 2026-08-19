import { describe, expect, it } from "vitest";
import { parseDatabaseConfig, parseServerConfig } from "../config.js";

const required = {
  OPENTAG_DATABASE_URL: "postgresql://opentag:opentag@localhost:5432/opentag",
  OPENTAG_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  OPENTAG_JWT_SECRET: "a-secret-that-is-at-least-32-characters",
  OPENTAG_PUBLIC_URL: "http://localhost:8000",
};

describe("parseServerConfig", () => {
  it("applies safe local defaults", () => {
    expect(parseServerConfig(required)).toMatchObject({
      accessTokenTtlSeconds: 900,
      autoMigrate: true,
      host: "127.0.0.1",
      publicUrl: "http://localhost:8000",
      port: 8000,
      refreshTokenTtlSeconds: 2_592_000,
    });
  });

  it("requires complete Google configuration and HTTPS in production", () => {
    expect(() => parseServerConfig({ ...required, OPENTAG_GOOGLE_CLIENT_ID: "client" })).toThrow();
    expect(() => parseServerConfig({ ...required, OPENTAG_ENV: "production" })).toThrow();
    expect(
      parseServerConfig({
        ...required,
        OPENTAG_ENV: "production",
        OPENTAG_PUBLIC_URL: "https://opentag.example.com",
        OPENTAG_GOOGLE_CLIENT_ID: "client",
        OPENTAG_GOOGLE_CLIENT_SECRET: "secret",
      }),
    ).toMatchObject({
      environment: "production",
      google: { clientId: "client", clientSecret: "secret" },
      publicUrl: "https://opentag.example.com",
    });
  });

  it("rejects invalid ports, secrets, and database protocols", () => {
    expect(() => parseServerConfig({ ...required, OPENTAG_PORT: "0" })).toThrow();
    expect(() => parseServerConfig({ ...required, OPENTAG_JWT_SECRET: "short" })).toThrow();
    expect(() => parseServerConfig({ ...required, OPENTAG_DATABASE_URL: "https://example.com" })).toThrow();
  });

  it("allows migration commands to parse only their database dependency", () => {
    expect(parseDatabaseConfig({ OPENTAG_DATABASE_URL: required.OPENTAG_DATABASE_URL })).toMatchObject({
      databaseUrl: required.OPENTAG_DATABASE_URL,
    });
  });
});
