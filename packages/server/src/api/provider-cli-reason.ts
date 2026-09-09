import {
  type AgentSetupSnapshot,
  type ComputerImCliReadinessCollection,
  type ImBindingDiagnostics,
  type ImBindingHandoffStatus,
  INTEGRATION_CREDENTIAL_EXECUTION_REASONS,
  type ListAccountComputersResponse,
  PROVIDER_CLI_REASON_V2_HEADER,
  type ProviderCliHandoffProgress,
  requestsProviderCliReasonV2,
} from "@opentag/shared";
import type { FastifyRequest } from "fastify";

const CREDENTIAL_REASONS = new Set<string>(INTEGRATION_CREDENTIAL_EXECUTION_REASONS);

export function requestIncludesProviderCliReasonV2(request: FastifyRequest): boolean {
  return requestsProviderCliReasonV2(request.headers[PROVIDER_CLI_REASON_V2_HEADER]);
}

export function projectComputerImCliReadinessForHttp(
  observations: ComputerImCliReadinessCollection,
  includeReasons: boolean,
): ComputerImCliReadinessCollection {
  if (includeReasons) return observations;
  return observations.map(({ reason: _reason, ...observation }) => observation);
}

export function projectProviderCliHandoffProgressForHttp(
  progress: ProviderCliHandoffProgress,
  includeReasons: boolean,
): ProviderCliHandoffProgress {
  if (includeReasons) return progress;
  if (progress.reason && CREDENTIAL_REASONS.has(progress.reason)) {
    return { phase: progress.phase, reason: progress.reason };
  }
  return { phase: progress.phase };
}

export function projectImBindingHandoffStatusForHttp(
  status: ImBindingHandoffStatus,
  includeReasons: boolean,
): ImBindingHandoffStatus {
  if (includeReasons || !("providerCli" in status) || status.providerCli === undefined) return status;
  return { ...status, providerCli: projectProviderCliHandoffProgressForHttp(status.providerCli, false) };
}

export function projectImBindingDiagnosticsForHttp(
  diagnostics: ImBindingDiagnostics,
  includeReasons: boolean,
): ImBindingDiagnostics {
  if (includeReasons) return diagnostics;
  const { providerCliReason: _reason, ...rest } = diagnostics;
  return rest;
}

export function projectAgentSetupSnapshotForHttp(
  snapshot: AgentSetupSnapshot,
  includeReasons: boolean,
): AgentSetupSnapshot {
  if (includeReasons) return snapshot;
  const computer =
    snapshot.computer.kind === "bound"
      ? {
          ...snapshot.computer,
          imCliReadiness: projectComputerImCliReadinessForHttp(snapshot.computer.imCliReadiness, false),
        }
      : snapshot.computer;
  if (snapshot.messaging.kind !== "waiting-handoff" || snapshot.messaging.progress === undefined) {
    return { ...snapshot, computer };
  }
  return {
    ...snapshot,
    computer,
    messaging: {
      ...snapshot.messaging,
      progress: projectProviderCliHandoffProgressForHttp(snapshot.messaging.progress, false),
    },
  };
}

export function projectListAccountComputersResponseForHttp(
  response: ListAccountComputersResponse,
  includeReasons: boolean,
): ListAccountComputersResponse {
  if (includeReasons) return response;
  return {
    computers: response.computers.map((computer) =>
      computer.imCliReadiness
        ? {
            ...computer,
            imCliReadiness: projectComputerImCliReadinessForHttp(computer.imCliReadiness, false),
          }
        : computer,
    ),
  };
}
