import { and, eq, gt, inArray, isNotNull, isNull, lt, lte, or, sql } from "drizzle-orm";
import type { DatabaseClient } from "../db/client.js";
import { computers, runtimeApprovals } from "../db/schema/index.js";

export type PendingApproval = typeof runtimeApprovals.$inferSelect;
export interface ApprovalStore {
  insert(approval: PendingApproval): Promise<"inserted" | "duplicate" | "stale">;
  deliver(approval: PendingApproval, send: () => Promise<void>): Promise<boolean>;
  find(id: string): Promise<PendingApproval | undefined>;
  update(
    id: string,
    expected: PendingApproval["status"],
    change: Partial<Pick<PendingApproval, "status" | "messageId" | "messageChannelId" | "cardUpdatedAt">>,
  ): Promise<boolean>;
  list(serverInstanceId: string): Promise<PendingApproval[]>;
  invalidateExpired(now: Date): Promise<void>;
  purge(before: Date): Promise<void>;
}
export class PostgresApprovalStore implements ApprovalStore {
  constructor(private readonly database: DatabaseClient) {}
  async insert(approval: PendingApproval) {
    return this.database.transaction(async (transaction) => {
      const [computer] = await transaction
        .select()
        .from(computers)
        .where(eq(computers.id, approval.computerId))
        .for("update");
      if (!isCurrentConnection(computer, approval)) return "stale" as const;
      const inserted = await transaction
        .insert(runtimeApprovals)
        .values(approval)
        .onConflictDoNothing()
        .returning({ id: runtimeApprovals.id });
      return inserted.length === 1 ? ("inserted" as const) : ("duplicate" as const);
    });
  }
  async deliver(approval: PendingApproval, send: () => Promise<void>): Promise<boolean> {
    return this.database.transaction(async (transaction) => {
      // Registration takes this same row lock before replacing the durable connection and staling approvals.
      const [computer] = await transaction
        .select()
        .from(computers)
        .where(eq(computers.id, approval.computerId))
        .for("update");
      if (!isCurrentConnection(computer, approval)) return false;
      const [current] = await transaction
        .select({ id: runtimeApprovals.id })
        .from(runtimeApprovals)
        .where(
          and(
            eq(runtimeApprovals.id, approval.id),
            eq(runtimeApprovals.serverInstanceId, approval.serverInstanceId),
            eq(runtimeApprovals.status, approval.status),
            gt(runtimeApprovals.expiresAt, new Date()),
          ),
        )
        .for("update");
      if (!current) return false;
      await send();
      return true;
    });
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
        or(
          and(
            eq(runtimeApprovals.serverInstanceId, serverInstanceId),
            inArray(runtimeApprovals.status, ["pending", "accept", "decline"]),
          ),
          and(
            inArray(runtimeApprovals.status, ["approved", "denied", "stale"]),
            isNotNull(runtimeApprovals.messageId),
            isNull(runtimeApprovals.cardUpdatedAt),
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
  async invalidateExpired(now: Date): Promise<void> {
    await this.database
      .update(runtimeApprovals)
      .set({ status: "stale" })
      .where(
        and(lte(runtimeApprovals.expiresAt, now), inArray(runtimeApprovals.status, ["pending", "accept", "decline"])),
      );
  }
  async purge(before: Date) {
    await this.database.delete(runtimeApprovals).where(lt(runtimeApprovals.expiresAt, before));
  }
}

function isCurrentConnection(computer: typeof computers.$inferSelect | undefined, approval: PendingApproval): boolean {
  return Boolean(
    computer &&
      computer.currentInstanceId === approval.instanceId &&
      computer.currentConnectionId === approval.connectionId &&
      !computer.deletedAt &&
      !computer.disconnectedAt,
  );
}
