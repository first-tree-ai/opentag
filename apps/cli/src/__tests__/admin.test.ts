import { describe, expect, it } from "vitest";
import { createProgram } from "../cli/program.js";

describe("retired Admin commands", () => {
  it("does not advertise an admin command", () => {
    const program = createProgram();

    expect(program.commands.map((command) => command.name())).not.toContain("admin");
    expect(program.helpInformation()).not.toMatch(/\badmin\b/);
  });

  it("rejects admin as an unknown command", async () => {
    const program = createProgram().exitOverride();
    let stderr = "";
    program.configureOutput({
      writeErr: (message) => {
        stderr += message;
      },
      writeOut: () => undefined,
    });

    await expect(program.parseAsync(["node", "opentag", "admin"])).rejects.toMatchObject({
      code: "commander.unknownCommand",
    });
    expect(stderr).toContain("error: unknown command 'admin'");
  });
});
