import { describe, expect, it } from "vitest";
import { createProgram } from "../cli/program.js";

describe("Admin commands", () => {
  it("keeps list and revoke without exposing invitation issuance", () => {
    const admin = createProgram().commands.find((command) => command.name() === "admin");

    expect(admin?.commands.map((command) => command.name())).toEqual(["list", "revoke"]);
  });
});
