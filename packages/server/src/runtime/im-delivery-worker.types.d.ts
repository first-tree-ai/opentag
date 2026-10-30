import type { DatabaseClient } from "../db/client.js";
import type { BackgroundFailureSupervisor } from "../observability/background-failure-supervisor.js";
import type { ServiceLogger } from "../observability/service-logger.js";
import type { EffectiveRuntimeSnapshotAssembler } from "../services/runtime-config/index.js";
import type { CloudDeliveryOwner } from "../services/sandboxes/cloud-delivery-owner.js";
import type { IngressAllocationOutcome, ReadyRunnerAllocation } from "../services/sandboxes/sandbox-runner-service.js";
import type { ConnectionRegistry } from "./connection-registry.js";
import type { RuntimeDomainOwner } from "./runtime-domain-owner.js";

export interface RuntimeDeliveryWorkerMetric {
  name: "queue_age_ms" | "active_lanes" | "queued_tasks" | "retry" | "saturation" | "timeout" | "late_settle";
  value: number;
  agentId?: string;
}

/** Which worker operation recorded a per-delivery diagnostic. */
export type ImDeliveryFailurePhase = "claim" | "deliver" | "steer" | "recover";

/**
 * Structured context for one Server diagnostic. Durable identifiers and counters only: no message
 * body, prompt, credential, or provider payload ever enters a diagnostic. A declared type alias (not
 * an interface) so it is directly assignable to the reporter's generic log context.
 */
export type ImDeliveryDiagnosticContext = {
  phase: ImDeliveryFailurePhase | "worker" | "maintenance";
  deliveryId?: string;
  agentId?: string;
  computerId?: string;
  attemptCount?: number;
};

export type ImDeliveryDiagnosticReporter = (code: string, context?: ImDeliveryDiagnosticContext) => void;

/** One claimed delivery attempt: the identity every retry decision and diagnostic is attributed to. */
export interface DeliveryAttempt {
  deliveryId: string;
  agentId: string;
  computerId: string;
  /** Post-claim attempt number, i.e. `im_message_deliveries.attempt_count` at failure time. */
  attemptCount: number;
  phase: ImDeliveryFailurePhase;
  claimToken?: string;
  /** Placement Computer silence, set only where the runtime was found absent. */
  offlineMs?: number;
  /**
   * The durable failure code this attempt replaced. A repeat of the same code is not a new signal,
   * so it does not produce another ERROR line.
   */
  previousErrorCode?: string | null;
}

type WorkerClaimIdentity = {
  id: string;
  agentId: string;
  computerId: string;
  /** Post-claim attempt number, so a timeout is attributed without re-reading the row. */
  attemptCount: number;
  /** The row's failure code before this claim replaced it with the claim marker. */
  previousErrorCode: string | null;
  /** In-process scheduler lane: the delivery's occupancy scope (Agent for Local, Session for Cloud). */
  laneKey: string;
  queuedAt: number;
};

export type WorkerClaim =
  | (WorkerClaimIdentity & { kind: "pending"; claimToken: string })
  | (WorkerClaimIdentity & {
      kind: "steer";
      claimToken: string;
      rootDeliveryId: string;
      expectedTurnId: string;
    })
  | (WorkerClaimIdentity & { kind: "recovery" });

/** A narrowly injected Cloud sandbox allocation port so real Cloud API seams stay outside the worker. */
export interface CloudSessionAllocationPort {
  /** Current accepted connection and tracked allocation, for notification/retry races. */
  readyAllocation?(sandboxId: string): Promise<ReadyRunnerAllocation | undefined>;
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
  onDiagnostic?: ImDeliveryDiagnosticReporter;
  onDeliverySettled?: (deliveryId: string) => void;
  supervisor?: BackgroundFailureSupervisor;
  now?: () => Date;
  operationTimeoutMs?: number;
  maxQueueAgeMs?: number;
  maxConcurrent?: number;
  /** Per-lane queue bound: one lane per Local Agent or per Cloud Session. */
  maxQueuedPerAgent?: number;
  maxQueuedTotal?: number;
  onMetric?: (metric: RuntimeDeliveryWorkerMetric) => void;
}
