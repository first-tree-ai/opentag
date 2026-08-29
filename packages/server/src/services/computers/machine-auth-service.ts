import { randomUUID, timingSafeEqual } from "node:crypto";
import { type ChannelName, getChannelConfig } from "@opentag/shared";
import { and, eq, isNull } from "drizzle-orm";
import type { DatabaseClient } from "../../db/client.js";
import {
  accountComputers,
  computerConnectCodes,
  computerCredentials,
  computers,
  workspaceComputerCredentials,
  workspaceComputers,
} from "../../db/schema/index.js";
import { AuthServiceError, generateSecret, hashSecret } from "../auth/index.js";
import { WorkspaceAdminAccess } from "../workspace-admin-access/index.js";

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
}

export interface MachineConnectCodeIssuer {
  issueForWorkspaceAdmin(accountId: string, workspaceId: string): Promise<IssuedComputerConnectCode>;
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
  workspaceAdmins?: WorkspaceAdminAccess;
}

export class MachineAuthService implements ComputerAuthVerifier, MachineConnectCodeIssuer {
  readonly #database: DatabaseClient;
  readonly #now: () => Date;
  readonly #onCredentialRotated?: MachineAuthServiceOptions["onCredentialRotated"];
  readonly #workspaceAdmins: WorkspaceAdminAccess;

  constructor(database: DatabaseClient, options: MachineAuthServiceOptions = {}) {
    this.#database = database;
    this.#now = options.now ?? (() => new Date());
    this.#onCredentialRotated = options.onCredentialRotated;
    this.#workspaceAdmins = options.workspaceAdmins ?? new WorkspaceAdminAccess(database, { now: options.now });
  }

