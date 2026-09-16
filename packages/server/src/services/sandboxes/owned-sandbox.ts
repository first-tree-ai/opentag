import { and, eq, isNull } from "drizzle-orm";
import type { DatabaseClient, DatabaseTransaction } from "../../db/client.js";
import { agents, computers, imBindings, sandboxes, sessionPlacements, sessions, users } from "../../db/schema/index.js";

export type OwnedSandboxRow = {
  sandbox: typeof sandboxes.$inferSelect;
  sessionId: string;
  computerId: string;
  conversationKind: string;
};

/**
 * `read` is ownership alone: an Account may always read status and stop an environment it owns,
 * even after the Agent/binding/Session/Account was suspended or ended, because cleanup must keep
 * working. `manage` additionally requires the whole authority chain to be active RIGHT NOW —
 * start, execute, and Runner connect/readiness/results all use it.
 */
export type SandboxAuthority = "read" | "manage";

/**
 * The single ownership authority for Sandbox-scoped operations: the Sandbox's Session must sit on
 * a Cloud Computer the Account owns, reached through the binding chain. Never trust a
 * caller-supplied Account; ownership is derived from the authenticated Account id only.
 *
 * With `lock`, only the Sandbox row itself is locked. The ownership joins are read in the same
 * transaction but never `FOR UPDATE`, so no lock is ever taken on Agent -> binding -> Computer in
 * a different order than the ensure/placement paths; concurrent writes to those rows are still
 * observed as a consistent snapshot at statement time.
 */
export async function loadOwnedSandbox(
  executor: DatabaseTransaction | DatabaseClient,
  accountId: string,
  sandboxId: string,
  options: { lock?: boolean; authority?: SandboxAuthority } = {},
): Promise<OwnedSandboxRow | undefined> {
  const authority = options.authority ?? "read";
  if (!options.lock) return ownedByAccount(executor, accountId, sandboxId, authority);
  const [locked] = await executor.select().from(sandboxes).where(eq(sandboxes.id, sandboxId)).limit(1).for("update");
  if (!locked) return undefined;
  const owned = await ownedByAccount(executor, accountId, sandboxId, authority);
  if (!owned) return undefined;
  return { ...owned, sandbox: locked };
}

async function ownedByAccount(
  executor: DatabaseTransaction | DatabaseClient,
  accountId: string,
  sandboxId: string,
  authority: SandboxAuthority,
): Promise<OwnedSandboxRow | undefined> {
  const [row] = await executor
    .select({
      sandbox: sandboxes,
      sessionId: sessions.id,
      computerId: computers.id,
      conversationKind: sessions.conversationKind,
    })
    .from(sandboxes)
    .innerJoin(sessions, eq(sessions.id, sandboxes.sessionId))
    .innerJoin(sessionPlacements, eq(sessionPlacements.sessionId, sessions.id))
    .innerJoin(imBindings, eq(imBindings.id, sessions.imBindingId))
    .innerJoin(agents, eq(agents.id, imBindings.agentId))
    .innerJoin(computers, eq(computers.id, agents.computerId))
    .innerJoin(users, eq(users.id, agents.createdByUserId))
    .where(and(eq(sandboxes.id, sandboxId), eq(agents.createdByUserId, accountId), ...authorityGuards(authority)))
    .limit(1);
  return row;
}

/**
 * The CURRENT authority chain for one Sandbox, without an Account filter: a Runner's bootstrap
 * claims name the Sandbox, and the Server proves the Sandbox still belongs to an active
 * Pi Agent on an active binding inside an ended-free Session of a non-suspended Account.
 */
export async function loadManagedSandboxById(
  executor: DatabaseTransaction | DatabaseClient,
  sandboxId: string,
): Promise<OwnedSandboxRow | undefined> {
  const [row] = await executor
    .select({
      sandbox: sandboxes,
      sessionId: sessions.id,
      computerId: computers.id,
      conversationKind: sessions.conversationKind,
    })
    .from(sandboxes)
    .innerJoin(sessions, eq(sessions.id, sandboxes.sessionId))
    .innerJoin(sessionPlacements, eq(sessionPlacements.sessionId, sessions.id))
    .innerJoin(imBindings, eq(imBindings.id, sessions.imBindingId))
    .innerJoin(agents, eq(agents.id, imBindings.agentId))
    .innerJoin(computers, eq(computers.id, agents.computerId))
    .innerJoin(users, eq(users.id, agents.createdByUserId))
    .where(and(eq(sandboxes.id, sandboxId), ...authorityGuards("manage")))
    .limit(1);
  return row;
}

function authorityGuards(authority: SandboxAuthority) {
  const guards = [
    eq(computers.ownerAccountId, agents.createdByUserId),
    eq(computers.kind, "cloud"),
    eq(sessionPlacements.computerId, computers.id),
  ];
  if (authority === "read") return guards;
  return [
    ...guards,
    eq(agents.status, "active"),
    eq(agents.runtimeProvider, "pi"),
    eq(imBindings.status, "active"),
    isNull(sessions.endedAt),
    isNull(users.suspendedAt),
  ];
}
