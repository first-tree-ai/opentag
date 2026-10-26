/**
 * Maintenance of `session_descendants.descendant_active`.
 *
 * Invariant: for every closure row, `descendant_active` equals `(descendant.ended_at is null)`. The
 * internal-Session page orders by the closure alone, so an ended child that kept an active flag would be
 * returned, and a partial activity index that still contained it would bring back the ended-history scan
 * the flag exists to remove.
 *
 * Every writer of `sessions.ended_at` calls this function inside its own transaction, after the rows it
 * ends. There is no separate reactivation path: a later `ensureChatSession` creates a new Session identity
 * instead of clearing `ended_at`, and a new writer that clears it must call this function with the same
 * derived predicate.
 *
 * The update derives from `sessions` instead of an ID list on purpose. Under Read Committed the ending
 * statement and this statement see different snapshots, so an internal Session created concurrently is
 * either invisible to both — it keeps `ended_at = null` and an active flag — or its closure rows are
 * already committed and the ending statement saw the Session too. A scope-wide derived update cannot mark
 * a live descendant inactive, and it repairs rows an earlier binary left behind.
 */
import { sql } from "drizzle-orm";
import type { DatabaseClient, DatabaseTransaction } from "../../db/client.js";

export type EndedSessionScope = { agentId: string } | { imBindingId: string };

export async function markEndedDescendantsInactive(
  executor: DatabaseClient | DatabaseTransaction,
  scope: EndedSessionScope,
): Promise<void> {
  const scopePredicate =
    "imBindingId" in scope
      ? sql`s."im_binding_id" = ${scope.imBindingId}::uuid`
      : sql`s."im_binding_id" in (select b."id" from "im_bindings" as b where b."agent_id" = ${scope.agentId}::uuid)`;
  await executor.execute(sql`
    update "session_descendants" as d
    set "descendant_active" = false
    from "sessions" as s
    where d."descendant_session_id" = s."id"
      and d."descendant_active"
      and s."ended_at" is not null
      and ${scopePredicate}
  `);
}
