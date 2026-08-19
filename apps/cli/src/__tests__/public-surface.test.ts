import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const EXPECTED_ROOT_EXPORTS = [
  "CHANNEL",
  "CLI_PACKAGE_NAME",
  "CLI_VERSION",
  "channelConfig",
  "createProgram",
  "formatAgent",
  "formatAgentCreated",
  "formatAgentList",
  "formatComputerList",
  "listComputers",
  "resolveServerUrl",
  "runAgentCreate",
  "runAgentDelete",
  "runAgentList",
  "runAgentShow",
  "runAgentUpdate",
  "runDoctor",
  "runLogin",
  "selectComputer",
  "selectTeam",
  "type DoctorOptions",
  "type DoctorResult",
  "type LoginOptions",
  "type LoginResult",
];

describe("CLI package public surface", () => {
  it("keeps the root exports stable across internal source moves", async () => {
    const source = await readFile(new URL("../index.ts", import.meta.url), "utf8");
    const exports = [...source.matchAll(/export\s*\{([\s\S]*?)\}\s*from/g)]
      .flatMap((match) => (match[1] ?? "").split(","))
      .map((entry) => entry.replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .sort();

    expect(exports).toEqual([...EXPECTED_ROOT_EXPORTS].sort());
  });
});
