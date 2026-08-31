import { resolve } from "node:path";
import { resolveOpenTagHome } from "@opentag/client";
import type { Command } from "commander";
import { runLogin } from "../core/auth/login.js";
import { channelConfig } from "../core/channel/config.js";
import { resolveChannelEnvironment } from "../core/channel/environment.js";
import { executeCommand } from "../core/command/policy.js";

interface LoginCommandOptions {
  home?: string;
  server?: string;
  json?: boolean;
}

interface LoginCommandDependencies {
  login?: typeof runLogin;
  writeError?: (message: string) => void;
  writeOutput?: (message: string) => void;
}

export async function executeLoginCommand(
  code: string,
  options: LoginCommandOptions,
  dependencies: LoginCommandDependencies = {},
): Promise<0 | 1> {
  const environment = resolveChannelEnvironment(process.env);
  const serverUrl = options.server ?? environment.OPENTAG_SERVER_URL ?? channelConfig.defaultServerUrl;
  if (!serverUrl) throw new Error(`The ${channelConfig.channel} channel requires --server for login`);
  const writeOutput = dependencies.writeOutput ?? ((message: string) => process.stdout.write(`${message}\n`));
  const home = resolve(options.home ?? resolveOpenTagHome(environment));
  const result = await (dependencies.login ?? runLogin)({
    code,
    home,
    serverUrl,
  });
  writeOutput(result.message);
  return 0;
}

export function registerLoginCommand(program: Command, dependencies: LoginCommandDependencies = {}): void {
  program
    .command("login")
    .description("Exchange a one-time Account login code and store Account credentials")
    .argument("<code>", "one-time Account login code")
    .option("--server <url>", "OpenTag server URL")
    .option("--home <path>", "OpenTag home directory")
    .option("--json", "print JSON")
    .action(async (code: string, options: LoginCommandOptions) => {
      process.exitCode = await executeCommand(
        async () => {
          const output: string[] = [];
          await executeLoginCommand(code, options, { ...dependencies, writeOutput: (message) => output.push(message) });
          return output.join("\n");
        },
        { json: options.json === true, phase: "authentication" },
      );
    });
}
