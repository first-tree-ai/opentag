import { randomUUID, timingSafeEqual } from "node:crypto";
import {
  type AccountComputerConnectCodeIssueRequest,
  type ChannelName,
  type ComputerConnectCodeMode,
  getChannelConfig,
  isSupportedClientVersion,
  unsupportedClientVersionMessage,
} from "@opentag/shared";
import { and, eq, isNull } from "drizzle-orm";
import type { DatabaseClient, DatabaseTransaction } from "../../db/client.js";
import {
  accountComputers,
  computerConnectCodes,
  computerCredentials,
  computers,
  users,
} from "../../db/schema/index.js";
import {
  ensureSchemaWorkspaceId,
  insertSchemaWorkspaceComputer,
  lockSchemaWorkspaceComputer,
  schemaRequiredConnectCodeProjection,
  schemaWorkspaceIdForComputer,
} from "../../db/schema-required-legacy.js";
import { AuthServiceError, generateSecret, hashSecret } from "../auth/index.js";

export const COMPUTER_CONNECT_CODE_TTL_SECONDS = 15 * 60;
const COMPUTER_CONNECT_CODE_PREFIX = "otcc_";
const MACHINE_TOKEN_PREFIX = "otmc_";
const SAFE_SHELL_ARG_PATTERN = /^[A-Za-z0-9_@%+=:,./-]+$/;
const MACHINE_TOKEN_PATTERN =
  /^otmc_([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([A-Za-z0-9_-]{32,})$/i;

export interface ComputerAuthContext {
  credentialId: string;
  workspaceComputerId: string;
  workspaceId: string;
  computerId: string;
}

export interface IssuedComputerConnectCode {
  code: string;
  expiresAt: Date;
  expiresIn: number;
  issuedAt: Date;
  mode: ComputerConnectCodeMode;
}

export interface MachineConnectCodeIssuer {
  issueForAccount(accountId: string, input: AccountComputerConnectCodeIssueRequest): Promise<IssuedComputerConnectCode>;
}

export interface MachineEnrollmentInput {
  code: string;
  computerId: string;
  displayName: string;
  platform: "darwin" | "linux" | "win32";
  arch: string;
  clientVersion: string;
}

export interface MachineEnrollmentResult extends ComputerAuthContext {
  machineToken: string;
}

export interface ComputerAuthVerifier {
  verifyMachineToken(machineToken: string): Promise<ComputerAuthContext>;
}

export interface MachineAuthServiceOptions {
  now?: () => Date;
  onCredentialRotated?: (workspaceComputerId: string) => Promise<void> | void;
}

type ConnectCodeRow = typeof computerConnectCodes.$inferSelect;

export class MachineAuthService implements ComputerAuthVerifier, MachineConnectCodeIssuer {
  readonly #database: DatabaseClient;
  readonly #now: () => Date;
  readonly #onCredentialRotated?: MachineAuthServiceOptions["onCredentialRotated"];

  constructor(database: DatabaseClient, options: MachineAuthServiceOptions = {}) {
    this.#database = database;
    this.#now = options.now ?? (() => new Date());
    this.#onCredentialRotated = options.onCredentialRotated;
  }

  async issueForAccount(
    accountId: string,
    input: AccountComputerConnectCodeIssueRequest,
  ): Promise<IssuedComputerConnectCode> {
    const now = this.#now();
    return this.#database.transaction(async (transaction) => {
      await lockActiveAccount(transaction, accountId);
      if (input.mode === "repair") {
        return this.#insertCode(transaction, {
          accountId,
          mode: "repair",
          now,
          targetComputerId: input.targetComputerId,
        });
      }
      return this.#insertCode(transaction, {
        accountId,
        mode: "create",
        now,
        workspaceId: await ensureSchemaWorkspaceId(transaction, accountId, now),
      });
    });
  }

  async exchangeConnectCode(input: MachineEnrollmentInput): Promise<MachineEnrollmentResult> {
    rejectUnsupportedClientVersion(input.clientVersion);
    const now = this.#now();
    const tokenHash = hashSecret(input.code);
    const result = await this.#database.transaction(async (transaction) => {
      const [connectCode] = await transaction
        .select()
        .from(computerConnectCodes)
        .where(eq(computerConnectCodes.tokenHash, tokenHash))
        .limit(1)
        .for("update");
      if (!connectCode || connectCode.revokedAt) {
        throw invalidMachineCredential("AUTH_INVALID_CODE", "The Computer connect code is invalid");
      }
      if (connectCode.consumedAt) {
        throw invalidMachineCredential("AUTH_CODE_CONSUMED", "The Computer connect code has already been used");
      }
      if (connectCode.expiresAt <= now) {
        throw invalidMachineCredential("AUTH_CODE_EXPIRED", "The Computer connect code has expired");
      }
      await lockActiveAccount(transaction, connectCode.issuedByAccountId);

      const enrollment =
        connectCode.mode === "repair"
          ? await this.#repairComputer(transaction, connectCode, input, now)
          : await this.#createComputer(transaction, connectCode, input, now);
      const credential = await rotateComputerCredentials(
        transaction,
        enrollment.id,
        connectCode.issuedByAccountId,
        now,
      );
      const [consumed] = await transaction
        .update(computerConnectCodes)
        .set({
          consumedWorkspaceComputerId: enrollment.id,
          consumedComputerId: enrollment.id,
          consumedAt: now,
        })
        .where(and(eq(computerConnectCodes.id, connectCode.id), isNull(computerConnectCodes.consumedAt)))
        .returning({ id: computerConnectCodes.id });
      if (!consumed) {
        throw invalidMachineCredential("AUTH_CODE_CONSUMED", "The Computer connect code has already been used");
      }
      return {
        credentialId: credential.id,
        workspaceComputerId: enrollment.id,
        workspaceId: connectCode.workspaceId,
        computerId: input.computerId,
        machineToken: `${MACHINE_TOKEN_PREFIX}${credential.id}.${credential.secret}`,
      };
    });
    await this.#onCredentialRotated?.(result.workspaceComputerId);
    return result;
  }

  async verifyMachineToken(machineToken: string): Promise<ComputerAuthContext> {
    const parsed = MACHINE_TOKEN_PATTERN.exec(machineToken);
    if (!parsed?.[1] || !parsed[2]) {
      throw invalidMachineCredential("AUTH_INVALID_TOKEN", "The machine token is invalid");
    }
    const [credential] = await this.#database
      .select({
        credentialId: computerCredentials.id,
        workspaceComputerId: accountComputers.id,
        computerId: accountComputers.currentInstallationId,
        secretHash: computerCredentials.secretHash,
      })
      .from(computerCredentials)
      .innerJoin(accountComputers, eq(accountComputers.id, computerCredentials.computerId))
      .where(and(eq(computerCredentials.id, parsed[1]), isNull(computerCredentials.revokedAt)))
      .limit(1);
    if (!credential || !matchesSecretHash(credential.secretHash, parsed[2])) {
      throw invalidMachineCredential("AUTH_INVALID_TOKEN", "The machine token is invalid");
    }
    const workspaceId = await this.#database.transaction((transaction) =>
      schemaWorkspaceIdForComputer(transaction, credential.workspaceComputerId),
    );
    return {
      credentialId: credential.credentialId,
      workspaceComputerId: credential.workspaceComputerId,
      workspaceId,
      computerId: credential.computerId,
    };
  }

  async #insertCode(
    transaction: DatabaseTransaction,
    input: {
      accountId: string;
      mode: ComputerConnectCodeMode;
      now: Date;
      targetComputerId?: string;
      workspaceId?: string;
    },
  ): Promise<IssuedComputerConnectCode> {
    let workspaceId = input.workspaceId;
    if (input.mode === "repair") {
      if (!input.targetComputerId) {
        throw new AuthServiceError("COMPUTER_NOT_FOUND", "deterministic", "The requested Computer was not found", 404);
      }
      const target = await lockSchemaWorkspaceComputer(transaction, input.targetComputerId);
      if (!target || target.ownerAccountId !== input.accountId) {
        throw new AuthServiceError("COMPUTER_NOT_FOUND", "deterministic", "The requested Computer was not found", 404);
      }
      workspaceId = target.workspaceId;
    }
    if (!workspaceId) {
      throw new AuthServiceError("RESOURCE_NOT_FOUND", "deterministic", "The requested resource was not found", 404);
    }
    const code = `${COMPUTER_CONNECT_CODE_PREFIX}${generateSecret(24)}`;
    const expiresIn = COMPUTER_CONNECT_CODE_TTL_SECONDS;
    const expiresAt = new Date(input.now.getTime() + expiresIn * 1000);
    await transaction.insert(computerConnectCodes).values({
      ...schemaRequiredConnectCodeProjection(workspaceId),
      tokenHash: hashSecret(code),
      issuedByUserId: input.accountId,
      issuedByAccountId: input.accountId,
      mode: input.mode,
      targetComputerId: input.mode === "repair" ? input.targetComputerId : null,
      createdAt: input.now,
      expiresAt,
    });
    return { code, expiresAt, expiresIn, issuedAt: input.now, mode: input.mode };
  }

  async #createComputer(
    transaction: DatabaseTransaction,
    connectCode: ConnectCodeRow,
    input: MachineEnrollmentInput,
    now: Date,
  ): Promise<{ id: string }> {
    await transaction
      .insert(computers)
      .values({ id: input.computerId, createdAt: now })
      .onConflictDoNothing({ target: computers.id });
    try {
      const enrollment = await insertSchemaWorkspaceComputer(transaction, {
        arch: input.arch,
        clientVersion: input.clientVersion,
        computerId: input.computerId,
        displayName: input.displayName,
        enrolledByUserId: connectCode.issuedByAccountId,
        now,
        platform: input.platform,
        workspaceId: connectCode.workspaceId,
      });
      await transaction.insert(accountComputers).values({
        id: enrollment.id,
        ownerAccountId: connectCode.issuedByAccountId,
        currentInstallationId: input.computerId,
        displayName: input.displayName,
        platform: input.platform,
        arch: input.arch,
        clientVersion: input.clientVersion,
        createdAt: now,
        updatedAt: now,
      });
      return enrollment;
    } catch (error) {
      if (uniqueConstraintName(error) === "workspace_computers_active_workspace_computer_unique") {
        throw new AuthServiceError(
          "COMPUTER_IDENTITY_CONFLICT",
          "deterministic",
          "This installation is already bound to a Computer",
          409,
        );
      }
      throw error;
    }
  }

  async #repairComputer(
    transaction: DatabaseTransaction,
    connectCode: ConnectCodeRow,
    input: MachineEnrollmentInput,
    now: Date,
  ): Promise<{ id: string }> {
    if (!connectCode.targetComputerId) {
      throw invalidMachineCredential("AUTH_INVALID_CODE", "The Computer connect code is invalid");
    }
    const target = await lockSchemaWorkspaceComputer(transaction, connectCode.targetComputerId);
    if (
      !target ||
      target.ownerAccountId !== connectCode.issuedByAccountId ||
      target.workspaceId !== connectCode.workspaceId
    ) {
      throw invalidMachineCredential("AUTH_INVALID_CODE", "The Computer connect code is invalid");
    }
    await transaction
      .insert(computers)
      .values({ id: input.computerId, createdAt: now })
      .onConflictDoNothing({ target: computers.id });
    const [accountComputer] = await transaction
      .update(accountComputers)
      .set({
        currentInstallationId: input.computerId,
        displayName: input.displayName,
        platform: input.platform,
        arch: input.arch,
        clientVersion: input.clientVersion,
        currentInstanceId: null,
        connectedAt: null,
        lastSeenAt: null,
        updatedAt: now,
      })
      .where(
        and(eq(accountComputers.id, target.id), eq(accountComputers.ownerAccountId, connectCode.issuedByAccountId)),
      )
      .returning({ id: accountComputers.id });
    if (!accountComputer) {
      throw new Error("The account-owned Computer does not match the schema-required fill");
    }
    return { id: target.id };
  }
}

