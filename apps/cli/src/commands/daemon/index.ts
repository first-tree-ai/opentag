import type { Command } from "commander";
import { registerDaemonInstallCommand } from "./install.js";
import { registerDaemonRestartCommand } from "./restart.js";
import { registerDaemonServiceRunCommand } from "./service-run.js";
import { registerDaemonStartCommand } from "./start.js";
import { registerDaemonStatusCommand } from "./status.js";
import { registerDaemonStopCommand } from "./stop.js";
import { registerDaemonUninstallCommand } from "./uninstall.js";

export function registerDaemonCommand(program: Command): void {
  const daemon = program.command("daemon").description("Manage the OpenTag daemon service");
  registerDaemonInstallCommand(daemon);
  registerDaemonStartCommand(daemon);
  registerDaemonStopCommand(daemon);
  registerDaemonRestartCommand(daemon);
  registerDaemonStatusCommand(daemon);
  registerDaemonUninstallCommand(daemon);
  registerDaemonServiceRunCommand(daemon);
}
