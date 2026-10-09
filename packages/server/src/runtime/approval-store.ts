import { and, eq, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import type { DatabaseClient } from "../db/client.js";
import { runtimeApprovals } from "../db/schema/index.js";

export type PendingApproval = typeof runtimeApprovals.$inferSelect;
export interface ApprovalStore {
  insert(approval: PendingApproval): Promise<boolean>;
  find(id: string): Promise<PendingApproval | undefined>;
  update(
    id: string,
    expected: PendingApproval["status"],
    change: Partial<Pick<PendingApproval, "status" | "messageId" | "messageChannelId" | "cardUpdatedAt">>,
  ): Promise<boolean>;
  list(serverInstanceId: string): Promise<PendingApproval[]>;
  purge(before: Date): Promise<void>;
}
export class PostgresApprovalStore implements ApprovalStore {
  constructor(private readonly database: DatabaseClient) {}
  async insert(approval: PendingApproval) {
    return (
      (
        await this.database
          .insert(runtimeApprovals)
          .values(approval)
          .onConflictDoNothing()
          .returning({ id: runtimeApprovals.id })
      ).length === 1
    );
  }
  async find(id: string) {
    return (await this.database.select().from(runtimeApprovals).where(eq(runtimeApprovals.id, id)).limit(1))[0];
  }
  async update(
    id: string,
    expected: PendingApproval["status"],
    change: Partial<Pick<PendingApproval, "status" | "messageId" | "messageChannelId" | "cardUpdatedAt">>,
  ) {
    return (
      (
        await this.database
          .update(runtimeApprovals)
          .set(change)
          .where(and(eq(runtimeApprovals.id, id), eq(runtimeApprovals.status, expected)))
          .returning({ id: runtimeApprovals.id })
      ).length === 1
    );
  }
  list(serverInstanceId: string) {
    return this.database
      .select()
      .from(runtimeApprovals)
      .where(
        and(
          eq(runtimeApprovals.serverInstanceId, serverInstanceId),
          or(
            inArray(runtimeApprovals.status, ["pending", "accept", "decline"]),
            and(
              inArray(runtimeApprovals.status, ["approved", "denied", "stale"]),
              isNotNull(runtimeApprovals.messageId),
              isNull(runtimeApprovals.cardUpdatedAt),
            ),
          ),
        ),
      )
      .orderBy(
        sql`case when ${runtimeApprovals.status} in ('accept', 'decline') then 0 when ${runtimeApprovals.status} = 'pending' then 2 else 1 end`,
        runtimeApprovals.expiresAt,
        runtimeApprovals.id,
      )
      .limit(1024);
  }
  async purge(before: Date) {
    await this.database.delete(runtimeApprovals).where(lt(runtimeApprovals.expiresAt, before));
  }
}
