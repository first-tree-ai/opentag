import { describe, expect, it } from "vitest";
import {
  AuthProvidersResponseSchema,
  ConnectCodeExchangeRequestSchema,
  ConnectCodeExchangeResponseSchema,
  ConnectCodeIssueResponseSchema,
  MeResponseSchema,
  RefreshTokenRequestSchema,
  TeamNameSchema,
} from "../auth.js";

describe("auth contracts", () => {
  it("accepts connect exchange and token responses", () => {
    expect(ConnectCodeExchangeRequestSchema.parse({ code: "1234567890abcdef" })).toEqual({
      code: "1234567890abcdef",
    });
    expect(
      ConnectCodeExchangeRequestSchema.parse({
        code: "1234567890abcdef",
        expectedUserId: "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e",
      }),
    ).toMatchObject({ expectedUserId: "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e" });
    expect(
      ConnectCodeExchangeResponseSchema.parse({
        accessToken: "access",
        refreshToken: "refresh",
        tokenType: "Bearer",
        expiresIn: 900,
      }),
    ).toEqual({ accessToken: "access", refreshToken: "refresh", tokenType: "Bearer", expiresIn: 900 });
  });

  it("accepts only the server-authored connect command contract", () => {
    const response = {
      bootstrapCommand: "npm i -g open-tag && opentag login --server https://opentag.example.com -- code",
      expiresIn: 900,
      issuedAt: "2030-01-01T00:00:00.000Z",
    };
    expect(ConnectCodeIssueResponseSchema.parse(response)).toEqual(response);
    expect(() => ConnectCodeIssueResponseSchema.parse({ ...response, code: "plaintext" })).toThrow();
  });

  it("rejects unexpected fields on every request", () => {
    expect(() => ConnectCodeExchangeRequestSchema.parse({ code: "1234567890abcdef", teamId: "authority" })).toThrow();
    expect(() => RefreshTokenRequestSchema.parse({ refreshToken: "token", role: "admin" })).toThrow();
  });

  it("enforces canonical team names", () => {
    expect(TeamNameSchema.parse("first-tree-1")).toBe("first-tree-1");
    for (const invalid of ["", "Example", "example team", "example_team"]) {
      expect(() => TeamNameSchema.parse(invalid)).toThrow();
    }
  });

  it("validates the current user and live memberships response", () => {
    const response = {
      user: {
        id: "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e",
        email: "admin@example.com",
        displayName: "Admin",
      },
      memberships: [
        {
          teamId: "d3fda800-7ce2-4338-aae8-3d2120401ed6",
          teamName: "example",
          teamDisplayName: "Example",
          role: "admin",
        },
      ],
    };

    expect(MeResponseSchema.parse(response)).toEqual(response);
    expect(() => MeResponseSchema.parse({ ...response, state: "active" })).toThrow();
  });

  it("publishes Google and local-development browser provider availability", () => {
    expect(
      AuthProvidersResponseSchema.parse({
        providers: [
          { id: "google", enabled: false, startUrl: null },
          { id: "dev", enabled: true, startUrl: "/api/v1/auth/dev/callback" },
        ],
      }),
    ).toMatchObject({ providers: [{ id: "google" }, { id: "dev" }] });
    expect(() =>
      AuthProvidersResponseSchema.parse({ providers: [{ id: "password", enabled: true, startUrl: "/login" }] }),
    ).toThrow();
  });
});
