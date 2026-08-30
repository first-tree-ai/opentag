import {
  type ProviderCliInspection,
  ProviderCliManager,
  type ProviderCliProvider,
  resolveAccountHome,
} from "@opentag/client";
import {
  type ProviderCliCommandDeps,
  ProviderCliUsageError,
  parseProviderCliProviderFlag,
  providerCliLabel,
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
}

function renderInspectionLines(inspection: ProviderCliInspection): string[] {
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
  return lines;
}

export async function runProviderCliInspect(
  options: ProviderCliInspectCommandOptions,
): Promise<ProviderCliInspectCommandResult> {
  let providers: ProviderCliProvider[];
  try {
    providers = parseProviderCliProviderFlag(options.provider);
  } catch (error) {
    if (error instanceof ProviderCliUsageError) {
      writeStderr(options, `${error.message}\n`);
      return { exitCode: 2, results: [] };
    }
    throw error;
  }

  const accountHome = options.accountHome ?? resolveAccountHome();
  const manager = new ProviderCliManager({
    accountHome,
    ...(options.env ? { env: options.env } : {}),
    ...(options.platform ? { platform: options.platform } : {}),
    ...(options.arch ? { arch: options.arch } : {}),
    ...(options.catalog ? { catalog: options.catalog } : {}),
    ...(options.execFile ? { execFile: options.execFile } : {}),
  });

  const results: ProviderCliInspection[] = [];
  for (const provider of providers) {
    const inspection = await manager.inspect(provider);
    results.push(inspection);
    if (!options.json) {
      for (const line of renderInspectionLines(inspection)) {
        writeStdout(options, `${line}\n`);
      }
    }
  }

  if (options.json) {
    const ok = results.every((result) => result.state === "ready");
    const document = results.length === 1 ? results[0] : { ok, results };
    writeStdout(options, `${JSON.stringify(document, null, 2)}\n`);
  }

  return { exitCode: results.every((result) => result.state === "ready") ? 0 : 1, results };
}
