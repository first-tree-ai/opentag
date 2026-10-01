import { sql } from "drizzle-orm";
import type { DatabaseTransaction } from "../db/client.js";

export const STEER_TARGET_ENDED_ERROR_CODE = "IM_DELIVERY_STEER_TARGET_ENDED";

/**
 * Return steered children to the normal queue in message order.
 *
 * The state predicate makes this operation idempotent: a terminal Turn report and the janitor may
 * race, but only the transaction that still sees `steered` rows changes them. The one-millisecond
 * offsets keep the original message order while leaving every recovered row immediately claimable.
 */
export async function requeueSteeredDeliveries(
  transaction: DatabaseTransaction,
  targetDeliveryId: string,
  now: Date,
): Promise<string[]> {
  const rows = (await transaction.execute(sql`
    with candidates as (
      select
        child.id,
        row_number() over (
          order by message.occurred_at asc, message.provider_revision_key asc, message.id asc, child.id asc
        ) as sequence,
        count(*) over () as total
      from im_message_deliveries as child
      inner join im_messages as message on message.id = child.message_id
      where child.state = 'steered'
        and child.steer_target_delivery_id = ${targetDeliveryId}
    ),
    updated as (
      update im_message_deliveries as child
      set state = 'pending',
          attempt_count = child.attempt_count + 1,
          dispatch_request_id = null,
          dispatch_input_hash = null,
          dispatch_payload = null,
          input_hash = null,
          steer_target_delivery_id = null,
          steered_at = null,
          next_attempt_at = ${now.toISOString()}::timestamptz
            - ((candidates.total - candidates.sequence) * interval '1 millisecond'),
          reason = null,
          last_error_code = ${STEER_TARGET_ENDED_ERROR_CODE}
      from candidates
      where child.id = candidates.id
        and child.state = 'steered'
        and child.steer_target_delivery_id = ${targetDeliveryId}
      returning child.id
    )
    select id from updated
  `)) as Array<{ id: string }>;
  return rows.map((row) => row.id);
}
