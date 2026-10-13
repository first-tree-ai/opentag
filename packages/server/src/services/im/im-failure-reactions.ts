import { and, eq, or, sql } from "drizzle-orm";
import type { DatabaseClient } from "../../db/client.js";
import { imBindings, imMessageDeliveries, imMessages } from "../../db/schema/index.js";
import type { ServiceLogger } from "../../observability/service-logger.js";
import type { ImProviderAdapter } from "../im-bindings/provider-adapter.js";

/** Best-effort feedback from existing terminal delivery events; the provider owns reaction state. */
export class ImFailureReactions {
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

  async sync(deliveryId: string): Promise<void> {
    try {
      const targets = await this.options.database
        .selectDistinct({
          bindingId: imBindings.id,
          generation: imBindings.credentialGeneration,
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
        const adapter = await this.options.resolveAdapter(target.bindingId, target.generation);
        if (!adapter.setFailureReaction) throw new Error("IM_FAILURE_REACTION_UNSUPPORTED");
        const setFailureReaction = adapter.setFailureReaction.bind(adapter);
        await this.options.database.transaction(async (tx) => {
          // Serialize provider writes across replicas, then read current facts. A late failure
          // notification cannot overwrite the successful processing of a newer revision.
          const key = `im-failure-reaction:${JSON.stringify([target.bindingId, target.channelId, target.externalMessageId])}`;
          await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
          const [outcome] = (await tx.execute(sql`
            select case when d.state in ('expired', 'terminal_rejected') then true
                else coalesce(root.turn_report, d.turn_report) ->> 'outcome' <> 'completed' end as failed
            from im_message_deliveries d
            inner join im_messages m on m.id = d.message_id
            inner join im_bindings b on b.id = m.im_binding_id
            inner join sessions s on s.id = d.session_id
            left join im_message_deliveries root on root.id = d.steer_target_delivery_id
            where m.im_binding_id = ${target.bindingId}::uuid and m.channel_id = ${target.channelId}
              and m.external_message_id = ${target.externalMessageId} and b.status = 'active'
              and b.credential_generation = ${target.generation}
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
          `)) as Array<{ failed: boolean }>;
          if (!outcome) return;
          await setFailureReaction({
            channelId: target.channelId,
            externalMessageId: target.externalMessageId,
            failed: outcome.failed,
          });
        });
      }
    } catch {
      this.options.logger.warn({ code: "IM_FAILURE_REACTION_FAILED" }, "IM failure reaction update failed");
    }
  }
}
