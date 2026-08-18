import { resolveOpenTagHome } from "@opentag/client";
import type { Command } from "commander";
import { runLogin } from "../core/login.js";

interface LoginCommandOptions {
  home?: string;
  server?: string;
}

export function registerLoginCommand(program: Command): void {
  program
    .command("login")
    .description("Exchange a one-time connect code and store private credentials")
    .argument("<code>", "one-time connect code")
    .option("--server <url>", "OpenTag server URL")
    .option("--home <path>", "OpenTag home directory")
    .action(async (code: string, options: LoginCommandOptions) => {
      const serverUrl = options.server ?? process.env.OPENTAG_SERVER_URL ?? "http://127.0.0.1:8000";
      const result = await runLogin({
        code,
        home: options.home ?? resolveOpenTagHome(process.env),
        serverUrl,
      });
      process.stdout.write(`${result.message}\n`);
    });
}
