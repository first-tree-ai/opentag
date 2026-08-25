import { type ChannelName, getChannelConfig } from "@opentag/shared";
import { eq } from "drizzle-orm";
import type { DatabaseClient, DatabaseTransaction } from "../../db/client.js";
import { connectCodes, users } from "../../db/schema/index.js";
import { WorkspaceAdminAccess } from "../workspace-admin-access/index.js";
import { AuthServiceError } from "./errors.js";
import { generateSecret, hashSecret } from "./security.js";

export const CONNECT_CODE_TTL_SECONDS = 15 * 60;

const SAFE_SHELL_ARG_PATTERN = /^[A-Za-z0-9_@%+=:,./-]+$/;

export interface IssuedConnectCode {
  code: string;
  expiresAt: Date;
  expiresIn: number;
  issuedAt: Date;
}

export interface ConnectCodeIssuer {
  issueForTeamAdmin(userId: string, teamId: string): Promise<IssuedConnectCode>;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function shellArg(value: string): string {
  return SAFE_SHELL_ARG_PATTERN.test(value) ? value : shellQuote(value);
}

export function buildConnectBootstrapCommand(options: {
  code: string;
  environment: ChannelName;
  publicUrl: string;
}): string {
  const channel = getChannelConfig(options.environment);
  const loginArgs = `login --server ${shellArg(options.publicUrl)} -- ${shellArg(options.code)}`;
  if (options.environment === "dev") {
    if (!SAFE_SHELL_ARG_PATTERN.test(channel.binName)) throw new TypeError("Invalid channel binary name");
    return `./scripts/dev-install.sh && PATH="$HOME/.local/bin\${PATH:+:$PATH}" "$HOME/.local/bin/${channel.binName}" ${loginArgs}`;
  }
  const loginCommand = `${shellArg(channel.binName)} ${loginArgs}`;
  return `npm i -g ${shellArg(channel.packageName)} && ${loginCommand}`;
}

export async function issueConnectCodeInTransaction(
  transaction: DatabaseTransaction,
  input: { issuerUserId: string; userId: string; ttlSeconds?: number },
  now: Date,
): Promise<IssuedConnectCode> {
  const expiresIn = input.ttlSeconds ?? CONNECT_CODE_TTL_SECONDS;
  if (!Number.isInteger(expiresIn) || expiresIn <= 0) {
    throw new TypeError("Connect code TTL must be a positive integer");
  }
  const code = generateSecret(24);
  const expiresAt = new Date(now.getTime() + expiresIn * 1000);
  await transaction.insert(connectCodes).values({
    codeHash: hashSecret(code),
    userId: input.userId,
    issuerUserId: input.issuerUserId,
    expiresAt,
  });
  return { code, expiresAt, expiresIn, issuedAt: now };
}

export interface ConnectCodeServiceOptions {
  now?: () => Date;
}

export class ConnectCodeService implements ConnectCodeIssuer {
  readonly #database: DatabaseClient;
  readonly #now: () => Date;
  readonly #workspaceAdmins: WorkspaceAdminAccess;

  constructor(
    database: DatabaseClient,
    options: ConnectCodeServiceOptions & { workspaceAdmins?: WorkspaceAdminAccess } = {},
  ) {
    this.#database = database;
    this.#now = options.now ?? (() => new Date());
    this.#workspaceAdmins = options.workspaceAdmins ?? new WorkspaceAdminAccess(database, { now: options.now });
  }

  async issueForUser(userId: string): Promise<IssuedConnectCode> {
    const now = this.#now();
    return this.#database.transaction(async (transaction) => {
      const [user] = await transaction
        .select({ id: users.id, suspendedAt: users.suspendedAt })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1)
        .for("update");
      if (!user || user.suspendedAt) {
        throw new AuthServiceError("AUTH_USER_SUSPENDED", "deterministic", "The user account is suspended", 403);
      }
      await this.#workspaceAdmins.requireAnyAdmin(userId, transaction);
      return issueConnectCodeInTransaction(transaction, { issuerUserId: userId, userId }, now);
    });
  }

  async issueForTeamAdmin(userId: string, teamId: string): Promise<IssuedConnectCode> {
    const now = this.#now();
    return this.#database.transaction(async (transaction) => {
      await this.#workspaceAdmins.requireAdminForMutation(transaction, userId, teamId);
      return issueConnectCodeInTransaction(transaction, { issuerUserId: userId, userId }, now);
    });
  }
}
