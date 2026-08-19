import type { Command } from "commander";
import { registerDaemonRunCommand } from "./run.js";

export function registerDaemonCommand(program: Command): void {
  const daemon = program.command("daemon").description("Run the local OpenTag Client Runtime");
  registerDaemonRunCommand(daemon);
}
