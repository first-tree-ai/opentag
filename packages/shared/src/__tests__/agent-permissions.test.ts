import { describe, expect, it } from "vitest";
import { AdditionalAllowedCommandSchema, AgentPermissionsSchema } from "../agent-permissions.js";
import { UpdateSelfAgentRequestSchema } from "../agent-self.js";

describe("Agent permissions", () => {
  it("defaults to on-request approvals and keeps permissions outside Agent self-configuration", () => {
    const permissions = AgentPermissionsSchema.parse({});
    expect(permissions).toEqual({ approvalPolicy: "on-request", allowCommands: [] });
    expect(AgentPermissionsSchema.parse({ approvalPolicy: "never" })).toEqual({
      approvalPolicy: "never",
      allowCommands: [],
    });
    expect(AgentPermissionsSchema.safeParse({ ...permissions, rules: "[]" }).success).toBe(false);
    expect(AgentPermissionsSchema.safeParse({ ...permissions, approverExternalId: "owner" }).success).toBe(false);
    expect(
      UpdateSelfAgentRequestSchema.safeParse({ expectedRevision: 1, runtimeConfig: { permissions } }).success,
    ).toBe(false);
  });

  it("accepts literal command prefixes without shell syntax", () => {
    expect(AdditionalAllowedCommandSchema.parse(" git status ")).toBe("git status");
    expect(AdditionalAllowedCommandSchema.parse("docker compose ps")).toBe("docker compose ps");
    for (const command of ["git *", "git status && rm -rf /", "", "git  status", "echo $HOME"]) {
      expect(AdditionalAllowedCommandSchema.safeParse(command).success).toBe(false);
    }
  });
});
