import { and, eq, isNull } from "drizzle-orm";
import type { DatabaseClient, DatabaseTransaction } from "../../db/client.js";
import { agents, computers, imBindings, sandboxes, sessionPlacements, sessions, users } from "../../db/schema/index.js";

export type OwnedSandboxRow = {
  sandbox: typeof sandboxes.$inferSelect;
  sessionId: string;
  computerId: string;
  agentRevision: number;
  conversationKind: string;
};

/**
 * `read` is ownership alone: an Account may always read status and stop an environment it owns,
 * even after the Agent/binding/Session/Account was suspended or ended, because cleanup must keep
 * working. `manage` additionally requires the whole authority chain to be active RIGHT NOW —
 * start, execute, and Runner connect/readiness/results all use it.
 */
export type SandboxAuthority = "read" | "manage";

/** Physical ownership follows retained placement; new execution also requires current authority. */
export async function loadOwnedSandbox(
  executor: DatabaseTransaction | DatabaseClient,
  accountId: string,
  sandboxId: string,
  options: { lock?: boolean; authority?: SandboxAuthority; expectedAgentRevision?: number } = {},
): Promise<OwnedSandboxRow | undefined> {
  const authority = options.authority ?? "read";
  if (!options.lock) return ownedByAccount(executor, accountId, sandboxId, authority);
  if (
    authority === "manage" &&
    !(await lockManagedAuthority(executor, accountId, sandboxId, options.expectedAgentRevision))
  )
    return undefined;
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
      agentRevision: agents.revision,
      conversationKind: sessions.conversationKind,
    })
    .from(sandboxes)
    .innerJoin(sessions, eq(sessions.id, sandboxes.sessionId))
    .innerJoin(sessionPlacements, eq(sessionPlacements.sessionId, sessions.id))
    .innerJoin(imBindings, eq(imBindings.id, sessions.imBindingId))
    .innerJoin(agents, eq(agents.id, imBindings.agentId))
    .innerJoin(computers, eq(computers.id, sessionPlacements.computerId))
    .innerJoin(users, eq(users.id, agents.createdByUserId))
    .where(and(eq(sandboxes.id, sandboxId), eq(computers.ownerAccountId, accountId), ...authorityGuards(authority)))
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
      agentRevision: agents.revision,
      conversationKind: sessions.conversationKind,
    })
    .from(sandboxes)
    .innerJoin(sessions, eq(sessions.id, sandboxes.sessionId))
    .innerJoin(sessionPlacements, eq(sessionPlacements.sessionId, sessions.id))
    .innerJoin(imBindings, eq(imBindings.id, sessions.imBindingId))
    .innerJoin(agents, eq(agents.id, imBindings.agentId))
    .innerJoin(computers, eq(computers.id, sessionPlacements.computerId))
    .innerJoin(users, eq(users.id, agents.createdByUserId))
    .where(and(eq(sandboxes.id, sandboxId), ...authorityGuards("manage")))
    .limit(1);
  return row;
}

/**
 * The persisted Sandbox row for one Session WITHOUT the active authority chain. Accepted-turn
 * recovery must keep working after an explicit Session end or Agent suspend: the durable stopped
 * state plus the exact prior allocation identity is the reconciliation authority there, never a
 * freshly re-derived "is this Session active". Ownership/authority is checked by the caller when
 * it needs to start or accept new work.
 */
export async function loadSandboxRecordBySessionId(
  executor: DatabaseTransaction | DatabaseClient,
  sessionId: string,
): Promise<typeof sandboxes.$inferSelect | undefined> {
  const [row] = await executor.select().from(sandboxes).where(eq(sandboxes.sessionId, sessionId)).limit(1);
  return row;
}

/** Sandbox-row lookup by primary key without the authority chain (same recovery boundary). */
export async function loadSandboxRecordById(
  executor: DatabaseTransaction | DatabaseClient,
  sandboxId: string,
): Promise<typeof sandboxes.$inferSelect | undefined> {
  const [row] = await executor.select().from(sandboxes).where(eq(sandboxes.id, sandboxId)).limit(1);
  return row;
}

/**
 * Ownership facts (Sandbox + Session + Computer) without the active authority chain. Used where
 * only the exact persisted allocation identity matters (report-capable channel authority), never
 * to start new work.
 */
