import { RUNNER_DEEPSEEK_PROVIDER } from "./acceptance.js";
import { RUNNER_CLI_NAME, type RunnerCliParseResult, type RunnerCommand, type RunnerMode } from "./types.js";

const COMMANDS = new Set<RunnerCommand>(["probe", "accept", "identity", "skills"]);
const USAGE = `Usage: ${RUNNER_CLI_NAME} <probe|accept|identity|skills> [options]

Options:
  --mode <offline|real>     Acceptance mode (default: offline)
  --pi-config-dir <path>    Isolated Pi config directory to copy (whitelist only)
  --provider <name>         Provider key whitelist when copying Pi config
  --workspace <path>        Workspace directory
  --json                    Machine-readable output
`;

function invalid(error: string, exitCode = 2): RunnerCliParseResult {
  return { ok: false, error: `${error}\n${USAGE}`, exitCode };
}

export function runnerCliUsage(): string {
  return USAGE;
}

function takeValue(argv: readonly string[], index: number, token: string): { value: string; next: number } | string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) return `${token} requires a value`;
  return { value, next: index + 1 };
}

function applyOption(
  token: string,
  value: string,
  current: { mode: RunnerMode; piConfigDir?: string; provider?: string; workspace?: string },
): string | typeof current {
  if (token === "--mode") {
    if (value !== "offline" && value !== "real") return `--mode must be offline or real, got ${value}`;
    return { ...current, mode: value };
  }
  if (token === "--pi-config-dir") return { ...current, piConfigDir: value };
  if (token === "--provider") return { ...current, provider: value };
  if (token === "--workspace") return { ...current, workspace: value };
  return `unknown option: ${token}`;
}

type OptionState = { mode: RunnerMode; piConfigDir?: string; provider?: string; workspace?: string };

function parseToken(
  argv: readonly string[],
  index: number,
  current: OptionState,
): RunnerCliParseResult | { json?: true; current: OptionState; next: number } {
  const token = argv[index];
  if (token === "--json") return { json: true, current, next: index };
  if (token === "--help" || token === "-h") return invalid("unexpected help flag after command");
  if (!token?.startsWith("--")) return invalid(`unexpected argument: ${token ?? ""}`);
  const taken = takeValue(argv, index, token);
  if (typeof taken === "string") return invalid(taken);
  const applied = applyOption(token, taken.value, current);
  if (typeof applied === "string") return invalid(applied);
  return { current: applied, next: taken.next };
}

function parseOptions(argv: readonly string[]): RunnerCliParseResult | { json: boolean; current: OptionState } {
  let json = false;
  let current: OptionState = { mode: "offline" };
  for (let index = 0; index < argv.length; index += 1) {
    const parsed = parseToken(argv, index, current);
    if ("ok" in parsed) return parsed;
    if (parsed.json) json = true;
    current = parsed.current;
    index = parsed.next;
  }
  return { json, current };
}

function validateInvocation(command: string, current: OptionState): string | undefined {
  if (current.mode === "real" && command === "accept" && !current.piConfigDir) {
    return "real mode requires --pi-config-dir";
  }
  if ((current.mode === "real" || current.piConfigDir) && !current.provider) {
    return "copying Pi config requires --provider";
  }
  if (current.provider && current.provider !== RUNNER_DEEPSEEK_PROVIDER) {
    return `unsupported provider for real acceptance: ${current.provider} (only ${RUNNER_DEEPSEEK_PROVIDER} is currently supported)`;
  }
  return undefined;
}

export function parseRunnerCliArgv(argv: readonly string[]): RunnerCliParseResult {
  if (argv.length === 0) return invalid("missing command");
  const command = argv[0];
  if (command === "--help" || command === "-h") return invalid("missing command");
  if (!command || !COMMANDS.has(command as RunnerCommand)) return invalid(`unknown command: ${command ?? ""}`);
  const parsed = parseOptions(argv.slice(1));
  if ("ok" in parsed) return parsed;
  const { json, current } = parsed;
  const violation = validateInvocation(command, current);
  if (violation) return invalid(violation);
  return {
    ok: true,
    invocation: {
      command: command as RunnerCommand,
      json,
      mode: current.mode,
      ...(current.piConfigDir ? { piConfigDir: current.piConfigDir } : {}),
      ...(current.provider ? { provider: current.provider } : {}),
      ...(current.workspace ? { workspace: current.workspace } : {}),
    },
  };
}
