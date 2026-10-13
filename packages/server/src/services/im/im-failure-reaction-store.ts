import { randomUUID } from "node:crypto";
import { and, eq, gt, isNull, lte, or, sql } from "drizzle-orm";
import type { DatabaseClient } from "../../db/client.js";
import { imBindings, imFailureReactions } from "../../db/schema/index.js";

export type FailureReactionTarget = typeof imFailureReactions.$inferSelect;

/** Reconciles retained delivery facts; provider calls never participate in custody transactions. */
export class ImFailureReactionStore {
  constructor(
    readonly database: DatabaseClient,
    readonly now: () => Date = () => new Date(),
  ) {}

  async reconcile(): Promise<void> {
    // A retry remains pending until it has a terminal outcome. Keep the old marker during that
    // interval. Select the latest terminal revision, never an unrelated later message or an
    // observer's outcome. Steered input succeeds only when its owning root Turn completes.
    await this.database.execute(sql`
      with outcomes as (
        select distinct on (m.im_binding_id, m.channel_id, m.external_message_id)
          m.im_binding_id, m.channel_id, m.external_message_id, b.credential_generation,
          case
            when m.operation = 'deleted' then false
            when d.state in ('expired', 'terminal_rejected') then true
            else coalesce(root.turn_report, d.turn_report) ->> 'outcome' <> 'completed'
          end as desired
        from im_message_deliveries d
        inner join im_messages m on m.id = d.message_id
        inner join im_bindings b on b.id = m.im_binding_id
        inner join sessions s on s.id = d.session_id
        left join im_message_deliveries root on root.id = d.steer_target_delivery_id
        where b.status = 'active' and m.direction = 'inbound' and m.author_kind = 'human'
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
        order by m.im_binding_id, m.channel_id, m.external_message_id,
          m.occurred_at desc, m.received_at desc, coalesce(root.reported_at, d.reported_at, d.expires_at) desc, d.id desc
      )
      insert into im_failure_reactions (binding_id, channel_id, external_message_id, credential_generation, desired, next_attempt_at)
      select o.im_binding_id, o.channel_id, o.external_message_id, o.credential_generation, o.desired, ${this.now().toISOString()}::timestamptz
      from outcomes o
      where o.desired or exists (
        select 1 from im_failure_reactions r where r.binding_id = o.im_binding_id
          and r.channel_id = o.channel_id and r.external_message_id = o.external_message_id
      )
      on conflict (binding_id, channel_id, external_message_id) do update
      set desired = excluded.desired, credential_generation = excluded.credential_generation,
        applied = case when im_failure_reactions.credential_generation <> excluded.credential_generation then null else im_failure_reactions.applied end,
        revision = im_failure_reactions.revision + 1, failures = 0, next_attempt_at = ${this.now().toISOString()}::timestamptz
      where im_failure_reactions.desired <> excluded.desired
        or im_failure_reactions.credential_generation <> excluded.credential_generation
    `);
  }

  async claim(): Promise<FailureReactionTarget | undefined> {
    return this.database.transaction(async (tx) => {
      const now = this.now();
      const [target] = await tx
        .select({ target: imFailureReactions })
        .from(imFailureReactions)
        .innerJoin(imBindings, eq(imBindings.id, imFailureReactions.bindingId))
        .where(
          and(
            eq(imBindings.status, "active"),
            eq(imBindings.credentialGeneration, imFailureReactions.credentialGeneration),
            lte(imFailureReactions.nextAttemptAt, now),
            or(isNull(imFailureReactions.applied), sql`${imFailureReactions.applied} <> ${imFailureReactions.desired}`),
            or(isNull(imFailureReactions.claimExpiresAt), lte(imFailureReactions.claimExpiresAt, now)),
          ),
        )
        .orderBy(imFailureReactions.nextAttemptAt)
        .limit(1)
        .for("update", { of: imFailureReactions, skipLocked: true });
      if (!target) return;
      const [claimed] = await tx
        .update(imFailureReactions)
        .set({
          claimId: randomUUID(),
          claimExpiresAt: new Date(now.getTime() + 30_000),
          applied: null,
        })
        .where(eq(imFailureReactions.id, target.target.id))
        .returning();
      return claimed;
    });
  }

  async ownsClaim(target: FailureReactionTarget): Promise<boolean> {
    if (!target.claimId) return false;
    const [row] = await this.database
      .select({ id: imFailureReactions.id })
      .from(imFailureReactions)
      .innerJoin(imBindings, eq(imBindings.id, imFailureReactions.bindingId))
      .where(
        and(
          eq(imFailureReactions.id, target.id),
          eq(imFailureReactions.claimId, target.claimId),
          eq(imFailureReactions.revision, target.revision),
          eq(imBindings.status, "active"),
          eq(imBindings.credentialGeneration, target.credentialGeneration),
          gt(imFailureReactions.claimExpiresAt, new Date(this.now().getTime() + 10_000)),
        ),
      );
    return row !== undefined;
  }

  async settle(target: FailureReactionTarget, delayMs?: number): Promise<void> {
    if (!target.claimId) return;
    const now = this.now();
    const sameRevision = sql`${imFailureReactions.revision} = ${target.revision}`;
    await this.database
      .update(imFailureReactions)
      .set({
        claimId: null,
        claimExpiresAt: null,
        applied:
          delayMs === undefined ? sql`case when ${sameRevision} then ${target.desired}::boolean else null end` : null,
        failures: sql`case when ${sameRevision} then ${delayMs === undefined ? 0 : target.failures + 1} else 0 end`,
        nextAttemptAt: sql`case when ${sameRevision} then ${new Date(now.getTime() + (delayMs ?? 0)).toISOString()}::timestamptz else ${now.toISOString()}::timestamptz end`,
      })
      .where(and(eq(imFailureReactions.id, target.id), eq(imFailureReactions.claimId, target.claimId)));
  }
}
