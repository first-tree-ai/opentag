import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const EXPECTED_ROOT_EXPORTS = [
  "CommandError",
  "CHANNEL",
  "CLI_PACKAGE_NAME",
  "CLI_VERSION",
  "EXIT_CODES",
  "buildChildEnvironment",
  "channelConfig",
  "commandExitCode",
  "createProgram",
  "executeCommand",
  "formatAgent",
  "formatAgentCreated",
  "formatAgentList",
  "formatComputerList",
  "formatSessionCommandResult",
  "formatSessionList",
  "listComputers",
  "runAgentCreate",
  "runAgentDelete",
  "runAgentList",
  "runAgentShow",
  "runAgentUpdate",
  "runDoctor",
  "runLogin",
  "runProviderCliEnsure",
  "runProviderCliInspect",
  "runSessionCreate",
  "runSessionList",
  "runSessionSend",
  "presentCommand",
  "resolveCommandContext",
  "selectComputer",
  "toCommandError",
  "type CommandResult",
  "type DoctorOptions",
  "type DoctorResult",
  "type LoginOptions",
  "type LoginResult",
  "type ProviderCliEnsureCommandOptions",
  "type ProviderCliEnsureCommandResult",
  "type ProviderCliInspectCommandOptions",
  "type ProviderCliInspectCommandResult",
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
