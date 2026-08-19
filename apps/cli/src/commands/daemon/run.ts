import type { Command } from "commander";
import { runDaemon } from "../../core/daemon/runtime.js";

export function registerDaemonRunCommand(daemon: Command): void {
  daemon
    .command("run")
    .description("Run the daemon in the foreground")
    .action(async () => runDaemon());
}
