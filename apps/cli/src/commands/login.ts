import { resolveOpenTagHome } from "@opentag/client";
import type { Command } from "commander";
import { runLogin } from "../core/auth/login.js";
import { channelConfig } from "../core/channel/config.js";

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
      const serverUrl = options.server ?? process.env.OPENTAG_SERVER_URL ?? channelConfig.defaultServerUrl;
      if (!serverUrl) {
        throw new Error(`The ${channelConfig.channel} channel requires --server for login`);
      }
      const result = await runLogin({
        code,
        home: options.home ?? resolveOpenTagHome(process.env),
        serverUrl,
      });
      process.stdout.write(`${result.message}\n`);
    });
}
