import { resolve } from "node:path";
import { resolveOpenTagHome } from "@opentag/client";
import type { Command } from "commander";
import { LoginServiceInstallError, runLoginWithService } from "../core/auth/login-service.js";
import { channelConfig } from "../core/channel/config.js";

interface LoginCommandOptions {
  home?: string;
  server?: string;
  start?: boolean;
}

interface LoginCommandDependencies {
  login?: typeof runLoginWithService;
  writeError?: (message: string) => void;
  writeOutput?: (message: string) => void;
}

export async function executeLoginCommand(
  code: string,
  options: LoginCommandOptions,
  dependencies: LoginCommandDependencies = {},
): Promise<0 | 1> {
  const serverUrl = options.server ?? process.env.OPENTAG_SERVER_URL ?? channelConfig.defaultServerUrl;
  if (!serverUrl) throw new Error(`The ${channelConfig.channel} channel requires --server for login`);
  const writeOutput = dependencies.writeOutput ?? ((message: string) => process.stdout.write(`${message}\n`));
  const writeError = dependencies.writeError ?? ((message: string) => process.stderr.write(`${message}\n`));
  try {
    const home = resolve(options.home ?? resolveOpenTagHome(process.env));
    const result = await (dependencies.login ?? runLoginWithService)({
      code,
      home,
      noStart: options.start === false,
      serverUrl,
    });
    writeOutput(result.message);
    if (result.service) writeOutput(`Daemon service ${result.service.serviceId} is ${result.service.state}`);
    return 0;
  } catch (error) {
    if (error instanceof LoginServiceInstallError) {
      writeOutput(error.loginResult.message);
      writeError(
        `Daemon service installation failed; credentials were preserved. Run ${channelConfig.binName} daemon install to retry.`,
      );
      return 1;
    }
    throw error;
  }
}

export function registerLoginCommand(program: Command): void {
  program
    .command("login")
    .description("Exchange a one-time connect code and store private credentials")
    .argument("<code>", "one-time connect code")
    .option("--server <url>", "OpenTag server URL")
    .option("--home <path>", "OpenTag home directory")
    .option("--no-start", "store credentials without installing the daemon service")
    .action(async (code: string, options: LoginCommandOptions) => {
      process.exitCode = await executeLoginCommand(code, options);
    });
}
