import { describe, expect, it } from "vitest";
import {
  AuthProvidersResponseSchema,
  ConnectCodeExchangeRequestSchema,
  ConnectCodeExchangeResponseSchema,
  ConnectCodeIssueResponseSchema,
  MeResponseSchema,
  RefreshTokenRequestSchema,
  UpdateUserProfileRequestSchema,
  UserDisplayNameSchema,
  UserProfileSchema,
  WorkspaceNameSchema,
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
    expect(() =>
      ConnectCodeExchangeRequestSchema.parse({ code: "1234567890abcdef", workspaceId: "authority" }),
    ).toThrow();
    expect(() => RefreshTokenRequestSchema.parse({ refreshToken: "token", role: "admin" })).toThrow();
  });

  it("enforces canonical workspace names", () => {
    expect(WorkspaceNameSchema.parse("first-tree-1")).toBe("first-tree-1");
    for (const invalid of ["", "Example", "example workspace", "example_workspace"]) {
      expect(() => WorkspaceNameSchema.parse(invalid)).toThrow();
    }
  });

  it("validates the current Account without a management Workspace projection", () => {
    const response = {
      user: {
        id: "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e",
        email: "admin@example.com",
        displayName: "Admin",
      },
      setupCompletedAt: null,
    };

    expect(MeResponseSchema.parse(response)).toEqual(response);
    expect(MeResponseSchema.parse({ ...response, setupCompletedAt: "2026-08-20T00:00:00.000Z" })).toEqual({
      ...response,
      setupCompletedAt: "2026-08-20T00:00:00.000Z",
    });
    expect(() => MeResponseSchema.parse({ ...response, workspaces: [] })).toThrow();
    expect(() => MeResponseSchema.parse({ ...response, state: "active" })).toThrow();
  });

  it("normalizes strict self-profile updates", () => {
    expect(UpdateUserProfileRequestSchema.parse({ displayName: "  Ada Lovelace  " })).toEqual({
      displayName: "Ada Lovelace",
    });
    expect(() => UpdateUserProfileRequestSchema.parse({ displayName: "   " })).toThrow();
    expect(() => UpdateUserProfileRequestSchema.parse({ displayName: "a".repeat(256) })).toThrow();
    expect(() => UpdateUserProfileRequestSchema.parse({ displayName: "Ada", userId: "caller-authority" })).toThrow();
  });

  it("shares one bounded user display-name contract across writers", () => {
    expect(UserDisplayNameSchema.parse(`  ${"a".repeat(255)}  `)).toBe("a".repeat(255));
    expect(() => UserDisplayNameSchema.parse("a".repeat(256))).toThrow();
  });

  it("validates the shared user profile response", () => {
    const profile = {
      id: "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e",
      email: "admin@example.com",
      displayName: "Admin",
    };
    expect(UserProfileSchema.parse(profile)).toEqual(profile);
    expect(() => UserProfileSchema.parse({ ...profile, displayName: "a".repeat(256) })).toThrow();
  });

  it("publishes Google, local-development, and password browser provider availability", () => {
    expect(
      AuthProvidersResponseSchema.parse({
        providers: [
          { id: "google", enabled: false, startUrl: null },
          { id: "dev", enabled: true, startUrl: "/api/v1/auth/dev/callback" },
          // A form rather than a link, so it is the one provider that is enabled and still has no URL to start it.
          { id: "password", enabled: true, startUrl: null },
        ],
      }),
    ).toMatchObject({ providers: [{ id: "google" }, { id: "dev" }, { id: "password", startUrl: null }] });
    expect(() =>
      AuthProvidersResponseSchema.parse({ providers: [{ id: "saml", enabled: true, startUrl: "/login" }] }),
    ).toThrow();
  });
});
