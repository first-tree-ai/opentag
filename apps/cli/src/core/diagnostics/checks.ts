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
  imCliTitle,
  imCliUpgradeFix,
} from "./fixes.js";

/**
 * The Client Runtime abandons a provider probe after this long and reports the provider as
 * unavailable. Doctor uses the same deadline so that it never claims a readiness the daemon would
 * never publish.
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
  readonly commands?: Partial<Record<ImCliProvider, string>>;
  readonly environment: NodeJS.ProcessEnv;
  readonly probe?: ImCliProbe;
  readonly probeDeadlineMs?: number;
  readonly providers: readonly ImCliProvider[];
  readonly signal?: AbortSignal;
}

const DEFAULT_IM_CLI_COMMANDS: Readonly<Record<ImCliProvider, string>> = { feishu: "lark-cli", slack: "slack" };

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
        detail: deadline.aborted ? `readiness probe timed out after ${deadlineMs}ms` : failureDetail(error),
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
      probeImCliReadiness(
        provider,
        options.commands?.[provider] ?? DEFAULT_IM_CLI_COMMANDS[provider],
        options.environment,
        signal,
      ));
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
        detail: deadline.aborted ? `readiness probe timed out after ${deadlineMs}ms` : failureDetail(error),
        fix: imCliUpgradeFix(provider),
        id,
        status: deadline.aborted ? "unavailable" : "error",
        title,
      });
      continue;
    }
    checks.push({
      detail: imCliDetail(status),
      ...(status === "ready"
        ? {}
        : { fix: status === "install" ? imCliInstallFix(provider) : imCliUpgradeFix(provider) }),
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
  const version = result.version ? ` (${result.version})` : "";
  if (status === "ok") return `ready${version}`;
  if (status === "install") return "not installed, or not on the PATH this computer runs OpenTag with";
  if (status === "sign-in") return `installed${version} but not signed in`;
  const issues = result.issues.map((issue) => issue.message).join("; ");
  return issues || "installed but not usable";
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
  if (status === "install") return "not installed, or not on the PATH this computer runs OpenTag with";
  return "installed but not usable";
}

function failureDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function mergeSignals(signal: AbortSignal | undefined, deadline: AbortSignal): AbortSignal {
  return signal ? AbortSignal.any([signal, deadline]) : deadline;
}
