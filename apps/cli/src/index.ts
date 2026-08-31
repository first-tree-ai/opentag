export { CHANNEL, CLI_PACKAGE_NAME, CLI_VERSION } from "./build-info.js";
export { createProgram } from "./cli/program.js";
export { formatAgent, formatAgentCreated, formatAgentList } from "./core/agent/formatting.js";
export {
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
export {
  CommandError,
  type CommandResult,
  commandExitCode,
  EXIT_CODES,
  executeCommand,
  presentCommand,
  toCommandError,
} from "./core/command/policy.js";
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
