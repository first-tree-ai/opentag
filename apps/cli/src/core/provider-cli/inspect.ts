import type { ProviderCliInspection } from "@opentag/client";
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
 * Reusable orchestration for `opentag provider-cli inspect`: read-only diagnostics for
 * the selected Provider CLI. `--json` emits exactly one document to stdout.
 */

export interface ProviderCliInspectCommandOptions extends ProviderCliCommandDeps {
  readonly provider: string;
  readonly json?: boolean;
}

export interface ProviderCliInspectCommandResult {
  readonly exitCode: 0 | 1 | 2;
  readonly results: readonly ProviderCliInspection[];
  readonly nextActions: readonly ProviderCliNextAction[];
}

function renderInspectionLines(
  inspection: ProviderCliInspection,
  nextAction: ProviderCliNextAction | undefined,
): string[] {
  const label = providerCliLabel(inspection.provider);
  const lines = [`[${label}] state: ${inspection.state}`];
  if (inspection.selection) {
    lines.push(
      `[${label}] selection: ${inspection.selection.kind} ${inspection.selection.version} ${renderProviderCliHumanValue(inspection.selection.path)} (${inspection.selection.trust})`,
    );
  }
  lines.push(
    `[${label}] launcher: ${inspection.launcher.status} ${renderProviderCliHumanValue(inspection.launcher.path)}`,
  );
  const globalCommand = inspection.globalCommand;
  if (globalCommand.active) {
    lines.push(
      `[${label}] global-command: active ${renderProviderCliHumanValue(globalCommand.resolvedPath ?? globalCommand.path ?? "")}`.trimEnd(),
    );
  } else if (globalCommand.resolvedPath) {
    lines.push(`[${label}] global-command: shadowed by ${renderProviderCliHumanValue(globalCommand.resolvedPath)}`);
  } else {
    lines.push(`[${label}] global-command: inactive`);
  }
  for (const warningEntry of inspection.warnings) {
    lines.push(
      `[${label}] warning: ${warningEntry.code}${warningEntry.remediation ? ` — ${warningEntry.remediation}` : ""}`,
    );
  }
  if (inspection.diagnostic) {
    lines.push(
      `[${label}] diagnostic: ${inspection.diagnostic.code}${inspection.diagnostic.remediation ? ` — ${inspection.diagnostic.remediation}` : ""}`,
    );
  }
  if (nextAction) lines.push(`[${label}] next: ${nextAction.command}`);
  return lines;
}

function nextActionFor(inspection: ProviderCliInspection): ProviderCliNextAction | undefined {
  if (inspection.state === "ready") return undefined;
  const reason = inspection.diagnostic?.code ?? (inspection.readiness === "install" ? "not_installed" : "unavailable");
  if (!providerCliCanAutoRepair(reason)) return undefined;
  return {
    provider: inspection.provider,
    command: providerCliRepairCommand(inspection.provider),
    reason,
  };
}

export async function runProviderCliInspect(
  options: ProviderCliInspectCommandOptions,
): Promise<ProviderCliInspectCommandResult> {
  let usageMessage = "";
  const providers = parseProviderCliProvidersOrReport(options.provider, (chunk) => {
    usageMessage += chunk;
  });
  if (!providers) {
    writeProviderUsageError(options, usageMessage);
    return { exitCode: 2, results: [], nextActions: [] };
  }
  const manager = createProviderCliManager(options);

  const results = await Promise.all(providers.map((provider) => manager.inspect(provider)));
  const nextActions = results.flatMap((inspection) => {
    const action = nextActionFor(inspection);
    return action ? [action] : [];
  });
  if (!options.json) {
    for (const inspection of results) {
      const nextAction = nextActions.find((action) => action.provider === inspection.provider);
      for (const line of renderInspectionLines(inspection, nextAction)) {
        writeStdout(options, `${line}\n`);
      }
    }
  }

  if (options.json) {
    const ok = results.every((result) => result.state === "ready");
    const document = results.length === 1 ? { ok, ...results[0], nextActions } : { ok, results, nextActions };
    writeStdout(options, `${JSON.stringify(document, null, 2)}\n`);
  }

  return { exitCode: results.every((result) => result.state === "ready") ? 0 : 1, results, nextActions };
}

function writeProviderUsageError(options: ProviderCliInspectCommandOptions, message: string): void {
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
