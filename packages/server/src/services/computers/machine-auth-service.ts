import { randomUUID, timingSafeEqual } from "node:crypto";
import { type ChannelName, getChannelConfig } from "@opentag/shared";
import { and, eq, isNull } from "drizzle-orm";
import type { DatabaseClient } from "../../db/client.js";
import {
  computerConnectCodes,
  computers,
  memberships,
  teams,
  users,
  workspaceComputerCredentials,
  workspaceComputers,
} from "../../db/schema/index.js";
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
}

export interface MachineConnectCodeIssuer {
  issueForTeamAdmin(accountId: string, workspaceId: string): Promise<IssuedComputerConnectCode>;
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

export class MachineAuthService implements ComputerAuthVerifier, MachineConnectCodeIssuer {
  readonly #database: DatabaseClient;
  readonly #now: () => Date;
  readonly #onCredentialRotated?: MachineAuthServiceOptions["onCredentialRotated"];

  constructor(database: DatabaseClient, options: MachineAuthServiceOptions = {}) {
    this.#database = database;
    this.#now = options.now ?? (() => new Date());
    this.#onCredentialRotated = options.onCredentialRotated;
  }

  async issueForTeamAdmin(accountId: string, workspaceId: string): Promise<IssuedComputerConnectCode> {
    const now = this.#now();
    return this.#database.transaction(async (transaction) => {
      const [workspace] = await transaction
        .select({ id: teams.id })
        .from(teams)
        .where(eq(teams.id, workspaceId))
        .limit(1)
        .for("update");
      if (!workspace) throw notFound();
      const [authority] = await transaction
        .select({ role: memberships.role, suspendedAt: users.suspendedAt })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(
          and(eq(memberships.teamId, workspaceId), eq(memberships.userId, accountId), eq(memberships.status, "active")),
        )
        .limit(1);
      if (!authority || authority.suspendedAt) throw notFound();
      if (authority.role !== "admin") {
        throw new AuthServiceError("MEMBERSHIP_FORBIDDEN", "deterministic", "Team admin access is required", 403);
      }
      const code = `${COMPUTER_CONNECT_CODE_PREFIX}${generateSecret(24)}`;
      const expiresIn = COMPUTER_CONNECT_CODE_TTL_SECONDS;
      const expiresAt = new Date(now.getTime() + expiresIn * 1000);
      await transaction.insert(computerConnectCodes).values({
        workspaceId,
        tokenHash: hashSecret(code),
        issuedByUserId: accountId,
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
      const [workspace] = await transaction
        .select({ id: teams.id })
        .from(teams)
        .where(eq(teams.id, candidate.workspaceId))
        .limit(1)
        .for("update");
      if (!workspace) throw invalidMachineCredential("AUTH_INVALID_CODE", "The Computer connect code is invalid");
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
      const [issuer] = await transaction
        .select({ suspendedAt: users.suspendedAt, role: memberships.role, status: memberships.status })
        .from(users)
        .leftJoin(memberships, and(eq(memberships.userId, users.id), eq(memberships.teamId, connectCode.workspaceId)))
        .where(eq(users.id, connectCode.issuedByUserId))
        .limit(1);
      if (!issuer || issuer.suspendedAt || issuer.status !== "active" || issuer.role !== "admin") {
        throw invalidMachineCredential("AUTH_INVALID_CODE", "The Computer connect code is invalid");
      }

      await transaction
        .insert(computers)
        .values({
          id: input.computerId,
          ownerUserId: connectCode.issuedByUserId,
          displayName: input.displayName,
          platform: input.platform,
          arch: input.arch,
          clientVersion: input.clientVersion,
          lastSeenAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing({ target: computers.id });

      let [enrollment] = await transaction
        .select({ id: workspaceComputers.id })
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
          .returning({ id: workspaceComputers.id });
      } else {
        await transaction
          .update(workspaceComputers)
          .set({
            displayName: input.displayName,
            platform: input.platform,
            arch: input.arch,
            clientVersion: input.clientVersion,
            currentInstanceId: null,
            connectedAt: null,
            updatedAt: now,
          })
          .where(eq(workspaceComputers.id, enrollment.id));
      }
      if (!enrollment) throw new Error("Computer enrollment was not created");

      await transaction
        .update(workspaceComputerCredentials)
        .set({ revokedByUserId: connectCode.issuedByUserId, revokedAt: now })
        .where(
          and(
            eq(workspaceComputerCredentials.workspaceComputerId, enrollment.id),
            isNull(workspaceComputerCredentials.revokedAt),
          ),
        );
      const credentialId = randomUUID();
      const secret = generateSecret(32);
      await transaction.insert(workspaceComputerCredentials).values({
        id: credentialId,
        workspaceComputerId: enrollment.id,
        secretHash: hashSecret(secret),
        issuedByUserId: connectCode.issuedByUserId,
        issuedAt: now,
      });
      const [consumed] = await transaction
        .update(computerConnectCodes)
        .set({ consumedWorkspaceComputerId: enrollment.id, consumedAt: now })
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

function notFound(): AuthServiceError {
  return new AuthServiceError("RESOURCE_NOT_FOUND", "deterministic", "The Team was not found", 404);
}
