import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  type AccountComputerConnectCodeIssueRequest,
  type ChannelName,
  type ComputerConnectCodeMode,
  type ComputerConnectCodeStatus,
  getChannelConfig,
  isSupportedClientVersion,
  unsupportedClientVersionMessage,
} from "@opentag/shared";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { DatabaseClient, DatabaseTransaction } from "../../db/client.js";
import { agents, computerConnectCodes, computerCredentials, computers, users } from "../../db/schema/index.js";
import { AuthServiceError, generateSecret, hashSecret } from "../auth/index.js";

export const COMPUTER_CONNECT_CODE_TTL_SECONDS = 15 * 60;
const COMPUTER_CONNECT_CODE_PREFIX = "otcc_";
const TARGETED_CONNECT_CODE_RANDOM_BYTES = 16;
const TARGETED_CONNECT_CODE_PAYLOAD_BYTES = 16 + TARGETED_CONNECT_CODE_RANDOM_BYTES;
const MACHINE_TOKEN_PREFIX = "otmc_";
const SAFE_SHELL_ARG_PATTERN = /^[A-Za-z0-9_@%+=:,./-]+$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LEGACY_TARGETED_CONNECT_CODE_PATTERN =
  /^otcc_[A-Za-z0-9_-]+\.([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const MACHINE_TOKEN_PATTERN =
  /^otmc_([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([A-Za-z0-9_-]{32,})$/i;

export interface ComputerAuthContext {
  credentialId: string;
  computerId: string;
  installationId: string;
}

export interface IssuedComputerConnectCode {
  /**
   * The code row's own id. Opaque and non-secret: the issuing Account polls it for the redemption
   * verdict, and it is worthless at the exchange, which still requires the code itself.
   */
  connectCodeId: string;
  code: string;
  expiresAt: Date;
  expiresIn: number;
  issuedAt: Date;
  mode: ComputerConnectCodeMode;
}

export interface MachineConnectCodeIssuer {
  issueForAccount(accountId: string, input: AccountComputerConnectCodeIssueRequest): Promise<IssuedComputerConnectCode>;
}

export interface ComputerConnectExchangeInput {
  code: string;
  installationId: string;
  displayName: string;
  platform: "darwin" | "linux" | "win32";
  arch: string;
  clientVersion: string;
}

export interface ComputerConnectExchangeResult extends ComputerAuthContext {
  agentId?: string;
  machineToken: string;
}

export interface ComputerAuthVerifier {
  verifyMachineToken(machineToken: string): Promise<ComputerAuthContext>;
}

export interface MachineAuthServiceOptions {
  now?: () => Date;
  onCredentialRotated?: (computerId: string) => Promise<void> | void;
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
          targetAgentId: input.targetAgentId,
          targetComputerId: input.targetComputerId,
        });
      }
      return this.#insertCode(transaction, {
        accountId,
        mode: "create",
        now,
        targetAgentId: input.targetAgentId,
      });
    });
  }

  /**
   * The redemption verdict for one code, readable only by the Account that issued it. Any other
   * Account gets the same 404 as a code that never existed, so the read cannot be used to probe
   * somebody else's Computers. Expired and revoked codes still answer, but never name a Computer:
   * redemption is the only state that carries one.
   */
  async getConnectCodeStatusForAccount(accountId: string, connectCodeId: string): Promise<ComputerConnectCodeStatus> {
    const [connectCode] = await this.#database
      .select({
        id: computerConnectCodes.id,
        issuedByAccountId: computerConnectCodes.issuedByAccountId,
        consumedComputerId: computerConnectCodes.consumedComputerId,
        consumedAt: computerConnectCodes.consumedAt,
        revokedAt: computerConnectCodes.revokedAt,
        expiresAt: computerConnectCodes.expiresAt,
      })
      .from(computerConnectCodes)
      .where(eq(computerConnectCodes.id, connectCodeId))
      .limit(1);
    if (!connectCode || connectCode.issuedByAccountId !== accountId) {
      throw new AuthServiceError("RESOURCE_NOT_FOUND", "deterministic", "The requested resource was not found", 404);
    }
    // Redemption is durable evidence: it answers with the exact Computer whether or not that
    // machine is connected right now, because reachability moves and this fact does not.
    if (connectCode.consumedAt && connectCode.consumedComputerId) {
      return {
        connectCodeId: connectCode.id,
        state: "redeemed",
        computerId: connectCode.consumedComputerId,
        redeemedAt: connectCode.consumedAt.toISOString(),
      };
    }
    if (connectCode.revokedAt) {
      return { connectCodeId: connectCode.id, state: "revoked", computerId: null, redeemedAt: null };
    }
    if (connectCode.expiresAt <= this.#now()) {
      return { connectCodeId: connectCode.id, state: "expired", computerId: null, redeemedAt: null };
    }
    return { connectCodeId: connectCode.id, state: "pending", computerId: null, redeemedAt: null };
  }

  async exchangeConnectCode(input: ComputerConnectExchangeInput): Promise<ComputerConnectExchangeResult> {
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

      const computer =
        connectCode.mode === "repair"
          ? await this.#repairComputer(transaction, connectCode, input, now)
          : await this.#createComputer(transaction, connectCode, input, now);
      const targetAgentId = targetAgentIdFromConnectCode(input.code);
      if (targetAgentId) {
        await bindConnectTargetAgent(transaction, {
          accountId: connectCode.issuedByAccountId,
          agentId: targetAgentId,
          computerId: computer.id,
          mode: connectCode.mode,
          now,
        });
      }
      const credential = await rotateComputerCredentials(transaction, computer.id, connectCode.issuedByAccountId, now);
      const [consumed] = await transaction
        .update(computerConnectCodes)
        .set({ consumedComputerId: computer.id, consumedAt: now })
        .where(and(eq(computerConnectCodes.id, connectCode.id), isNull(computerConnectCodes.consumedAt)))
        .returning({ id: computerConnectCodes.id });
      if (!consumed) {
        throw invalidMachineCredential("AUTH_CODE_CONSUMED", "The Computer connect code has already been used");
      }
      return {
        ...(targetAgentId ? { agentId: targetAgentId } : {}),
        credentialId: credential.id,
        computerId: computer.id,
        installationId: input.installationId,
        machineToken: `${MACHINE_TOKEN_PREFIX}${credential.id}.${credential.secret}`,
      };
    });
    await this.#onCredentialRotated?.(result.computerId);
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
        computerId: computers.id,
        installationId: computers.currentInstallationId,
        secretHash: computerCredentials.secretHash,
      })
      .from(computerCredentials)
      .innerJoin(computers, eq(computers.id, computerCredentials.computerId))
      .where(and(eq(computerCredentials.id, parsed[1]), isNull(computerCredentials.revokedAt)))
      .limit(1);
    if (!credential || !matchesSecretHash(credential.secretHash, parsed[2])) {
      throw invalidMachineCredential("AUTH_INVALID_TOKEN", "The machine token is invalid");
    }
    return {
      credentialId: credential.credentialId,
      computerId: credential.computerId,
      installationId: credential.installationId,
    };
  }

  async #insertCode(
    transaction: DatabaseTransaction,
    input: {
      accountId: string;
      mode: ComputerConnectCodeMode;
      now: Date;
      targetComputerId?: string;
      targetAgentId?: string;
    },
  ): Promise<IssuedComputerConnectCode> {
    if (input.mode === "repair") {
      if (!input.targetComputerId) {
        throw new AuthServiceError("COMPUTER_NOT_FOUND", "deterministic", "The requested Computer was not found", 404);
      }
      const target = await lockOwnedComputer(transaction, input.targetComputerId);
      if (!target || target.ownerAccountId !== input.accountId) {
        throw new AuthServiceError("COMPUTER_NOT_FOUND", "deterministic", "The requested Computer was not found", 404);
      }
    }
    if (input.targetAgentId) {
      await assertConnectTargetAgent(transaction, {
        accountId: input.accountId,
        agentId: input.targetAgentId,
        mode: input.mode,
        targetComputerId: input.targetComputerId,
      });
    }
    const code = input.targetAgentId
      ? targetedComputerConnectCode(input.targetAgentId)
      : `${COMPUTER_CONNECT_CODE_PREFIX}${generateSecret(24)}`;
    const expiresIn = COMPUTER_CONNECT_CODE_TTL_SECONDS;
    const expiresAt = new Date(input.now.getTime() + expiresIn * 1000);
    const [inserted] = await transaction
      .insert(computerConnectCodes)
      .values({
        tokenHash: hashSecret(code),
        issuedByAccountId: input.accountId,
        mode: input.mode,
        targetComputerId: input.mode === "repair" ? input.targetComputerId : null,
        createdAt: input.now,
        expiresAt,
      })
      .returning({ id: computerConnectCodes.id });
    if (!inserted) throw new Error("The Computer connect code was not created");
    return { connectCodeId: inserted.id, code, expiresAt, expiresIn, issuedAt: input.now, mode: input.mode };
  }

  async #createComputer(
    transaction: DatabaseTransaction,
    connectCode: ConnectCodeRow,
    input: ComputerConnectExchangeInput,
    now: Date,
  ): Promise<{ id: string }> {
    try {
      const [computer] = await transaction
        .insert(computers)
        .values({
          ownerAccountId: connectCode.issuedByAccountId,
          currentInstallationId: input.installationId,
          displayName: input.displayName,
          platform: input.platform,
          arch: input.arch,
          clientVersion: input.clientVersion,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: computers.id });
      if (!computer) throw new Error("Computer insert did not return a row");
      return computer;
    } catch (error) {
      if (uniqueConstraintName(error) === "computers_current_installation_id_unique") {
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
    input: ComputerConnectExchangeInput,
    now: Date,
  ): Promise<{ id: string }> {
    if (!connectCode.targetComputerId) {
      throw invalidMachineCredential("AUTH_INVALID_CODE", "The Computer connect code is invalid");
    }
    const target = await lockOwnedComputer(transaction, connectCode.targetComputerId);
    if (!target || target.ownerAccountId !== connectCode.issuedByAccountId) {
      throw invalidMachineCredential("AUTH_INVALID_CODE", "The Computer connect code is invalid");
    }
    let repaired: { id: string } | undefined;
    try {
      [repaired] = await transaction
        .update(computers)
        .set({
          currentInstallationId: input.installationId,
          displayName: input.displayName,
          platform: input.platform,
          arch: input.arch,
          clientVersion: input.clientVersion,
          currentInstanceId: null,
          connectedAt: null,
          lastSeenAt: null,
          updatedAt: now,
        })
        .where(and(eq(computers.id, target.id), eq(computers.ownerAccountId, connectCode.issuedByAccountId)))
        .returning({ id: computers.id });
    } catch (error) {
      if (uniqueConstraintName(error) === "computers_current_installation_id_unique") {
        throw new AuthServiceError(
          "COMPUTER_IDENTITY_CONFLICT",
          "deterministic",
          "This installation is already bound to a Computer",
          409,
        );
      }
      throw error;
    }
    if (!repaired) {
      throw new Error("The repaired Computer does not match its issuing Account");
    }
    return repaired;
  }
}

function targetAgentIdFromConnectCode(code: string): string | undefined {
  if (code.includes(".")) {
    const legacyTarget = LEGACY_TARGETED_CONNECT_CODE_PATTERN.exec(code)?.[1];
    if (!legacyTarget) throw invalidMachineCredential("AUTH_INVALID_CODE", "The Computer connect code is invalid");
    return legacyTarget;
  }
  const encoded = code.startsWith(COMPUTER_CONNECT_CODE_PREFIX) ? code.slice(COMPUTER_CONNECT_CODE_PREFIX.length) : "";
  // Untargeted codes remain the existing 24 random bytes / 32 Base64URL characters.
  if (encoded.length !== 43) return undefined;
  if (!/^[A-Za-z0-9_-]+$/u.test(encoded)) {
    throw invalidMachineCredential("AUTH_INVALID_CODE", "The Computer connect code is invalid");
  }
  const payload = Buffer.from(encoded, "base64url");
  if (payload.byteLength !== TARGETED_CONNECT_CODE_PAYLOAD_BYTES || payload.toString("base64url") !== encoded) {
    throw invalidMachineCredential("AUTH_INVALID_CODE", "The Computer connect code is invalid");
  }
  const target = uuidFromBytes(payload.subarray(0, 16));
  if (!UUID_PATTERN.test(target)) {
    throw invalidMachineCredential("AUTH_INVALID_CODE", "The Computer connect code is invalid");
  }
  return target;
}

function targetedComputerConnectCode(agentId: string): string {
  const agentBytes = uuidBytes(agentId);
  const payload = Buffer.concat([agentBytes, randomBytes(TARGETED_CONNECT_CODE_RANDOM_BYTES)]);
  return `${COMPUTER_CONNECT_CODE_PREFIX}${payload.toString("base64url")}`;
}

function uuidBytes(value: string): Buffer {
  if (!UUID_PATTERN.test(value)) throw new TypeError("Invalid target Agent id");
  return Buffer.from(value.replaceAll("-", ""), "hex");
}

function uuidFromBytes(value: Uint8Array): string {
  const hex = Buffer.from(value).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function assertConnectTargetAgent(
  transaction: DatabaseTransaction,
  input: {
    accountId: string;
    agentId: string;
    mode: ComputerConnectCodeMode;
    targetComputerId?: string;
  },
): Promise<void> {
  const [agent] = await transaction
    .select({ computerId: agents.computerId, createdByUserId: agents.createdByUserId, status: agents.status })
    .from(agents)
    .where(eq(agents.id, input.agentId))
    .limit(1)
    .for("update");
  if (!agent || agent.createdByUserId !== input.accountId || agent.status !== "active") {
    throw new AuthServiceError("RESOURCE_NOT_FOUND", "deterministic", "The requested resource was not found", 404);
  }
  const expectedComputerId = input.mode === "repair" ? input.targetComputerId : undefined;
  if (
    (input.mode === "create" && agent.computerId !== null) ||
    (input.mode === "repair" && agent.computerId !== expectedComputerId)
  ) {
    throw new AuthServiceError(
      "AGENT_LIFECYCLE_CONFLICT",
      "deterministic",
      "The target Agent is no longer available for this Computer connection",
      409,
    );
  }
}

async function bindConnectTargetAgent(
  transaction: DatabaseTransaction,
  input: {
    accountId: string;
    agentId: string;
    computerId: string;
    mode: ComputerConnectCodeMode;
    now: Date;
  },
): Promise<void> {
  const [agent] = await transaction
    .select({ computerId: agents.computerId, createdByUserId: agents.createdByUserId, status: agents.status })
    .from(agents)
    .where(eq(agents.id, input.agentId))
    .limit(1)
    .for("update");
  const expectedComputerId = input.mode === "repair" ? input.computerId : null;
  if (
    !agent ||
    agent.createdByUserId !== input.accountId ||
    agent.status !== "active" ||
    agent.computerId !== expectedComputerId
  ) {
    throw invalidMachineCredential("AUTH_INVALID_CODE", "The Computer connect code target is no longer valid");
  }
  if (agent.computerId === input.computerId) return;
  const [bound] = await transaction
    .update(agents)
    .set({ computerId: input.computerId, revision: sql`${agents.revision} + 1`, updatedAt: input.now })
    .where(and(eq(agents.id, input.agentId), eq(agents.createdByUserId, input.accountId), isNull(agents.computerId)))
    .returning({ id: agents.id });
  if (!bound) {
    throw invalidMachineCredential("AUTH_INVALID_CODE", "The Computer connect code target is no longer valid");
  }
}

async function lockOwnedComputer(
  transaction: DatabaseTransaction,
  computerId: string,
): Promise<{ id: string; ownerAccountId: string } | undefined> {
  const [computer] = await transaction
    .select({ id: computers.id, ownerAccountId: computers.ownerAccountId })
    .from(computers)
    .where(eq(computers.id, computerId))
    .limit(1)
    .for("update");
  return computer;
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
  /**
   * Required rather than defaulted, because a second default here could drift from the one the
   * Server actually polls and publish an install URL no release was ever written to.
   */
  downloadBaseUrl: string;
  environment: ChannelName;
  publicUrl: string;
}): string {
  const channel = getChannelConfig(options.environment);
  if (!SAFE_SHELL_ARG_PATTERN.test(channel.binName)) throw new TypeError("Invalid channel binary name");
  const connectArgs = `connect --server ${shellArg(options.publicUrl)} -- ${shellArg(options.code)}`;
  const connect = `PATH="$HOME/.local/bin\${PATH:+:$PATH}" "$HOME/.local/bin/${channel.binName}" ${connectArgs}`;
  if (options.environment === "dev") return `./scripts/dev-install.sh && ${connect}`;
  const downloadBaseUrl = options.downloadBaseUrl.replace(/\/+$/, "");
  const installerUrl = `${downloadBaseUrl}/${options.environment}/install.sh`;
  /*
   * A pipeline reports its last command's status, and `sh` succeeds on the empty input a failed
   * download leaves behind, so `curl … | sh &&` would run whatever Client is already on disk and
   * report a download failure as an unrelated CLI usage error. Landing the installer in a file
   * first keeps every step in one `&&` chain, so the command stops at the step that actually broke.
   */
  return `opentag_installer="$(mktemp)" && curl -fsSL ${shellArg(installerUrl)} -o "$opentag_installer" && sh "$opentag_installer" && rm -f "$opentag_installer" && ${connect}`;
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
