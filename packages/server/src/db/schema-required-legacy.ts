import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import type { DatabaseTransaction } from "./client.js";
import { accountComputers, computerConnectCodes, users, workspaceComputers, workspaces } from "./schema/index.js";

export class SchemaRequiredLegacyError extends Error {
  readonly code = "SCHEMA_REQUIRED_LEGACY_AMBIGUOUS";

  constructor(accountId: string, workspaceIds: readonly string[]) {
    super(`Account ${accountId} has multiple schema-required Workspace candidates: ${workspaceIds.join(", ")}`);
    this.name = "SchemaRequiredLegacyError";
  }
}

/**
 * Schema-required FK fills retained until the contract migration drops management Workspace
 * persistence. These rows are not Account authority and must not be used as a product Workspace.
 */
export async function ensureSchemaWorkspaceId(
  transaction: DatabaseTransaction,
  accountId: string,
  now: Date,
): Promise<string> {
  // Every caller currently holds this row lock already. Keeping the lock inside the seam makes the
  // zero-candidate create path safe if another caller is added before PR 6 removes this adapter.
  const [account] = await transaction
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, accountId))
    .limit(1)
    .for("update");
  if (!account) throw new Error("The Account for the schema-required Workspace fill is missing");

  const schemaWorkspaceName = `schema-${accountId}`;
  const namedCandidates = await transaction
    .select({ workspaceId: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.name, schemaWorkspaceName))
    .orderBy(asc(workspaces.id));
  const computerCandidates = await transaction
    .selectDistinct({ workspaceId: workspaceComputers.workspaceId })
    .from(accountComputers)
    .innerJoin(workspaceComputers, eq(workspaceComputers.id, accountComputers.id))
    .where(eq(accountComputers.ownerAccountId, accountId))
    .orderBy(asc(workspaceComputers.workspaceId));
  const codeCandidates = await transaction
    .selectDistinct({ workspaceId: computerConnectCodes.workspaceId })
    .from(computerConnectCodes)
    .where(eq(computerConnectCodes.issuedByAccountId, accountId))
    .orderBy(asc(computerConnectCodes.workspaceId));
  const workspaceIds = [
    ...new Set([...namedCandidates, ...computerCandidates, ...codeCandidates].map((row) => row.workspaceId)),
  ].sort();
  if (workspaceIds.length > 1) throw new SchemaRequiredLegacyError(accountId, workspaceIds);
  const existing = workspaceIds[0];
  if (existing) return existing;

  const workspaceId = randomUUID();
  await transaction.insert(workspaces).values({
    id: workspaceId,
    name: schemaWorkspaceName,
    displayName: "Schema compatibility",
    createdAt: now,
    updatedAt: now,
  });
  return workspaceId;
}

export async function schemaWorkspaceIdForComputer(
  transaction: DatabaseTransaction,
  computerId: string,
): Promise<string> {
  const [row] = await transaction
    .select({ workspaceId: workspaceComputers.workspaceId })
    .from(workspaceComputers)
    .where(eq(workspaceComputers.id, computerId))
    .limit(1);
  if (!row) {
    throw new Error("The schema-required Workspace fill for this Computer is missing");
  }
  return row.workspaceId;
}

/** Legacy Agent columns kept only by the PR5 database ABI. */
export function schemaRequiredAgentProjection(input: { id: string; workspaceId: string }): {
  workspaceId: string;
  workspaceComputerId: string;
} {
  return { workspaceId: input.workspaceId, workspaceComputerId: input.id };
}

/** Legacy Session placement/proof column kept only by the PR5 database ABI. */
export function schemaRequiredComputerProjection(computerId: string): { workspaceComputerId: string } {
  return { workspaceComputerId: computerId };
}

/** Legacy connect-code column kept only by its NOT NULL and consumed-code composite FK. */
export function schemaRequiredConnectCodeProjection(workspaceId: string): { workspaceId: string } {
  return { workspaceId };
}

/** Legacy Slack installation column kept only by its non-deferrable Agent ownership FK. */
export async function schemaRequiredSlackInstallationProjection(
  transaction: DatabaseTransaction,
  computerId: string,
): Promise<{ workspaceId: string }> {
  return { workspaceId: await schemaWorkspaceIdForComputer(transaction, computerId) };
}

export async function insertSchemaWorkspaceComputer(
  transaction: DatabaseTransaction,
  input: {
    arch: string;
    clientVersion: string;
    computerId: string;
    displayName: string;
    enrolledByUserId: string;
    now: Date;
    platform: "darwin" | "linux" | "win32";
    workspaceId: string;
  },
): Promise<{ id: string }> {
  const [enrollment] = await transaction
    .insert(workspaceComputers)
    .values({
      workspaceId: input.workspaceId,
      computerId: input.computerId,
      displayName: input.displayName,
      platform: input.platform,
      arch: input.arch,
      clientVersion: input.clientVersion,
      enrolledByUserId: input.enrolledByUserId,
      enrolledAt: input.now,
      updatedAt: input.now,
    })
    .returning({ id: workspaceComputers.id });
  if (!enrollment) throw new Error("Schema-required Computer fill was not created");
  return enrollment;
}

export async function lockSchemaWorkspaceComputer(
  transaction: DatabaseTransaction,
  computerId: string,
): Promise<{ id: string; ownerAccountId: string; workspaceId: string } | undefined> {
  const [row] = await transaction
    .select({
      id: accountComputers.id,
      ownerAccountId: accountComputers.ownerAccountId,
      workspaceId: workspaceComputers.workspaceId,
    })
    .from(accountComputers)
    .innerJoin(workspaceComputers, eq(workspaceComputers.id, accountComputers.id))
    .where(eq(accountComputers.id, computerId))
    .limit(1)
    .for("update");
  return row;
}
