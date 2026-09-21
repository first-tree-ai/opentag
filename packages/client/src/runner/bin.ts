import { runRunnerCli } from "./cli.js";
import { installRunnerSignalHandlers } from "./signals.js";

installRunnerSignalHandlers();

process.exitCode = await runRunnerCli(process.argv.slice(2), {
  env: process.env,
  stderr: process.stderr,
  stdout: process.stdout,
});
