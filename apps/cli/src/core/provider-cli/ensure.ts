import {
  PROVIDER_CLI_LOCK_BUSY_MAX_ATTEMPTS,
  PROVIDER_CLI_LOCK_BUSY_RETRY_DELAY_MS,
  type ProviderCliEnsureResult,
  type ProviderCliManager,
  type ProviderCliPhaseEvent,
} from "@opentag/client";
import { CommandError, type CommandExitCode, commandExitCode, presentCommand } from "../command/policy.js";
import {
  createProviderCliManager,
  type ProviderCliCommandDeps,
  type ProviderCliNextAction,
  parseProviderCliProvidersOrReport,
  providerCliAggregateFailure,
  providerCliCanAutoRepair,
  providerCliLabel,
  providerCliRepairCommand,
  renderProviderCliHumanValue,
  writeStderr,
  writeStdout,
} from "./shared.js";

/**
 * Reusable orchestration for `opentag provider-cli ensure`.
 *
 * Human mode prints bounded single-line phase updates and never prompts, with or
 * without a TTY. `--json` mode writes one common command envelope and suppresses phase lines.
 */

export interface ProviderCliEnsureCommandOptions extends ProviderCliCommandDeps {
  readonly provider: string;
  readonly managedOnly?: boolean;
  /** `--no-path-update` passes false. */
  readonly pathUpdate?: boolean;
  readonly dryRun?: boolean;
  readonly json?: boolean;
}

export interface ProviderCliEnsureCommandResult {
  readonly exitCode: CommandExitCode;
  readonly results: readonly ProviderCliEnsureResult[];
  readonly nextActions: readonly ProviderCliNextAction[];
}

function renderPhaseLine(event: ProviderCliPhaseEvent): string | undefined {
  const label = providerCliLabel(event.provider);
  const detail = event.detail ? renderProviderCliHumanValue(event.detail) : undefined;
  if (event.status === "started") {
    // Keep started lines quiet for instant phases; the completed line carries detail.
    if (event.phase === "managed-install") return `[${label}] managed-install: ${detail ?? "started"}`;
    return undefined;
  }
  if (event.status === "failed") return `[${label}] ${event.phase}: failed${detail ? ` (${detail})` : ""}`;
  return `[${label}] ${event.phase}: ${detail ?? "completed"}`;
}

function renderResultLines(result: ProviderCliEnsureResult, nextAction: ProviderCliNextAction | undefined): string[] {
  const label = providerCliLabel(result.provider);
  const lines = [
    selectedLine(result, label),
    ...ignoredCandidateLines(result, label),
    ...warningLines(result, label),
  ].filter((line): line is string => line !== undefined);
  if (result.ok) {
    const selected = result.selected;
    const readySelection = selected
      ? ` — ${selected.version} ${renderProviderCliHumanValue(selected.path)} (${selected.trust})`
      : "";
    lines.push(`[${label}] ready: ${result.action}${readySelection}`);
  } else {
    const code = result.diagnostic?.code ?? "unavailable";
    const remediation = result.diagnostic?.remediation;
    lines.push(`[${label}] failed: ${code}${remediation ? ` — ${remediation}` : ""}`);
    if (nextAction) lines.push(`[${label}] next: ${nextAction.command}`);
  }
  return lines;
}

function selectedLine(result: ProviderCliEnsureResult, label: string): string | undefined {
  if (!result.selected) return undefined;
  const source = renderProviderCliHumanValue(result.selected.source);
  const path = renderProviderCliHumanValue(result.selected.path);
  return `[${label}] selected: ${result.selected.version} ${source} ${path} (${result.selected.trust})`;
}

function ignoredCandidateLines(result: ProviderCliEnsureResult, label: string): string[] {
  return result.candidates
    .filter((candidate) => candidate.disposition === "ignored")
    .map(
      (candidate) =>
        `[${label}] ignored: ${renderProviderCliHumanValue(candidate.path)} (${renderProviderCliHumanValue(candidate.reason)})`,
    );
}

function warningLines(result: ProviderCliEnsureResult, label: string): string[] {
  return result.warnings.map(
    (warningEntry) =>
      `[${label}] warning: ${warningEntry.code}${warningEntry.remediation ? ` — ${warningEntry.remediation}` : ""}`,
  );
}

