import { eq, sql } from "drizzle-orm";
import type { DatabaseClient } from "../db/client.js";
import { agents, computers, imBindings, imMessageDeliveries, sessionPlacements, sessions } from "../db/schema/index.js";
import type { BackgroundFailureSupervisor } from "../observability/background-failure-supervisor.js";
import { expireInboundReceiptWork } from "../services/im/inbound-receipt-work-store.js";
import { SessionService } from "../services/sessions/session-service.js";
import { settleSupersededPlacement, settleUnreportableTurn } from "./im-delivery-failure.js";
import { lockSteeredRecoverySessions, requeueSteeredDeliveries } from "./im-delivery-recovery.js";
import { ACCEPTED_REPORT_WINDOW_MS } from "./im-delivery-retry.js";
import type { ImDeliveryDiagnosticReporter } from "./im-delivery-worker.types.js";
import { PostgresRuntimeCustodyStore } from "./runtime-custody-store.js";

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

export async function runImDeliverySteerRecovery(
  database: DatabaseClient,
  options: Pick<ImDeliveryJanitorOptions, "clock" | "expiryBatchSize">,
  onDeliverySettled?: (deliveryId: string) => void,
): Promise<void> {
  const now = options.clock();
  const sessionService = new SessionService(database);
  const eligible = sql`
    exists (
      select 1 from im_message_deliveries as child
      where child.steer_target_delivery_id = target.id and ((child.state = 'steered' and coalesce(child.reason, '') <> 'batch_initial') or (child.state in ('pending', 'expired') and child.dispatch_payload ->> 'type' = 'im:steer'))
    )
    and (
      target.state <> 'accepted'
      or (target.reported_at is not null and coalesce(target.turn_report ->> 'outcome', 'unknown') <> 'completed')
    )
  `;
  const candidates = (await database.execute(sql`
    select target.id as target_id
    from im_message_deliveries as target
    where ${eligible}
    order by target.id asc
    limit ${options.expiryBatchSize}
  `)) as Array<{ target_id: string }>;
  for (const candidate of candidates) {
    const terminalizedIds = await database.transaction(async (transaction) => {
      const lockedSessions = await lockSteeredRecoverySessions(transaction, [candidate.target_id], {
        skipLocked: true,
      });
      if (lockedSessions.length === 0) return [];
      const [target] = (await transaction.execute(sql`
        select target.id as target_id
        from im_message_deliveries as target
        where target.id = ${candidate.target_id}::uuid
          and target.session_id in (${sql.join(
            lockedSessions.map((session) => sql`${session.id}::uuid`),
            sql`, `,
          )})
          and ${eligible}
        for update of target skip locked
      `)) as Array<{ target_id: string }>;
      if (!target) return [];
      const recovered = await requeueSteeredDeliveries(transaction, target.target_id, now, sessionService);
      return recovered.terminalizedIds;
    });
    for (const deliveryId of terminalizedIds) onDeliverySettled?.(deliveryId);
  }
}

/**
 * Settle accepted custody whose report-acceptance window has closed and whose authority chain the
 * work paths can no longer reach: an ended Session, an inactive binding, or a deleted Agent. Those
 * rows are outside `#recover`'s query and outside the selector, so nothing else would ever settle
 * them and they would be retried — or simply strand — for the retention lifetime.
 *
 * The fence is deliberately narrow: the row must be provably past the window (`accepted_at` older
 * than the platform maximum runtime plus its grace), unclaimed, and on a placement generation that
 * still matches, so the settlement goes through the same custody fence as a real report. A superseded
 * placement generation is out of reach here — see the proposal recorded for the placement rollover.
 */
