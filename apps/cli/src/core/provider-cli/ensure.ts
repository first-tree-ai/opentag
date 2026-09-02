import type { ProviderCliEnsureResult, ProviderCliManager, ProviderCliPhaseEvent } from "@opentag/client";
import {
  createProviderCliManager,
  type ProviderCliCommandDeps,
  type ProviderCliNextAction,
  parseProviderCliProvidersOrReport,
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
 * without a TTY. `--json` mode writes exactly one JSON document to stdout — the per
 * provider result, or `{ ok, results }` for `all` — and suppresses phase lines.
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
  readonly exitCode: 0 | 1 | 2;
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

function jsonDocument(
  results: readonly ProviderCliEnsureResult[],
  nextActions: readonly ProviderCliNextAction[],
): unknown {
  if (results.length === 1) return { ...results[0], nextActions };
  return { ok: results.every((result) => result.ok), results, nextActions };
}

function ensureOneProvider(
  manager: ProviderCliManager,
  provider: ProviderCliEnsureResult["provider"],
  options: ProviderCliEnsureCommandOptions,
): Promise<ProviderCliEnsureResult> {
  return manager.ensure(provider, {
    mode: options.managedOnly ? "managed-only" : "auto",
    pathUpdate: options.pathUpdate ?? true,
    dryRun: options.dryRun ?? false,
    onPhase: options.json
      ? undefined
      : (event) => {
          const line = renderPhaseLine(event);
          if (line !== undefined) writeStdout(options, `${line}\n`);
        },
  });
}

export async function runProviderCliEnsure(
  options: ProviderCliEnsureCommandOptions,
): Promise<ProviderCliEnsureCommandResult> {
  let usageMessage = "";
  const providers = parseProviderCliProvidersOrReport(options.provider, (chunk) => {
    usageMessage += chunk;
  });
  if (!providers) {
    writeProviderUsageError(options, usageMessage);
    return { exitCode: 2, results: [], nextActions: [] };
  }
  const manager = createProviderCliManager(options);

  const results = await Promise.all(providers.map((provider) => ensureOneProvider(manager, provider, options)));
  const nextActions = results.flatMap((result) => {
    const action = nextActionFor(result);
    return action ? [action] : [];
  });
  if (!options.json) {
    for (const result of results) {
      const nextAction = nextActions.find((action) => action.provider === result.provider);
      for (const line of renderResultLines(result, nextAction)) {
        writeStdout(options, `${line}\n`);
      }
    }
  }

  if (options.json) {
    writeStdout(options, `${JSON.stringify(jsonDocument(results, nextActions), null, 2)}\n`);
  }

  return { exitCode: results.every((result) => result.ok) ? 0 : 1, results, nextActions };
}

function writeProviderUsageError(options: ProviderCliEnsureCommandOptions, message: string): void {
  if (!options.json) {
    writeStderr(options, message);
    return;
  }
  writeStderr(
    options,
    `${JSON.stringify({
      ok: false,
      error: {
        code: "INVALID_PROVIDER",
        category: "validation",
        retryability: "never",
        phase: "validation",
        message: message.trim(),
      },
      nextActions: [],
    })}\n`,
  );
}
