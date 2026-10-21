import { and, eq, or, sql } from "drizzle-orm";
import type { DatabaseClient } from "../../db/client.js";
import { imBindings, imMessageDeliveries, imMessages } from "../../db/schema/index.js";
import type { ServiceLogger } from "../../observability/service-logger.js";
import { KeyedTaskScheduler } from "../../runtime/keyed-task-scheduler.js";
import type { ImProviderAdapter } from "../im-bindings/provider-adapter.js";

type ReactionTarget = Pick<typeof imMessages.$inferSelect, "channelId" | "externalMessageId"> & { bindingId: string };
type ReactionOutcome = { generation: number; failed: boolean };

/** Best-effort feedback from existing terminal delivery events; the provider owns reaction state. */
export class ImFailureReactions {
  readonly #scheduler = new KeyedTaskScheduler({ maxConcurrent: 1, maxQueuedPerKey: 1, maxQueuedTotal: 256 });
  readonly #pending = new Map<string, Promise<void>>();
  #closed = false;
  constructor(
    readonly options: {
      database: DatabaseClient;
      resolveAdapter(bindingId: string, generation: number): Promise<ImProviderAdapter<unknown>>;
      logger: Pick<ServiceLogger, "warn">;
    },
  ) {}

  notify(deliveryId: string): void {
    void this.sync(deliveryId);
  }

  sync(deliveryId: string): Promise<void> {
    if (this.#closed) return Promise.resolve();
    const pending = this.#pending.get(deliveryId);
    if (pending) return pending;
    let finish = () => {};
    const promise = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const settle = () => {
      this.#pending.delete(deliveryId);
      finish();
    };
    this.#pending.set(deliveryId, promise);
    const accepted = this.#scheduler.enqueue(
      deliveryId,
      async () => {
        try {
          await this.#syncDelivery(deliveryId);
        } finally {
          settle();
        }
      },
      settle,
    );
    if (!accepted) {
      settle();
      this.#failed();
    }
    return promise;
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#scheduler.close();
    await Promise.all(this.#pending.values());
  }

  async #syncDelivery(deliveryId: string): Promise<void> {
    try {
      const targets = await this.options.database
        .selectDistinct({
          bindingId: imBindings.id,
          channelId: imMessages.channelId,
          externalMessageId: imMessages.externalMessageId,
        })
        .from(imMessageDeliveries)
        .innerJoin(imMessages, eq(imMessages.id, imMessageDeliveries.messageId))
        .innerJoin(imBindings, eq(imBindings.id, imMessages.imBindingId))
        .where(
          and(
            eq(imBindings.status, "active"),
            eq(imMessageDeliveries.attention, "direct"),
            eq(imMessages.direction, "inbound"),
            eq(imMessages.authorKind, "human"),
            or(eq(imMessageDeliveries.id, deliveryId), eq(imMessageDeliveries.steerTargetDeliveryId, deliveryId)),
          ),
        );
      for (const target of targets) {
        if (this.#closed) return;
        await this.#apply(target).catch(() => this.#failed());
      }
    } catch {
      this.#failed();
    }
  }

  async #apply(target: ReactionTarget): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (this.#closed) return;
      const outcome = await this.#outcome(target);
      if (!outcome) return;
      const adapter = await this.options.resolveAdapter(target.bindingId, outcome.generation);
      if (!adapter.setFailureReaction) throw new Error("IM_FAILURE_REACTION_UNSUPPORTED");
      // No connection or transaction is held during provider I/O. Re-read after writing so a
      // delayed write on another replica converges to the current outcome in a bounded pass.
      await adapter.setFailureReaction({
        channelId: target.channelId,
        externalMessageId: target.externalMessageId,
        failed: outcome.failed,
      });
      const current = await this.#outcome(target);
      if (this.#closed || !current || (current.failed === outcome.failed && current.generation === outcome.generation))
        return;
    }
    this.#failed();
  }

  async #outcome(target: ReactionTarget): Promise<ReactionOutcome | undefined> {
    const [outcome] = (await this.options.database.execute(sql`
            select b.credential_generation as generation,
              case when d.state in ('expired', 'terminal_rejected') then true
                else coalesce(root.turn_report, d.turn_report) ->> 'outcome' <> 'completed' end as failed
            from im_message_deliveries d
            inner join im_messages m on m.id = d.message_id
            inner join im_bindings b on b.id = m.im_binding_id
            inner join sessions s on s.id = d.session_id
            left join im_message_deliveries root on root.id = d.steer_target_delivery_id
            where m.im_binding_id = ${target.bindingId}::uuid and m.channel_id = ${target.channelId}
              and m.external_message_id = ${target.externalMessageId} and b.status = 'active'
              and m.direction = 'inbound' and m.author_kind = 'human' and m.operation <> 'deleted'
              and d.attention = 'direct' and s.kind <> 'internal'
              and coalesce(d.dispatch_payload ->> 'replyRole', '') <> 'observer'
              and not (s.kind = 'channel' and m.thread_key is not null and exists (
                select 1 from im_message_deliveries sibling
                inner join sessions owner on owner.id = sibling.session_id
                where sibling.message_id = m.id and owner.kind = 'thread' and owner.thread_key = m.thread_key
              ))
              and (
                (d.state in ('expired', 'terminal_rejected') and coalesce(d.reason, '') <> 'cancelled')
                or (d.state = 'accepted' and d.reported_at is not null and d.turn_report ->> 'outcome' <> 'cancelled')
                or (d.state = 'steered' and root.reported_at is not null and root.turn_report ->> 'outcome' = 'completed')
              )
            order by m.occurred_at desc, m.received_at desc,
              coalesce(root.reported_at, d.reported_at, d.expires_at) desc, d.id desc
            limit 1
          `)) as Array<{ generation: string; failed: boolean }>;
    return outcome ? { generation: Number(outcome.generation), failed: outcome.failed } : undefined;
  }

  #failed(): void {
    this.options.logger.warn({ code: "IM_FAILURE_REACTION_FAILED" }, "IM failure reaction update failed");
  }
}
