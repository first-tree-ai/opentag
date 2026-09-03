import { describe, expect, it } from "vitest";
import { BootstrapAdminInputSchema } from "../admin/bootstrap.js";

const validInput = {
  displayName: "Bootstrap Admin",
  email: "admin@example.com",
};

describe("initial admin bootstrap contract", () => {
  it("uses the bounded user display-name contract", () => {
    expect(BootstrapAdminInputSchema.parse({ ...validInput, displayName: `  ${"a".repeat(255)}  ` })).toMatchObject({
      displayName: "a".repeat(255),
    });
    expect(() => BootstrapAdminInputSchema.parse({ ...validInput, displayName: "a".repeat(256) })).toThrow();
  });
});