function nextActionFor(result: ProviderCliEnsureResult): ProviderCliNextAction | undefined {
  if (result.ok) return undefined;
  const reason = result.diagnostic?.code ?? "unavailable";
  if (!providerCliCanAutoRepair(reason)) return undefined;
  return {
    provider: result.provider,
    command: providerCliRepairCommand(result.provider),
    reason,
  };
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function ensureOneProvider(
  manager: ProviderCliManager,
  provider: ProviderCliEnsureResult["provider"],
  options: ProviderCliEnsureCommandOptions,
): Promise<ProviderCliEnsureResult> {
  const ensure = (emitPhases: boolean): Promise<ProviderCliEnsureResult> =>
    manager.ensure(provider, {
      mode: options.managedOnly ? "managed-only" : "auto",
      pathUpdate: options.pathUpdate ?? true,
      dryRun: options.dryRun ?? false,
      onPhase:
        options.json || !emitPhases
          ? undefined
          : (event) => {
              const line = renderPhaseLine(event);
              if (line !== undefined) writeStdout(options, `${line}\n`);
            },
    });

  let result = await ensure(true);
  const sleep = options.sleep ?? defaultSleep;
  for (let attempt = 0; result.diagnostic?.code === "operation_in_progress"; attempt += 1) {
    if (attempt >= PROVIDER_CLI_LOCK_BUSY_MAX_ATTEMPTS) break;
    await sleep(PROVIDER_CLI_LOCK_BUSY_RETRY_DELAY_MS);
    // A daemon that acquired the cross-process lock first may have completed the same install.
    // Re-enter ensure so the foreground Agent observes that terminal fact instead of reporting
    // the transient lock owner as a Provider failure.
    result = await ensure(false);
  }
  return result;
}

export async function runProviderCliEnsure(
  options: ProviderCliEnsureCommandOptions,
): Promise<ProviderCliEnsureCommandResult> {
  let usageMessage = "";
  const providers = parseProviderCliProvidersOrReport(options.provider, (chunk) => {
    usageMessage += chunk;
  });
  if (!providers) {
    presentCommand(
      {
        ok: false,
        error: new CommandError(
          { code: "INVALID_PROVIDER", category: "validation", retryability: "never", phase: "validation" },
          usageMessage.trim(),
        ),
        exitCode: 2,
        value: { results: [], nextActions: [] },
      },
      { json: options.json, stdout: options.stdout, stderr: options.stderr },
    );
    return { exitCode: 2, results: [], nextActions: [] };
  }
  const manager = createProviderCliManager(options);

  const results = await Promise.all(providers.map((provider) => ensureOneProvider(manager, provider, options)));
  const nextActions = results.flatMap((result) => {
    const action = nextActionFor(result);
    return action ? [action] : [];
  });
  const ready = results.every((result) => result.ok);
  const failure = ready ? undefined : providerCliSetupIncomplete(results);
  const value = { results, nextActions };
  if (!options.json) {
    const write = ready ? writeStdout : writeStderr;
    if (!ready) write(options, "PROVIDER_CLI_SETUP_INCOMPLETE: One or more Provider CLIs need attention.\n");
    for (const result of results) {
      const nextAction = nextActions.find((action) => action.provider === result.provider);
      for (const line of renderResultLines(result, nextAction)) {
        write(options, `${line}\n`);
      }
    }
  } else if (ready) {
    presentCommand({ ok: true, value, exitCode: 0 }, { json: true, stdout: options.stdout, stderr: options.stderr });
  } else if (failure) {
    presentCommand(
      {
        ok: false,
        error: failure.error,
        exitCode: failure.exitCode,
        value,
      },
      { json: true, stdout: options.stdout, stderr: options.stderr },
    );
  }

  return { exitCode: failure ? failure.exitCode : 0, results, nextActions };
}

/** The aggregate failure contract for a run where at least one provider did not become ready. */
function providerCliSetupIncomplete(results: readonly ProviderCliEnsureResult[]): {
  readonly error: CommandError;
  readonly exitCode: ReturnType<typeof commandExitCode>;
} {
  const aggregate = providerCliAggregateFailure(results.filter((result) => !result.ok));
  const error = new CommandError(
    {
      code: "PROVIDER_CLI_SETUP_INCOMPLETE",
      category: aggregate.category,
      retryability: aggregate.retryability,
      phase: "provider",
    },
    "One or more Provider CLIs need attention.",
  );
  return { error, exitCode: commandExitCode(error) };
}
