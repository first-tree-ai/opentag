import * as commandPolicy from "./core/command/policy.js";

export { CHANNEL, CLI_PACKAGE_NAME, CLI_VERSION } from "./build-info.js";
export { createProgram } from "./cli/program.js";
export { formatAgent, formatAgentBound, formatAgentCreated, formatAgentList } from "./core/agent/formatting.js";
export {
  runAgentBind,
  runAgentCreate,
  runAgentDelete,
  runAgentUpdate,
  selectComputer,
} from "./core/agent/mutations.js";
export { runAgentList, runAgentShow } from "./core/agent/queries.js";
export { type LoginOptions, type LoginResult, runLogin } from "./core/auth/login.js";
export { channelConfig } from "./core/channel/config.js";
export { resolveCommandContext } from "./core/command/context.js";
export { buildChildEnvironment } from "./core/command/environment.js";
export type { CommandResult } from "./core/command/policy.js";
export const CommandError = commandPolicy.CommandError;
export const commandExitCode = commandPolicy.commandExitCode;
export const EXIT_CODES = commandPolicy.EXIT_CODES;
export const executeCommand = commandPolicy.executeCommand;
export const presentCommand = commandPolicy.presentCommand;
export const toCommandError = commandPolicy.toCommandError;
export { formatComputerList } from "./core/computer/formatting.js";
export { listComputers } from "./core/computer/queries.js";
export {
  type DoctorOptions,
  type DoctorResult,
  runDoctor,
} from "./core/diagnostics/doctor.js";
export {
  type ProviderCliEnsureCommandOptions,
  type ProviderCliEnsureCommandResult,
  runProviderCliEnsure,
} from "./core/provider-cli/ensure.js";
export {
  type ProviderCliInspectCommandOptions,
  type ProviderCliInspectCommandResult,
  runProviderCliInspect,
} from "./core/provider-cli/inspect.js";
export {
  formatSessionCommandResult,
  formatSessionList,
  runSessionCreate,
  runSessionList,
  runSessionSend,
} from "./core/session/index.js";
