import type { Command } from "commander";
import { runUpgrade } from "../core/update/manual-upgrade.js";

export function registerUpgradeCommand(program: Command): void {
  program
    .command("upgrade")
    .description("Upgrade OpenTag to the exact channel target (manual path; portable daemons upgrade automatically)")
    .option("--check", "Report the channel target without installing anything")
    .action(async (options: { check?: boolean }) => {
      const result = await runUpgrade({ check: options.check === true });
      const write = result.exitCode === 0 ? process.stdout : process.stderr;
      write.write(`${result.message}\n`);
      process.exitCode = result.exitCode;
    });
}
