import { sql } from "drizzle-orm";
import type { DatabaseClient } from "../db/client.js";
import type { BackgroundFailureSupervisor } from "../observability/background-failure-supervisor.js";

const DEFAULT_JANITOR_INTERVAL_MS = 5_000;
const DEFAULT_RETENTION_INTERVAL_MS = 60_000;
const DEFAULT_EXPIRY_BATCH_SIZE = 100;
const DEFAULT_RETENTION_BATCH_SIZE = 100;
const DEFAULT_MESSAGE_RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;
const DEFAULT_DELIVERY_RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;
const DEFAULT_RECEIPT_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

function positiveWorkerLimit(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer`);
  return value;
}

function configuredWorkerLimit(value: number | undefined, environmentName: string, fallback: number): number {
  const environmentValue = process.env[environmentName];
  const configured = value ?? (environmentValue === undefined ? fallback : Number(environmentValue));
  return positiveWorkerLimit(configured, environmentName);
}

export interface ImDeliveryJanitorConfig {
  janitorIntervalMs: number;
  retentionIntervalMs: number;
  expiryBatchSize: number;
  retentionBatchSize: number;
  imMessagesRetentionMs: number;
  imMessageDeliveriesRetentionMs: number;
  slackWebhookReceiptsRetentionMs: number;
  feishuInboundReceiptsRetentionMs: number;
}

export interface ImDeliveryJanitorInput {
  janitorIntervalMs?: number;
  retentionIntervalMs?: number;
  expiryBatchSize?: number;
  retentionBatchSize?: number;
  imMessagesRetentionMs?: number;
  imMessageDeliveriesRetentionMs?: number;
  slackWebhookReceiptsRetentionMs?: number;
  feishuInboundReceiptsRetentionMs?: number;
}

export function resolveImDeliveryJanitorConfig(input: ImDeliveryJanitorInput): ImDeliveryJanitorConfig {
  return {
    janitorIntervalMs: configuredWorkerLimit(
      input.janitorIntervalMs,
      "OPENTAG_IM_DELIVERY_JANITOR_INTERVAL_MS",
      DEFAULT_JANITOR_INTERVAL_MS,
    ),
    retentionIntervalMs: configuredWorkerLimit(
      input.retentionIntervalMs,
      "OPENTAG_IM_DELIVERY_RETENTION_INTERVAL_MS",
      DEFAULT_RETENTION_INTERVAL_MS,
    ),
    expiryBatchSize: configuredWorkerLimit(
      input.expiryBatchSize,
      "OPENTAG_IM_DELIVERY_EXPIRY_BATCH_SIZE",
      DEFAULT_EXPIRY_BATCH_SIZE,
    ),
    retentionBatchSize: configuredWorkerLimit(
      input.retentionBatchSize,
      "OPENTAG_IM_DELIVERY_RETENTION_BATCH_SIZE",
      DEFAULT_RETENTION_BATCH_SIZE,
    ),
    imMessagesRetentionMs: configuredWorkerLimit(
      input.imMessagesRetentionMs,
      "OPENTAG_IM_MESSAGES_RETENTION_MS",
      DEFAULT_MESSAGE_RETENTION_MS,
    ),
    imMessageDeliveriesRetentionMs: configuredWorkerLimit(
      input.imMessageDeliveriesRetentionMs,
      "OPENTAG_IM_MESSAGE_DELIVERIES_RETENTION_MS",
      DEFAULT_DELIVERY_RETENTION_MS,
    ),
    slackWebhookReceiptsRetentionMs: configuredWorkerLimit(
      input.slackWebhookReceiptsRetentionMs,
      "OPENTAG_SLACK_WEBHOOK_RECEIPTS_RETENTION_MS",
      DEFAULT_RECEIPT_RETENTION_MS,
    ),
    feishuInboundReceiptsRetentionMs: configuredWorkerLimit(
      input.feishuInboundReceiptsRetentionMs,
      "OPENTAG_FEISHU_INBOUND_RECEIPTS_RETENTION_MS",
      DEFAULT_RECEIPT_RETENTION_MS,
    ),
  };
}

export function createImDeliveryMaintenanceScheduler(
  run: () => Promise<void>,
  supervisor: BackgroundFailureSupervisor | undefined,
  onDiagnostic: (code: string) => void,
  failureCode: string,
  operationName: string,
): () => void {
  let running = false;
  return () => {
    if (running) return;
    running = true;
    scheduleImDeliveryMaintenance(
      () =>
        run().finally(() => {
          running = false;
        }),
      supervisor,
      onDiagnostic,
      failureCode,
      operationName,
    );
  };
}

export function createImDeliveryMaintenanceSchedulers(input: {
  expiryRun: () => Promise<void>;
  retentionRun: () => Promise<void>;
  supervisor: BackgroundFailureSupervisor | undefined;
  onDiagnostic: (code: string) => void;
}): { expiry: () => void; retention: () => void } {
  return {
    expiry: createImDeliveryMaintenanceScheduler(
      input.expiryRun,
      input.supervisor,
      input.onDiagnostic,
      "IM_DELIVERY_WORKER_JANITOR_FAILED",
      "im-delivery-worker.janitor",
    ),
    retention: createImDeliveryMaintenanceScheduler(
      input.retentionRun,
      input.supervisor,
      input.onDiagnostic,
      "IM_DELIVERY_WORKER_RETENTION_FAILED",
      "im-delivery-worker.retention",
    ),
  };
}

function scheduleImDeliveryMaintenance(
  run: () => Promise<void>,
  supervisor: BackgroundFailureSupervisor | undefined,
  onDiagnostic: (code: string) => void,
  failureCode: string,
  operationName: string,
): void {
  const operation = run().catch((error: unknown) => {
    onDiagnostic(failureCode);
    throw error;
  });
  if (supervisor) {
    supervisor.track(operation, {
      code: failureCode,
      category: "internal",
      retryability: "backoff",
      phase: "worker",
      operation: operationName,
    });
    return;
  }
  void operation.catch(() => undefined);
}

export interface ImDeliveryJanitorOptions {
  clock: () => Date;
  expiryBatchSize: number;
  retentionBatchSize: number;
  imMessagesRetentionMs: number;
  imMessageDeliveriesRetentionMs: number;
  slackWebhookReceiptsRetentionMs: number;
  feishuInboundReceiptsRetentionMs: number;
}

export async function runImDeliveryExpiry(database: DatabaseClient, options: ImDeliveryJanitorOptions): Promise<void> {
  const now = options.clock().getTime();
  const expiryNow = new Date(now).toISOString();
  await database.execute(sql`
    with expired as (
      select id
      from im_message_deliveries
      where state = 'pending'
        and reason is null
        and expires_at <= ${expiryNow}::timestamptz
      order by expires_at asc, id asc
      limit ${options.expiryBatchSize}
      for update skip locked
    )
    update im_message_deliveries as delivery
    set state = 'expired', reason = 'ttl'
    from expired
    where delivery.id = expired.id
  `);
}

export async function runImDeliveryRetention(
  database: DatabaseClient,
  options: ImDeliveryJanitorOptions,
): Promise<void> {
  const now = options.clock().getTime();
  const imMessageDeliveriesCutoff = new Date(now - options.imMessageDeliveriesRetentionMs).toISOString();
  const imMessagesCutoff = new Date(now - options.imMessagesRetentionMs).toISOString();
  const slackWebhookReceiptsCutoff = new Date(now - options.slackWebhookReceiptsRetentionMs).toISOString();
  const feishuInboundReceiptsCutoff = new Date(now - options.feishuInboundReceiptsRetentionMs).toISOString();
  await database.transaction(async (transaction) => {
    await transaction.execute(sql`
      with candidates as (
        select delivery.id
        from im_message_deliveries as delivery
        where delivery.expires_at < ${imMessageDeliveriesCutoff}::timestamptz
          and (
            delivery.state in ('expired', 'terminal_rejected')
            or (delivery.state = 'accepted' and delivery.reported_at is not null)
            or (delivery.state = 'steered' and delivery.steered_at is not null)
          )
          and not exists (
            select 1
            from sessions as live_session
            where live_session.id = delivery.session_id
              and live_session.ended_at is null
          )
          and not exists (
            select 1
            from im_message_deliveries as child
            where child.steer_target_delivery_id = delivery.id
          )
        order by delivery.expires_at asc, delivery.id asc
        limit ${options.retentionBatchSize}
      )
      delete from im_message_deliveries as delivery
      using candidates
      where delivery.id = candidates.id
    `);
    await transaction.execute(sql`
      with candidates as (
        select message.id
        from im_messages as message
        where message.occurred_at < ${imMessagesCutoff}::timestamptz
          and not exists (
            select 1
            from im_message_deliveries as delivery
            where delivery.message_id = message.id
          )
        order by message.occurred_at asc, message.id asc
        limit ${options.retentionBatchSize}
      )
      delete from im_messages as message
      using candidates
      where message.id = candidates.id
    `);
    await transaction.execute(sql`
      with candidates as (
        select receipt.id
        from slack_webhook_receipts as receipt
        where receipt.received_at < ${slackWebhookReceiptsCutoff}::timestamptz
          and receipt.status in ('processed', 'failed')
        order by receipt.received_at asc, receipt.id asc
        limit ${options.retentionBatchSize}
      )
      delete from slack_webhook_receipts as receipt
      using candidates
      where receipt.id = candidates.id
    `);
    await transaction.execute(sql`
      with candidates as (
        select receipt.id
        from feishu_inbound_receipts as receipt
        where receipt.received_at < ${feishuInboundReceiptsCutoff}::timestamptz
          and receipt.status in ('processed', 'failed')
        order by receipt.received_at asc, receipt.id asc
        limit ${options.retentionBatchSize}
      )
      delete from feishu_inbound_receipts as receipt
      using candidates
      where receipt.id = candidates.id
    `);
  });
}

export async function runImDeliveryJanitor(database: DatabaseClient, options: ImDeliveryJanitorOptions): Promise<void> {
  await runImDeliveryExpiry(database, options);
  await runImDeliveryRetention(database, options);
}
