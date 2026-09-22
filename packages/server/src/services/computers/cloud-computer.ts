import type { AccountCloudComputerEnsureResponse, AccountComputerSummary } from "@opentag/shared";
import {
  type ProviderReadinessSource,
  projectComputerImCliReadiness,
  projectComputerProviderReadiness,
} from "./provider-readiness.js";

export const CLOUD_COMPUTER_DISPLAY_NAME = "Cloud";
export const CLOUD_COMPUTER_PLATFORM = "linux" as const;
export const CLOUD_COMPUTER_ARCH = "x64";

type ComputerRow = {
  id: string;
  kind: "local" | "cloud";
  displayName: string;
  platform: "darwin" | "linux" | "win32";
  currentInstanceId: string | null;
  connectedAt: Date | null;
  disconnectedAt?: Date | null;
  lastSeenAt: Date | null;
  createdAt: Date;
};

export function projectCloudComputerEnsure(row: ComputerRow): AccountCloudComputerEnsureResponse {
  return {
    computerId: row.id,
    kind: "cloud",
    displayName: row.displayName,
    platform: row.platform,
    connectionStatus: "online",
    createdAt: row.createdAt.toISOString(),
  };
}

export function projectAccountComputerSummary(input: {
  computer: ComputerRow;
  agentIds: string[];
  includeCloudIdentities: boolean;
  includeProviderReadiness: boolean;
  observedAt: Date;
  presenceCutoffMs: number;
  providerReadiness?: ProviderReadinessSource;
}): AccountComputerSummary {
  const { computer } = input;
  const cloud = computer.kind === "cloud";
  const connectionStatus = accountConnectionStatus(computer, input.presenceCutoffMs);
  const readinessConnection = cloud || connectionStatus === "disconnected" ? "offline" : connectionStatus;
  return {
    computerId: computer.id,
    ...(input.includeCloudIdentities ? { kind: computer.kind } : {}),
    displayName: computer.displayName,
    platform: computer.platform,
    connectionStatus,
    ...(input.includeProviderReadiness
      ? {
          providerReadiness: projectComputerProviderReadiness(
            computer.id,
            readinessConnection,
            input.observedAt,
            input.providerReadiness,
          ),
          imCliReadiness: projectComputerImCliReadiness(
            computer.id,
            readinessConnection,
            input.observedAt,
            input.providerReadiness,
          ),
        }
      : {}),
    connectedAt: cloud ? null : (computer.connectedAt?.toISOString() ?? null),
    lastSeenAt: cloud ? null : (computer.lastSeenAt?.toISOString() ?? null),
    observedAt: input.observedAt.toISOString(),
    createdAt: computer.createdAt.toISOString(),
    agentIds: input.agentIds,
  };
}

function accountConnectionStatus(
  computer: ComputerRow,
  presenceCutoffMs: number,
): AccountComputerSummary["connectionStatus"] {
  if (computer.kind === "cloud") return "online";
  if (computer.disconnectedAt) return "disconnected";
  return computer.currentInstanceId !== null && (computer.lastSeenAt?.getTime() ?? 0) >= presenceCutoffMs
    ? "online"
    : "offline";
}