  async issueForWorkspaceAdmin(accountId: string, workspaceId: string): Promise<IssuedComputerConnectCode> {
    const now = this.#now();
    return this.#database.transaction(async (transaction) => {
      await this.#workspaceAdmins.requireAdminForMutation(transaction, accountId, workspaceId);
      const code = `${COMPUTER_CONNECT_CODE_PREFIX}${generateSecret(24)}`;
      const expiresIn = COMPUTER_CONNECT_CODE_TTL_SECONDS;
      const expiresAt = new Date(now.getTime() + expiresIn * 1000);
      await transaction.insert(computerConnectCodes).values({
        workspaceId,
        tokenHash: hashSecret(code),
        issuedByUserId: accountId,
        issuedByAccountId: accountId,
        mode: "create",
        createdAt: now,
        expiresAt,
      });
      return { code, expiresAt, expiresIn, issuedAt: now };
    });
  }

  async exchangeConnectCode(input: MachineEnrollmentInput): Promise<MachineEnrollmentResult> {
    const now = this.#now();
    const tokenHash = hashSecret(input.code);
    const result = await this.#database.transaction(async (transaction) => {
      const [candidate] = await transaction
        .select({ workspaceId: computerConnectCodes.workspaceId })
        .from(computerConnectCodes)
        .where(eq(computerConnectCodes.tokenHash, tokenHash))
        .limit(1);
      if (!candidate) throw invalidMachineCredential("AUTH_INVALID_CODE", "The Computer connect code is invalid");
      try {
        await this.#workspaceAdmins.lockWorkspace(transaction, candidate.workspaceId);
      } catch (error) {
        rethrowMissingWorkspaceAsInvalidCode(error);
      }
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
      try {
        await this.#workspaceAdmins.requireAdmin(connectCode.issuedByUserId, connectCode.workspaceId, transaction);
      } catch (error) {
        rethrowMissingWorkspaceAsInvalidCode(error);
      }

      await transaction
        .insert(computers)
        .values({
          id: input.computerId,
          createdAt: now,
        })
        .onConflictDoNothing({ target: computers.id });

      const enrollmentColumns = {
        id: workspaceComputers.id,
        computerId: workspaceComputers.computerId,
        displayName: workspaceComputers.displayName,
        platform: workspaceComputers.platform,
        arch: workspaceComputers.arch,
        clientVersion: workspaceComputers.clientVersion,
        enrolledByUserId: workspaceComputers.enrolledByUserId,
        enrolledAt: workspaceComputers.enrolledAt,
        currentInstanceId: workspaceComputers.currentInstanceId,
        connectedAt: workspaceComputers.connectedAt,
        lastSeenAt: workspaceComputers.lastSeenAt,
        updatedAt: workspaceComputers.updatedAt,
      };
      let [enrollment] = await transaction
        .select(enrollmentColumns)
        .from(workspaceComputers)
        .where(
          and(
            eq(workspaceComputers.workspaceId, connectCode.workspaceId),
            eq(workspaceComputers.computerId, input.computerId),
            isNull(workspaceComputers.revokedAt),
          ),
        )
        .limit(1)
        .for("update");
      if (!enrollment) {
        [enrollment] = await transaction
          .insert(workspaceComputers)
          .values({
            workspaceId: connectCode.workspaceId,
            computerId: input.computerId,
            displayName: input.displayName,
            platform: input.platform,
            arch: input.arch,
            clientVersion: input.clientVersion,
            enrolledByUserId: connectCode.issuedByUserId,
            enrolledAt: now,
            updatedAt: now,
          })
          .returning(enrollmentColumns);
      } else {
        [enrollment] = await transaction
          .update(workspaceComputers)
          .set({
            displayName: input.displayName,
            platform: input.platform,
            arch: input.arch,
            clientVersion: input.clientVersion,
            currentInstanceId: null,
            connectedAt: null,
            lastSeenAt: null,
            updatedAt: now,
          })
          .where(eq(workspaceComputers.id, enrollment.id))
          .returning(enrollmentColumns);
      }
      if (!enrollment) throw new Error("Computer enrollment was not created");

      const [accountComputer] = await transaction
        .select({
          ownerAccountId: accountComputers.ownerAccountId,
          currentInstallationId: accountComputers.currentInstallationId,
        })
        .from(accountComputers)
        .where(eq(accountComputers.id, enrollment.id))
        .limit(1)
        .for("update");
      if (!accountComputer) {
        await transaction.insert(accountComputers).values({
          id: enrollment.id,
          ownerAccountId: enrollment.enrolledByUserId,
          currentInstallationId: enrollment.computerId,
          displayName: enrollment.displayName,
          platform: enrollment.platform,
          arch: enrollment.arch,
          clientVersion: enrollment.clientVersion,
          currentInstanceId: enrollment.currentInstanceId,
          connectedAt: enrollment.connectedAt,
          lastSeenAt: enrollment.lastSeenAt,
          createdAt: enrollment.enrolledAt,
          updatedAt: enrollment.updatedAt,
        });
      } else if (
        accountComputer.ownerAccountId !== enrollment.enrolledByUserId ||
        accountComputer.currentInstallationId !== enrollment.computerId
      ) {
        throw new Error("The account-owned Computer projection does not match the enrollment identity");
      } else {
        await transaction
          .update(accountComputers)
          .set({
            displayName: enrollment.displayName,
            platform: enrollment.platform,
            arch: enrollment.arch,
            clientVersion: enrollment.clientVersion,
            currentInstanceId: enrollment.currentInstanceId,
            connectedAt: enrollment.connectedAt,
            lastSeenAt: enrollment.lastSeenAt,
            updatedAt: enrollment.updatedAt,
          })
          .where(eq(accountComputers.id, enrollment.id));
      }

      await transaction
        .update(workspaceComputerCredentials)
        .set({ revokedByUserId: connectCode.issuedByUserId, revokedAt: now })
        .where(
          and(
            eq(workspaceComputerCredentials.workspaceComputerId, enrollment.id),
            isNull(workspaceComputerCredentials.revokedAt),
          ),
        );
      await transaction
        .update(computerCredentials)
        .set({ revokedByUserId: connectCode.issuedByUserId, revokedAt: now })
        .where(and(eq(computerCredentials.computerId, enrollment.id), isNull(computerCredentials.revokedAt)));
      const credentialId = randomUUID();
      const secret = generateSecret(32);
      const secretHash = hashSecret(secret);
      await transaction.insert(workspaceComputerCredentials).values({
        id: credentialId,
        workspaceComputerId: enrollment.id,
        secretHash,
        issuedByUserId: connectCode.issuedByUserId,
        issuedAt: now,
      });
      await transaction.insert(computerCredentials).values({
        id: credentialId,
        computerId: enrollment.id,
        secretHash,
        issuedByUserId: connectCode.issuedByUserId,
        issuedAt: now,
      });
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
        credentialId,
        workspaceComputerId: enrollment.id,
        workspaceId: connectCode.workspaceId,
        computerId: input.computerId,
        machineToken: `${MACHINE_TOKEN_PREFIX}${credentialId}.${secret}`,
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
        credentialId: workspaceComputerCredentials.id,
        workspaceComputerId: workspaceComputers.id,
        workspaceId: workspaceComputers.workspaceId,
        computerId: workspaceComputers.computerId,
        secretHash: workspaceComputerCredentials.secretHash,
      })
      .from(workspaceComputerCredentials)
      .innerJoin(workspaceComputers, eq(workspaceComputers.id, workspaceComputerCredentials.workspaceComputerId))
      .where(
        and(
          eq(workspaceComputerCredentials.id, parsed[1]),
          isNull(workspaceComputerCredentials.revokedAt),
          isNull(workspaceComputers.revokedAt),
        ),
      )
      .limit(1);
    if (!credential || !matchesSecretHash(credential.secretHash, parsed[2])) {
      throw invalidMachineCredential("AUTH_INVALID_TOKEN", "The machine token is invalid");
    }
    const { secretHash: _secretHash, ...context } = credential;
    return context;
  }
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

function rethrowMissingWorkspaceAsInvalidCode(error: unknown): never {
  if (error instanceof AuthServiceError && error.statusCode === 404) {
    throw invalidMachineCredential("AUTH_INVALID_CODE", "The Computer connect code is invalid");
  }
  throw error;
}
