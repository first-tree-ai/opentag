import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerUpgradeCommand } from "../commands/upgrade.js";
import type { UpgradeResult } from "../core/update/manual-upgrade.js";
import * as manualUpgrade from "../core/update/manual-upgrade.js";

function upgradeResult(overrides: Partial<UpgradeResult>): UpgradeResult {
  return {
    exitCode: 0,
    currentVersion: "0.0.2",
    status: "up-to-date",
    installMode: "npm-global",
    message: "OpenTag 0.0.2 is the exact staging target",
    ...overrides,
  };
}

async function runUpgradeCommand(argv: readonly string[]) {
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const program = new Command().name("opentag");
  registerUpgradeCommand(program);
  await program.parseAsync(["node", "opentag", ...argv]);
  return { stdout, stderr };
}

describe("opentag upgrade command", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = 0;
  });

  it("prints a successful result to stdout and passes --check through", async () => {
    const runUpgrade = vi
      .spyOn(manualUpgrade, "runUpgrade")
      .mockResolvedValue(upgradeResult({ status: "available", targetVersion: "0.0.3", message: "0.0.3 is available" }));
    const { stdout, stderr } = await runUpgradeCommand(["upgrade", "--check"]);
    expect(runUpgrade).toHaveBeenCalledExactlyOnceWith({ check: true });
    expect(stdout).toHaveBeenCalledWith("0.0.3 is available\n");
    expect(stderr).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(0);
  });

  it("prints a failed result to stderr and sets the exit code", async () => {
    const runUpgrade = vi
      .spyOn(manualUpgrade, "runUpgrade")
      .mockResolvedValue(upgradeResult({ exitCode: 1, status: "error", message: "npm install failed" }));
    const { stdout, stderr } = await runUpgradeCommand(["upgrade"]);
    expect(runUpgrade).toHaveBeenCalledExactlyOnceWith({ check: false });
    expect(stderr).toHaveBeenCalledWith("npm install failed\n");
    expect(stdout).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});
