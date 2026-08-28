import {
  type AgentRuntimeFactory,
  type AgentRuntimeProbeResult,
  probeImCliReadiness,
  providerReadiness,
  resolveAgentRuntimeProviders,
} from "@opentag/client";
import type { AgentRuntimeProvider, ImCliProvider } from "@opentag/shared";
import {
  agentRuntimeInstallFix,
  agentRuntimeSignInFix,
  agentRuntimeTitle,
  agentRuntimeUpgradeFix,
  type DoctorFix,
  imCliInstallFix,
  imCliRepairFix,
  imCliTitle,
} from "./fixes.js";

/**
 * The Client Runtime abandons a provider probe after this long and reports the provider as
 * unavailable. Doctor uses the same deadline so that it never calls a provider ready on evidence the
 * daemon would have thrown away.
 */
export const DOCTOR_PROBE_DEADLINE_MS = 10_000;

export type DoctorCheckStatus = "error" | "install" | "ok" | "sign-in" | "unavailable";

export interface DoctorCheck {
  readonly detail: string;
  readonly fix?: DoctorFix;
  readonly id: string;
  readonly status: DoctorCheckStatus;
  readonly title: string;
}

export type AgentRuntimeProbe = (
  provider: AgentRuntimeProvider,
  signal: AbortSignal,
) => Promise<AgentRuntimeProbeResult>;

export type ImCliProbe = (provider: ImCliProvider, signal: AbortSignal) => Promise<"install" | "ready" | "unavailable">;

export interface AgentRuntimeCheckOptions {
  readonly clientVersion: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly probe?: AgentRuntimeProbe;
  readonly probeDeadlineMs?: number;
  readonly providers: readonly AgentRuntimeProvider[];
  readonly signal?: AbortSignal;
}

export interface ImCliCheckOptions {
  readonly environment: NodeJS.ProcessEnv;
  readonly probe?: ImCliProbe;
  readonly probeDeadlineMs?: number;
  readonly providers: readonly ImCliProvider[];
  readonly signal?: AbortSignal;
}

const IM_CLI_COMMANDS: Readonly<Record<ImCliProvider, string>> = { feishu: "lark-cli", slack: "slack" };

/** The bare command each check resolves through PATH, keyed by check id. */
export const DOCTOR_PROBE_COMMANDS: Readonly<Record<string, string | undefined>> = {
  "im:feishu": IM_CLI_COMMANDS.feishu,
  "im:slack": IM_CLI_COMMANDS.slack,
  "runtime:claude-code": "claude",
  "runtime:codex": "codex",
};

export async function checkAgentRuntimes(options: AgentRuntimeCheckOptions): Promise<DoctorCheck[]> {
  const deadlineMs = options.probeDeadlineMs ?? DOCTOR_PROBE_DEADLINE_MS;
  const probe = options.probe ?? createAgentRuntimeProbe(options);
  const checks: DoctorCheck[] = [];
  for (const provider of options.providers) {
    const id = `runtime:${provider}`;
    const title = agentRuntimeTitle(provider);
    const deadline = AbortSignal.timeout(deadlineMs);
    let result: AgentRuntimeProbeResult;
    try {
      result = await probe(provider, mergeSignals(options.signal, deadline));
    } catch (error) {
      options.signal?.throwIfAborted();
      checks.push({
        detail: deadline.aborted ? timedOutDetail(deadlineMs) : failureDetail(error),
        fix: agentRuntimeUpgradeFix(provider),
        id,
        status: deadline.aborted ? "unavailable" : "error",
        title,
      });
      continue;
    }
    const status = agentRuntimeStatus(provider, result);
    checks.push({
      detail: agentRuntimeDetail(status, result),
      ...(status === "ok" ? {} : { fix: agentRuntimeFix(provider, status) }),
      id,
      status,
      title,
    });
  }
  return checks;
}

