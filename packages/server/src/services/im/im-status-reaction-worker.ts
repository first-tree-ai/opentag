import { and, asc, desc, eq, isNotNull, lte, sql } from "drizzle-orm";
import type { DatabaseClient } from "../../db/client.js";
import { type ImStatusReaction, imBindings, imMessageDeliveries, imMessages } from "../../db/schema/index.js";
import type { ServiceLogger } from "../../observability/service-logger.js";
import type { ImProviderAdapter } from "../im-bindings/provider-adapter.js";

const BATCH_SIZE = 20;
const MAX_ATTEMPTS = 8;

function needsSync(delivery: typeof imMessageDeliveries.$inferSelect | undefined, now: Date) {
  return Boolean(
    delivery?.statusReactionDesired &&
      delivery.statusReactionDesired !== delivery.statusReactionApplied &&
      delivery.statusReactionRetryAt &&
      delivery.statusReactionRetryAt <= now,
  );
}

/** Provider feedback follows committed custody, independently of model execution and error tracking. */
export class ImStatusReactionWorker {
  readonly #database: DatabaseClient;
  readonly #resolveAdapter: (bindingId: string, generation: number) => Promise<ImProviderAdapter<unknown>>;
  readonly #logger: Pick<ServiceLogger, "warn">;
  readonly #now: () => Date;
  #timer?: ReturnType<typeof setInterval>;
  #running?: Promise<void>;
  #stopped = false;
  #wakeRequested = false;

  constructor(input: {
    database: DatabaseClient;
    resolveAdapter: (bindingId: string, generation: number) => Promise<ImProviderAdapter<unknown>>;
    logger: Pick<ServiceLogger, "warn">;
    now?: () => Date;
  }) {
    this.#database = input.database;
    this.#resolveAdapter = input.resolveAdapter;
    this.#logger = input.logger;
    this.#now = input.now ?? (() => new Date());
  }

  start(): void {
    if (this.#timer || this.#stopped) return;
    this.#timer = setInterval(() => this.wake(), 1_000);
    this.#timer.unref();
    this.wake();
  }

  /** A custody commit can request immediate feedback without waiting for a provider call. */
  wake(): void {
    if (this.#stopped) return;
    if (this.#running) {
      this.#wakeRequested = true;
      return;
    }
    this.#running = this.runOnce()
      .catch(() => this.#logger.warn({ code: "IM_STATUS_REACTION_SCAN_FAILED" }, "Status reaction scan failed"))
      .finally(() => {
        this.#running = undefined;
        if (this.#wakeRequested) {
          this.#wakeRequested = false;
          this.wake();
        }
      });
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    await this.#running;
  }

  async runOnce(): Promise<void> {
    const rows = await this.#database
      .select({ id: imMessageDeliveries.id })
      .from(imMessageDeliveries)
      .where(
        and(
          isNotNull(imMessageDeliveries.statusReactionDesired),
          sql`${imMessageDeliveries.statusReactionDesired} is distinct from ${imMessageDeliveries.statusReactionApplied}`,
          lte(imMessageDeliveries.statusReactionRetryAt, this.#now()),
        ),
      )
      .orderBy(asc(imMessageDeliveries.statusReactionRetryAt), asc(imMessageDeliveries.id))
      .limit(BATCH_SIZE);
    for (let offset = 0; offset < rows.length && !this.#stopped; offset += 4) {
      await Promise.all(rows.slice(offset, offset + 4).map((row) => this.#sync(row.id)));
    }
  }

  async #sync(deliveryId: string): Promise<void> {
    await this.#database.transaction(async (transaction) => {
      const [row] = await transaction
        .select({ delivery: imMessageDeliveries, message: imMessages, binding: imBindings })
        .from(imMessageDeliveries)
        .innerJoin(imMessages, eq(imMessages.id, imMessageDeliveries.messageId))
        .innerJoin(imBindings, eq(imBindings.id, imMessages.imBindingId))
        .where(eq(imMessageDeliveries.id, deliveryId));
      if (!row?.delivery.statusReactionDesired) return;
      // Serialize provider mutations across replicas and revisions without locking custody rows:
      // a slow reaction must never hold acceptance or the Turn Report transaction open.
      const [lock] = await transaction.execute<{ acquired: boolean }>(sql`
        select pg_try_advisory_xact_lock(hashtextextended(
          ${`im-status-reaction:${row.binding.id}:${row.message.channelId}:${row.message.externalMessageId}`}, 0
        )) as acquired
      `);
      if (!lock?.acquired) return;
      // Re-read after acquiring the provider-mutation lock; another replica may have synced it.
      const [current] = await transaction
        .select()
        .from(imMessageDeliveries)
        .where(eq(imMessageDeliveries.id, deliveryId));
      if (!needsSync(current, this.#now()) || !current?.statusReactionDesired) return;
      const [latest] = await transaction
        .select({ id: imMessageDeliveries.id })
        .from(imMessageDeliveries)
        .innerJoin(imMessages, eq(imMessages.id, imMessageDeliveries.messageId))
        .where(
          and(
            eq(imMessages.imBindingId, row.binding.id),
            eq(imMessages.channelId, row.message.channelId),
            eq(imMessages.externalMessageId, row.message.externalMessageId),
            isNotNull(imMessageDeliveries.statusReactionDesired),
          ),
        )
        .orderBy(desc(imMessageDeliveries.acceptedAt), desc(imMessageDeliveries.id))
        .limit(1);
      try {
        if (latest?.id === deliveryId && row.binding.status === "active") {
          await this.#apply(row.binding, row.message, current.statusReactionDesired);
        }
      } catch {
        const attempts = current.statusReactionAttempts + 1;
        await transaction
          .update(imMessageDeliveries)
          .set({
            statusReactionAttempts: attempts,
            statusReactionRetryAt:
              attempts < MAX_ATTEMPTS
                ? new Date(this.#now().getTime() + Math.min(60_000, 1_000 * 2 ** (attempts - 1)))
                : null,
          })
          .where(
            and(
              eq(imMessageDeliveries.id, deliveryId),
              eq(imMessageDeliveries.statusReactionDesired, current.statusReactionDesired),
            ),
          );
        // Provider exceptions can contain credentials; report only our own identifiers.
        this.#logger.warn({ deliveryId, attempts, code: "IM_STATUS_REACTION_FAILED" }, "Status reaction update failed");
        return;
      }
      await transaction
        .update(imMessageDeliveries)
        .set({ statusReactionApplied: current.statusReactionDesired, statusReactionRetryAt: null })
        .where(
          and(
            eq(imMessageDeliveries.id, deliveryId),
            eq(imMessageDeliveries.statusReactionDesired, current.statusReactionDesired),
          ),
        );
    });
  }

  async #apply(
    binding: typeof imBindings.$inferSelect,
    message: typeof imMessages.$inferSelect,
    status: ImStatusReaction,
  ) {
    const adapter = await this.#resolveAdapter(binding.id, binding.credentialGeneration);
    if (!adapter.setStatusReaction) throw new Error("IM_STATUS_REACTION_UNAVAILABLE");
    await adapter.setStatusReaction({
      channelId: message.channelId,
      messageExternalId: message.externalMessageId,
      status,
    });
  }
}
