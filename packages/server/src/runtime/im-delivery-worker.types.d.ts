import type { DatabaseClient } from "../db/client.js";
import type { BackgroundFailureSupervisor } from "../observability/background-failure-supervisor.js";
import type { ServiceLogger } from "../observability/service-logger.js";
import type { EffectiveRuntimeSnapshotAssembler } from "../services/runtime-config/index.js";
import type { CloudDeliveryOwner } from "../services/sandboxes/cloud-delivery-owner.js";
import type { IngressAllocationOutcome } from "../services/sandboxes/sandbox-runner-service.js";
import type { ConnectionRegistry } from "./connection-registry.js";
import type { RuntimeDomainOwner } from "./runtime-domain-owner.js";

export interface RuntimeDeliveryWorkerMetric {
  name: "queue_age_ms" | "active_lanes" | "queued_tasks" | "retry" | "saturation" | "timeout" | "late_settle";
  value: number;
  agentId?: string;
}

export type WorkerClaim =
  | { id: string; agentId: string; queuedAt: number; kind: "pending"; claimToken: string }
  | {
      id: string;
      agentId: string;
      queuedAt: number;
      kind: "steer";
      claimToken: string;
      rootDeliveryId: string;
      expectedTurnId: string;
    }
  | { id: string; agentId: string; queuedAt: number; kind: "recovery" };

/** A narrowly injected Cloud sandbox allocation port so real Cloud API seams stay outside the worker. */
export interface CloudSessionAllocationPort {
  /** Existing SandboxService.ensureForAccount: idempotent Session -> Sandbox ensure. */
  ensureSandbox(
    input: {
      accountId: string;
      imBindingId: string;
      channelId: string;
      conversationKind: "channel" | "dm" | "group_dm";
    } & ({ kind: "channel" } | { kind: "thread"; threadKey: string }),
  ): Promise<{ sandboxId: string }>;
  /** Existing SandboxRunnerService ingress allocation: bounded, idempotent, E5-guarded. */
  ensureEnvironmentAllocated(input: { accountId: string; sandboxId: string }): Promise<IngressAllocationOutcome>;
}

export interface ImDeliveryWorkerInput {
  database: DatabaseClient;
  domain: RuntimeDomainOwner;
  assembler: Pick<EffectiveRuntimeSnapshotAssembler, "assembleForSession">;
  registry: ConnectionRegistry;
  /**
   * E4 Cloud dispatch owner. Present when Cloud Runner allocation is enabled. Cloud deliveries
   * are routed per-Session-Sandbox through it instead of the Local runtime registry; when absent,
   * a Cloud delivery fails transiently (IM_DELIVERY_CLOUD_UNAVAILABLE) and keeps retrying.
   */
  cloudDelivery?: CloudDeliveryOwner;
  /**
   * E4 normal-ingress allocation: ensures the Session Sandbox exists and converges its first
   * environment reservation through the existing services. Injected only when Cloud delivery is
   * enabled; no Cloud API is ever called from this worker directly.
   */
  cloudAllocation?: CloudSessionAllocationPort;
  logger?: ServiceLogger;
  intervalMs?: number;
  janitorIntervalMs?: number;
  retentionIntervalMs?: number;
  expiryBatchSize?: number;
  retentionBatchSize?: number;
  imMessagesRetentionMs?: number;
  imMessageDeliveriesRetentionMs?: number;
  slackWebhookReceiptsRetentionMs?: number;
  feishuInboundReceiptsRetentionMs?: number;
  claimLeaseMs?: number;
  claimRenewMs?: number;
  afterClaimRowLocked?: () => Promise<void>;
  beforeDeliveryAdmission?: (signal: AbortSignal) => Promise<void>;
  onDiagnostic?: (code: string) => void;
  supervisor?: BackgroundFailureSupervisor;
  now?: () => Date;
  operationTimeoutMs?: number;
  maxQueueAgeMs?: number;
  maxConcurrent?: number;
  maxQueuedPerAgent?: number;
  maxQueuedTotal?: number;
  onMetric?: (metric: RuntimeDeliveryWorkerMetric) => void;
}