export async function loadSandboxOwnerById(
  executor: DatabaseTransaction | DatabaseClient,
  sandboxId: string,
): Promise<{ sandbox: typeof sandboxes.$inferSelect; sessionId: string; computerId: string } | undefined> {
  const [row] = await executor
    .select({
      sandbox: sandboxes,
      sessionId: sessions.id,
      computerId: computers.id,
    })
    .from(sandboxes)
    .innerJoin(sessions, eq(sessions.id, sandboxes.sessionId))
    .innerJoin(sessionPlacements, eq(sessionPlacements.sessionId, sessions.id))
    .innerJoin(computers, eq(computers.id, sessionPlacements.computerId))
    .where(eq(sandboxes.id, sandboxId))
    .limit(1);
  return row;
}

/** Session-keyed variant of `loadManagedSandboxById` for Cloud delivery dispatch. */
export async function loadManagedSandboxBySessionId(
  executor: DatabaseTransaction | DatabaseClient,
  sessionId: string,
): Promise<OwnedSandboxRow | undefined> {
  const [row] = await executor
    .select({
      sandbox: sandboxes,
      sessionId: sessions.id,
      computerId: computers.id,
      agentRevision: agents.revision,
      conversationKind: sessions.conversationKind,
    })
    .from(sandboxes)
    .innerJoin(sessions, eq(sessions.id, sandboxes.sessionId))
    .innerJoin(sessionPlacements, eq(sessionPlacements.sessionId, sessions.id))
    .innerJoin(imBindings, eq(imBindings.id, sessions.imBindingId))
    .innerJoin(agents, eq(agents.id, imBindings.agentId))
    .innerJoin(computers, eq(computers.id, sessionPlacements.computerId))
    .innerJoin(users, eq(users.id, agents.createdByUserId))
    .where(and(eq(sandboxes.sessionId, sessionId), ...authorityGuards("manage")))
    .limit(1);
  return row;
}

function authorityGuards(authority: SandboxAuthority) {
  const guards = [eq(computers.kind, "cloud")];
  if (authority === "read") return guards;
  return [
    ...guards,
    eq(computers.id, agents.computerId),
    eq(computers.ownerAccountId, agents.createdByUserId),
    eq(agents.status, "active"),
    eq(agents.runtimeProvider, "pi"),
    eq(imBindings.status, "active"),
    isNull(sessions.endedAt),
    isNull(users.suspendedAt),
  ];
}

// Reservation callers take capacity admission before these guards and lock Sandbox afterward.
async function lockManagedAuthority(
  executor: DatabaseClient | DatabaseTransaction,
  accountId: string,
  sandboxId: string,
  expectedAgentRevision: number | undefined,
): Promise<boolean> {
  const [account] = await executor
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, accountId), isNull(users.suspendedAt)))
    .limit(1)
    .for("no key update");
  if (!account) return false;
  const [route] = await executor
    .select({ sessionId: sessions.id, bindingId: imBindings.id, agentId: imBindings.agentId })
    .from(sandboxes)
    .innerJoin(sessions, eq(sessions.id, sandboxes.sessionId))
    .innerJoin(imBindings, eq(imBindings.id, sessions.imBindingId))
    .where(eq(sandboxes.id, sandboxId))
    .limit(1);
  if (!route) return false;
  const [agent] = await executor
    .select({ computerId: agents.computerId })
    .from(agents)
    .where(
      and(
        eq(agents.id, route.agentId),
        eq(agents.createdByUserId, accountId),
        eq(agents.status, "active"),
        eq(agents.runtimeProvider, "pi"),
        expectedAgentRevision === undefined ? undefined : eq(agents.revision, expectedAgentRevision),
      ),
    )
    .limit(1)
    .for("update");
  if (!agent?.computerId) return false;
  const [binding] = await executor
    .select({ id: imBindings.id })
    .from(imBindings)
    .where(
      and(eq(imBindings.id, route.bindingId), eq(imBindings.agentId, route.agentId), eq(imBindings.status, "active")),
    )
    .limit(1)
    .for("update");
  if (!binding) return false;
  const [session] = await executor
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.id, route.sessionId), eq(sessions.imBindingId, route.bindingId), isNull(sessions.endedAt)))
    .limit(1)
    .for("no key update");
  if (!session) return false;
  const [placement] = await executor
    .select({ computerId: sessionPlacements.computerId })
    .from(sessionPlacements)
    .where(and(eq(sessionPlacements.sessionId, route.sessionId), eq(sessionPlacements.computerId, agent.computerId)))
    .limit(1)
    .for("update");
  if (!placement) return false;
  const [computer] = await executor
    .select({ id: computers.id })
    .from(computers)
    .where(
      and(eq(computers.id, placement.computerId), eq(computers.ownerAccountId, accountId), eq(computers.kind, "cloud")),
    )
    .limit(1)
    .for("update");
  return computer !== undefined;
}
