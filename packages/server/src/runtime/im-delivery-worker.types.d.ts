import type { DatabaseClient } from "../db/client.js";
import type { BackgroundFailureSupervisor } from "../observability/background-failure-supervisor.js";
import type { ServiceLogger } from "../observability/service-logger.js";
import type { EffectiveRuntimeSnapshotAssembler } from "../services/runtime-config/index.js";
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

export interface ImDeliveryWorkerInput {
  database: DatabaseClient;
  domain: RuntimeDomainOwner;
  assembler: Pick<EffectiveRuntimeSnapshotAssembler, "assembleForSession">;
  registry: ConnectionRegistry;
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
