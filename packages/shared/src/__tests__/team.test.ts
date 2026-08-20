import { describe, expect, it } from "vitest";
import {
  CreateTeamRequestSchema,
  CreateTeamResponseSchema,
  ListTeamComputersResponseSchema,
  TeamMemberAdminConfigSchema,
  TeamMemberSummarySchema,
  UpdateTeamProfileRequestSchema,
} from "../index.js";

describe("Team contracts", () => {
  it("keeps membership role and lifecycle as separate strict fields", () => {
    expect(
      TeamMemberAdminConfigSchema.parse({
        teamId: "d3fda800-7ce2-4338-aae8-3d2120401ed6",
        userId: "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e",
        email: "member@example.com",
        displayName: "Member",
        role: "member",
        status: "left",
        createdAt: "2026-08-19T00:00:00.000Z",
        updatedAt: "2026-08-19T00:00:00.000Z",
      }),
    ).toMatchObject({ role: "member", status: "left" });
  });

  it("requires explicit observation time for Computer connection snapshots", () => {
    expect(() => ListTeamComputersResponseSchema.parse({ computers: [{ id: crypto.randomUUID() }] })).toThrow();
  });

  it("rejects admin-only membership fields from the member-safe projection", () => {
    expect(() =>
      TeamMemberSummarySchema.parse({
        userId: "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e",
        displayName: "Member",
        role: "member",
        email: "member@example.com",
      }),
    ).toThrow();
  });

  it("normalizes partial Team profile updates and requires at least one field", () => {
    expect(UpdateTeamProfileRequestSchema.parse({ name: "  First-Tree  " })).toEqual({ name: "first-tree" });
    expect(UpdateTeamProfileRequestSchema.parse({ displayName: "  First Tree AI  " })).toEqual({
      displayName: "First Tree AI",
    });
    expect(() => UpdateTeamProfileRequestSchema.parse({})).toThrow();
    expect(() => UpdateTeamProfileRequestSchema.parse({ name: "not url safe" })).toThrow();
    expect(() => UpdateTeamProfileRequestSchema.parse({ displayName: "   " })).toThrow();
  });

  it("normalizes a Team creation request into a canonical slug and trimmed display name", () => {
    expect(CreateTeamRequestSchema.parse({ name: "  First-Tree  ", displayName: "  First Tree AI  " })).toEqual({
      name: "first-tree",
      displayName: "First Tree AI",
    });
  });

  it("rejects Team creation names that are not URL-safe slugs", () => {
    for (const name of ["not url safe", "-leading-hyphen", "trailing_underscore", "", "a".repeat(65)]) {
      expect(() => CreateTeamRequestSchema.parse({ name, displayName: "Example" })).toThrow();
    }
  });

  it("requires both Team creation fields and rejects unknown ones", () => {
    expect(() => CreateTeamRequestSchema.parse({ name: "example" })).toThrow();
    expect(() => CreateTeamRequestSchema.parse({ displayName: "Example" })).toThrow();
    expect(() => CreateTeamRequestSchema.parse({ name: "example", displayName: "   " })).toThrow();
    expect(() => CreateTeamRequestSchema.parse({ name: "example", displayName: "Example", role: "admin" })).toThrow();
  });

  it("returns the created Team with the caller already holding the admin role", () => {
    const created = {
      id: "d3fda800-7ce2-4338-aae8-3d2120401ed6",
      name: "first-tree",
      displayName: "First Tree AI",
      role: "admin",
      createdAt: "2026-08-20T00:00:00.000Z",
      updatedAt: "2026-08-20T00:00:00.000Z",
    };
    expect(CreateTeamResponseSchema.parse(created)).toEqual(created);
    expect(() => CreateTeamResponseSchema.parse({ ...created, role: "owner" })).toThrow();
  });
});
