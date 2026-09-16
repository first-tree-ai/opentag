import { expect, it } from "vitest";
import { createProgram } from "../cli/program.js";

it("does not expose the removed Computer-wide Context Tree command", () => {
  expect(createProgram().commands.map((command) => command.name())).not.toContain("context-tree");
});