export async function runImDeliveryOverdueSettlement(
  database: DatabaseClient,
  options: Pick<ImDeliveryJanitorOptions, "clock" | "expiryBatchSize">,
  onDiagnostic: ImDeliveryDiagnosticReporter = () => undefined,
  onDeliverySettled?: (deliveryId: string) => void,
): Promise<void> {
  const now = options.clock();
  const cutoff = new Date(now.getTime() - ACCEPTED_REPORT_WINDOW_MS).toISOString();
  const candidates = (await database.execute(sql`
    select delivery.id
    from im_message_deliveries as delivery
    inner join sessions as session on session.id = delivery.session_id
    inner join im_bindings as binding on binding.id = session.im_binding_id
    inner join agents as agent on agent.id = binding.agent_id
    inner join session_placements as placement on placement.session_id = session.id
    inner join computers as computer on computer.id = placement.computer_id
    where delivery.state = 'accepted'
      and computer.kind = 'local'
      and delivery.reported_at is null
      and delivery.turn_id is not null
      and delivery.report_owner_instance_id is not null
      and delivery.accepted_at <= ${cutoff}::timestamptz
      and coalesce(delivery.last_error_code, '') not like 'IM_DELIVERY_CLAIM_%'
      and (
        session.ended_at is not null
        or binding.status <> 'active'
        or agent.status = 'deleted'
        or delivery.placement_generation <> placement.generation
      )
    order by delivery.accepted_at asc, delivery.id asc
    limit ${options.expiryBatchSize}
  `)) as Array<{ id: string }>;
  if (candidates.length === 0) return;
  const custody = new PostgresRuntimeCustodyStore(database, { now: options.clock });
  const sessionService = new SessionService(database);
  for (const candidate of candidates) {
    const [row] = await database
      .select({
        delivery: imMessageDeliveries,
        session: sessions,
        placement: sessionPlacements,
        agent: agents,
        computer: computers,
      })
      .from(imMessageDeliveries)
      .innerJoin(sessions, eq(sessions.id, imMessageDeliveries.sessionId))
      .innerJoin(sessionPlacements, eq(sessionPlacements.sessionId, sessions.id))
      .innerJoin(imBindings, eq(imBindings.id, sessions.imBindingId))
      .innerJoin(agents, eq(agents.id, imBindings.agentId))
      .innerJoin(computers, eq(computers.id, sessionPlacements.computerId))
      .where(eq(imMessageDeliveries.id, candidate.id))
      .limit(1);
    if (!row) continue;
    const placementCurrent = row.delivery.placementGeneration === row.placement.generation;
    const settled = placementCurrent
      ? await settleUnreportableTurn({ custody, onDiagnostic }, row, "maintenance")
      : await settleSupersededPlacement(
          { database, now: () => now.getTime(), onDiagnostic, sessions: sessionService, onDeliverySettled },
          row.delivery.id,
        );
    // The superseded settlement notifies the delivery and every child it terminalized itself.
    if (settled && placementCurrent) onDeliverySettled?.(row.delivery.id);
  }
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
  onDiagnostic: ImDeliveryDiagnosticReporter,
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
  onDiagnostic: ImDeliveryDiagnosticReporter;
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
  onDiagnostic: ImDeliveryDiagnosticReporter,
  failureCode: string,
  operationName: string,
): void {
  const operation = run().catch((error: unknown) => {
    onDiagnostic(failureCode, { phase: "maintenance" });
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

export async function runImDeliveryExpiry(
  database: DatabaseClient,
  options: ImDeliveryJanitorOptions,
  onDeliverySettled?: (deliveryId: string) => void,
  onDiagnostic?: ImDeliveryDiagnosticReporter,
): Promise<void> {
  await runImDeliverySteerRecovery(database, options, onDeliverySettled);
  await runImDeliveryOverdueSettlement(database, options, onDiagnostic, onDeliverySettled);
  const now = options.clock().getTime();
  const expiryNow = new Date(now).toISOString();
  // A pending row has exactly one bounded deadline. Local rows expire at the ingress deadline.
  // Cloud rows that were never dispatched expire there too; a DISPATCHED Cloud row is owned by its
  // frozen execution window instead (the worker releases it when that window passed, after which
  // the ingress deadline applies), so this never expires input a Runner may still be executing.
  // Accepted-unreported custody is never pending and is never expired. A missing placement or
  // Computer row fails conservative. The guard precedes the batch limit so a dispatched Cloud
  // backlog cannot starve Local expiry.
  const expired = (await database.execute(sql`
    with expired as (
      select delivery.id
      from im_message_deliveries as delivery
      where delivery.state = 'pending'
        and delivery.reason is null
        and delivery.expires_at <= ${expiryNow}::timestamptz
        and (
          exists (
            select 1
            from session_placements as placement
            inner join computers as computer on computer.id = placement.computer_id
            where placement.session_id = delivery.session_id
              and computer.kind = 'local'
          )
          or (
            delivery.dispatch_request_id is null
            and exists (
              select 1
              from session_placements as placement
              inner join computers as computer on computer.id = placement.computer_id
              where placement.session_id = delivery.session_id
                and computer.kind = 'cloud'
            )
          )
        )
      order by delivery.expires_at asc, delivery.id asc
      limit ${options.expiryBatchSize}
      for update skip locked
    )
    update im_message_deliveries as delivery
    set state = 'expired', reason = 'ttl'
    from expired
    where delivery.id = expired.id
    returning delivery.id
  `)) as Array<{ id: string }>;
  for (const delivery of expired) onDeliverySettled?.(delivery.id);
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
  await expireInboundReceiptWork(database, new Date(now), options.retentionBatchSize);
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
    // Retire successfully cleared projections after custody retention removes their turns.
    // Unconfirmed cleanup on the current credential generation and active claims must survive.
    await transaction.execute(sql`
      with candidates as (
        select target.id
        from slack_working_targets as target
        where target.working = false
          and target.claim_id is null
          and target.next_attempt_at = '9999-12-31T00:00:00.000Z'::timestamptz
          and not exists (
            select 1 from slack_working_turns as turn where turn.target_id = target.id
          )
        order by target.id
        limit ${options.retentionBatchSize}
        for update skip locked
      )
      delete from slack_working_targets as target
      using candidates
      where target.id = candidates.id
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
          and receipt.work_payload is null
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
          and receipt.work_payload is null
        order by receipt.received_at asc, receipt.id asc
        limit ${options.retentionBatchSize}
      )
      delete from feishu_inbound_receipts as receipt
      using candidates
      where receipt.id = candidates.id
    `);
  });
}

export async function runImDeliveryJanitor(
  database: DatabaseClient,
  options: ImDeliveryJanitorOptions,
  onDeliverySettled?: (deliveryId: string) => void,
  onDiagnostic?: ImDeliveryDiagnosticReporter,
): Promise<void> {
  await runImDeliveryExpiry(database, options, onDeliverySettled, onDiagnostic);
  await runImDeliveryRetention(database, options);
}