export async function checkImClis(options: ImCliCheckOptions): Promise<DoctorCheck[]> {
  const deadlineMs = options.probeDeadlineMs ?? DOCTOR_PROBE_DEADLINE_MS;
  const probe =
    options.probe ??
    ((provider: ImCliProvider, signal: AbortSignal) =>
      probeImCliReadiness(provider, IM_CLI_COMMANDS[provider], options.environment, signal));
  const checks: DoctorCheck[] = [];
  for (const provider of options.providers) {
    const id = `im:${provider}`;
    const title = imCliTitle(provider);
    const deadline = AbortSignal.timeout(deadlineMs);
    let status: "install" | "ready" | "unavailable";
    try {
      status = await probe(provider, mergeSignals(options.signal, deadline));
    } catch (error) {
      options.signal?.throwIfAborted();
      checks.push({
        detail: deadline.aborted ? timedOutDetail(deadlineMs) : failureDetail(error),
        fix: imCliRepairFix(provider),
        id,
        status: deadline.aborted ? "unavailable" : "error",
        title,
      });
      continue;
    }
    // The messaging CLI probe reports a spent deadline as "unavailable" instead of throwing, so the
    // timed-out wording has to be recovered here to stay accurate.
    const timedOut = status !== "ready" && deadline.aborted;
    checks.push({
      detail: timedOut ? timedOutDetail(deadlineMs) : imCliDetail(status),
      ...(status === "ready"
        ? {}
        : { fix: status === "install" ? imCliInstallFix(provider) : imCliRepairFix(provider) }),
      id,
      status: status === "ready" ? "ok" : status,
      title,
    });
  }
  return checks;
}

function createAgentRuntimeProbe(options: AgentRuntimeCheckOptions): AgentRuntimeProbe {
  let composition: Promise<ReadonlyMap<string, AgentRuntimeFactory>> | undefined;
  return async (provider, signal) => {
    composition ??= resolveAgentRuntimeProviders({
      clientVersion: options.clientVersion,
      // Doctor observes a Computer; it must not create the provider homes it is reporting on.
      ensureProviderHomes: false,
      environment: options.environment,
      ...(options.signal ? { signal: options.signal } : {}),
    }).then((resolved) => new Map(resolved.factories.map((factory) => [factory.manifest.providerId, factory])));
    const factory = (await composition).get(provider);
    if (!factory) throw new Error(`The Client Runtime does not register the Agent Runtime provider: ${provider}`);
    return factory.probe({ signal });
  };
}

function agentRuntimeStatus(
  provider: AgentRuntimeProvider,
  result: AgentRuntimeProbeResult,
): Exclude<DoctorCheckStatus, "error"> {
  const { status } = providerReadiness(provider, result.ready, result);
  if (status === "ready") return "ok";
  // "checking" only describes a probe still in flight, which a settled probe result cannot be.
  return status === "checking" ? "unavailable" : status;
}

function agentRuntimeDetail(status: Exclude<DoctorCheckStatus, "error">, result: AgentRuntimeProbeResult): string {
  const version = formatVersion(result.version);
  if (status === "ok") return `ready${version}`;
  if (status === "install") return "not installed, or not on this shell's PATH";
  if (status === "sign-in") return `installed${version} but not signed in`;
  const issues = result.issues.map((issue) => issue.message).join("; ");
  return issues || "installed but not usable";
}

/** `claude --version` prints `2.1.248 (Claude Code)`, which would otherwise nest parentheses. */
function formatVersion(version: string | undefined): string {
  if (!version) return "";
  const trimmed = version.replace(/\s*\([^()]*\)\s*$/u, "").trim();
  return ` (${trimmed || version})`;
}

function agentRuntimeFix(
  provider: AgentRuntimeProvider,
  status: Exclude<DoctorCheckStatus, "error" | "ok">,
): DoctorFix {
  if (status === "install") return agentRuntimeInstallFix(provider);
  if (status === "sign-in") return agentRuntimeSignInFix(provider);
  return agentRuntimeUpgradeFix(provider);
}

function imCliDetail(status: "install" | "ready" | "unavailable"): string {
  if (status === "ready") return "ready";
  if (status === "install") return "not installed, or not on this shell's PATH";
  return "installed but does not answer OpenTag's probe";
}

function timedOutDetail(deadlineMs: number): string {
  return `readiness probe timed out after ${deadlineMs}ms`;
}

function failureDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function mergeSignals(signal: AbortSignal | undefined, deadline: AbortSignal): AbortSignal {
  return signal ? AbortSignal.any([signal, deadline]) : deadline;
}
