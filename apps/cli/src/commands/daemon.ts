import type { Command } from "commander";
import { runDaemon } from "../core/daemon-run.js";

export function registerDaemonCommand(program: Command): void {
  const daemon = program.command("daemon").description("Run the local OpenTag Client Runtime");
  daemon
    .command("run")
    .description("Run the daemon in the foreground")
    .action(async () => runDaemon());
}
