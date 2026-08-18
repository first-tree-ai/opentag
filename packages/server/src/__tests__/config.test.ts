import { describe, expect, it } from "vitest";
import { parseDatabaseConfig, parseServerConfig } from "../config.js";

const required = {
  OPENTAG_DATABASE_URL: "postgresql://opentag:opentag@localhost:5432/opentag",
  OPENTAG_JWT_SECRET: "a-secret-that-is-at-least-32-characters",
};

describe("parseServerConfig", () => {
  it("applies safe local defaults", () => {
    expect(parseServerConfig(required)).toMatchObject({
      accessTokenTtlSeconds: 900,
      autoMigrate: true,
      host: "127.0.0.1",
      port: 8000,
      refreshTokenTtlSeconds: 2_592_000,
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