async function rotateComputerCredentials(
  transaction: DatabaseTransaction,
  computerId: string,
  accountId: string,
  now: Date,
): Promise<{ id: string; secret: string }> {
  await transaction
    .update(computerCredentials)
    .set({ revokedByUserId: accountId, revokedAt: now })
    .where(and(eq(computerCredentials.computerId, computerId), isNull(computerCredentials.revokedAt)));
  const credentialId = randomUUID();
  const secret = generateSecret(32);
  const secretHash = hashSecret(secret);
  await transaction.insert(computerCredentials).values({
    id: credentialId,
    computerId,
    secretHash,
    issuedByUserId: accountId,
    issuedAt: now,
  });
  return { id: credentialId, secret };
}

async function lockActiveAccount(transaction: DatabaseTransaction, accountId: string): Promise<void> {
  const [user] = await transaction
    .select({ id: users.id, suspendedAt: users.suspendedAt })
    .from(users)
    .where(eq(users.id, accountId))
    .limit(1)
    .for("update");
  if (!user || user.suspendedAt) {
    throw new AuthServiceError("AUTH_USER_SUSPENDED", "deterministic", "The user account is suspended", 403);
  }
}

function uniqueConstraintName(error: unknown): string | undefined {
  let current = error;
  const visited = new Set<unknown>();
  while (typeof current === "object" && current !== null && !visited.has(current)) {
    visited.add(current);
    if ("code" in current && current.code === "23505" && "constraint_name" in current) {
      return typeof current.constraint_name === "string" ? current.constraint_name : undefined;
    }
    current = "cause" in current ? current.cause : undefined;
  }
  return undefined;
}

