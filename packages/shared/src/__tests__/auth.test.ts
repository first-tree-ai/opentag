import { describe, expect, it } from "vitest";
import {
  ConnectCodeExchangeRequestSchema,
  ConnectCodeExchangeResponseSchema,
  MeResponseSchema,
  RefreshTokenRequestSchema,
} from "../auth.js";

describe("auth contracts", () => {
  it("accepts connect exchange and token responses", () => {
    expect(ConnectCodeExchangeRequestSchema.parse({ code: "1234567890abcdef" })).toEqual({
      code: "1234567890abcdef",
    });
    expect(
      ConnectCodeExchangeResponseSchema.parse({
        accessToken: "access",
        refreshToken: "refresh",
        tokenType: "Bearer",
        expiresIn: 900,
      }),
    ).toEqual({ accessToken: "access", refreshToken: "refresh", tokenType: "Bearer", expiresIn: 900 });
  });

  it("rejects unexpected fields on every request", () => {
    expect(() => ConnectCodeExchangeRequestSchema.parse({ code: "1234567890abcdef", teamId: "authority" })).toThrow();
    expect(() => RefreshTokenRequestSchema.parse({ refreshToken: "token", role: "admin" })).toThrow();
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
          teamSlug: "example",
          teamDisplayName: "Example",
          role: "admin",
        },
      ],
    };

    expect(MeResponseSchema.parse(response)).toEqual(response);
    expect(() => MeResponseSchema.parse({ ...response, state: "active" })).toThrow();
  });
});
