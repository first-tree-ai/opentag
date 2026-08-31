import type { ProviderCliEnsureResult, ProviderCliManager, ProviderCliPhaseEvent } from "@opentag/client";
import {
  createProviderCliManager,
  type ProviderCliCommandDeps,
  parseProviderCliProvidersOrReport,
  providerCliLabel,
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

function renderResultLines(result: ProviderCliEnsureResult): string[] {
  const label = providerCliLabel(result.provider);
  const lines: string[] = [];
  if (result.selected) {
    const source = renderProviderCliHumanValue(result.selected.source);
    const path = renderProviderCliHumanValue(result.selected.path);
    lines.push(`[${label}] selected: ${result.selected.version} ${source} ${path} (${result.selected.trust})`);
  }
  for (const candidate of result.candidates) {
    if (candidate.disposition === "ignored") {
      lines.push(
        `[${label}] ignored: ${renderProviderCliHumanValue(candidate.path)} (${renderProviderCliHumanValue(candidate.reason)})`,
      );
    }
  }
  for (const warningEntry of result.warnings) {
    lines.push(
      `[${label}] warning: ${warningEntry.code}${warningEntry.remediation ? ` — ${warningEntry.remediation}` : ""}`,
    );
  }
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
  }
  return lines;
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
  const providers = parseProviderCliProvidersOrReport(options.provider, (chunk) => writeStderr(options, chunk));
  if (!providers) return { exitCode: 2, results: [] };
  const manager = createProviderCliManager(options);

  const results: ProviderCliEnsureResult[] = [];
  for (const provider of providers) {
    const result = await ensureOneProvider(manager, provider, options);
    results.push(result);
    if (!options.json) {
      for (const line of renderResultLines(result)) {
        writeStdout(options, `${line}\n`);
      }
    }
  }

  if (options.json) {
    const ok = results.every((result) => result.ok);
    const document = results.length === 1 ? results[0] : { ok, results };
    writeStdout(options, `${JSON.stringify(document, null, 2)}\n`);
  }

  return { exitCode: results.every((result) => result.ok) ? 0 : 1, results };
}