function matchesSecretHash(expectedHash: string, secret: string): boolean {
  const expected = Buffer.from(expectedHash, "hex");
  const actual = Buffer.from(hashSecret(secret), "hex");
  return expected.byteLength === actual.byteLength && timingSafeEqual(expected, actual);
}

export function buildComputerConnectCommand(options: {
  code: string;
  environment: ChannelName;
  publicUrl: string;
}): string {
  const channel = getChannelConfig(options.environment);
  const connectArgs = `computer connect --server ${shellArg(options.publicUrl)} -- ${shellArg(options.code)}`;
  if (options.environment === "dev") {
    if (!SAFE_SHELL_ARG_PATTERN.test(channel.binName)) throw new TypeError("Invalid channel binary name");
    return `./scripts/dev-install.sh && PATH="$HOME/.local/bin\${PATH:+:$PATH}" "$HOME/.local/bin/${channel.binName}" ${connectArgs}`;
  }
  return `npm i -g ${shellArg(channel.packageName)} && ${shellArg(channel.binName)} ${connectArgs}`;
}

function shellArg(value: string): string {
  return SAFE_SHELL_ARG_PATTERN.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

function invalidMachineCredential(
  code: "AUTH_CODE_CONSUMED" | "AUTH_CODE_EXPIRED" | "AUTH_INVALID_CODE" | "AUTH_INVALID_TOKEN",
  message: string,
): AuthServiceError {
  return new AuthServiceError(code, "credential", message, 401);
}

export function rejectUnsupportedClientVersion(clientVersion: string): void {
  if (isSupportedClientVersion(clientVersion)) return;
  throw new AuthServiceError("CLIENT_VERSION_UNSUPPORTED", "validation", unsupportedClientVersionMessage(), 400);
}
