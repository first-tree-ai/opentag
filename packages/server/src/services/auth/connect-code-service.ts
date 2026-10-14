import { type ChannelName, getChannelConfig, SLACK_AGENT_PROVISION_CODE_PREFIX } from "@opentag/shared";
import { and, eq, isNull } from "drizzle-orm";
import type { DatabaseClient, DatabaseTransaction } from "../../db/client.js";
import { accountCliLoginCodes, users } from "../../db/schema/index.js";
import { AuthServiceError, invalidCredential } from "./errors.js";
import { generateSecret, hashSecret } from "./security.js";

export type AccountConnectCodePurpose = "login" | "slack-agent-provision";

export const CONNECT_CODE_TTL_SECONDS = 15 * 60;

const SAFE_SHELL_ARG_PATTERN = /^[A-Za-z0-9_@%+=:,./-]+$/;

export interface IssuedConnectCode {
  code: string;
  expiresAt: Date;
  expiresIn: number;
  issuedAt: Date;
}

export interface ConnectCodeIssuer {
  issueForUser(userId: string, purpose?: AccountConnectCodePurpose): Promise<IssuedConnectCode>;
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
  input: { issuerUserId: string; userId: string; ttlSeconds?: number; purpose?: AccountConnectCodePurpose },
  now: Date,
): Promise<IssuedConnectCode> {
  const expiresIn = input.ttlSeconds ?? CONNECT_CODE_TTL_SECONDS;
  if (!Number.isInteger(expiresIn) || expiresIn <= 0) {
    throw new TypeError("Connect code TTL must be a positive integer");
  }
  const code = `${input.purpose === "slack-agent-provision" ? SLACK_AGENT_PROVISION_CODE_PREFIX : ""}${generateSecret(24)}`;
  const expiresAt = new Date(now.getTime() + expiresIn * 1000);
  await transaction.insert(accountCliLoginCodes).values({
    tokenHash: accountConnectCodeHash(code, input.purpose ?? "login"),
    userId: input.userId,
    issuedByUserId: input.issuerUserId,
    createdAt: now,
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

  constructor(database: DatabaseClient, options: ConnectCodeServiceOptions = {}) {
    this.#database = database;
    this.#now = options.now ?? (() => new Date());
  }

  async issueForUser(userId: string, purpose?: AccountConnectCodePurpose): Promise<IssuedConnectCode> {
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
      return issueConnectCodeInTransaction(transaction, { issuerUserId: userId, userId, purpose }, now);
    });
  }
}

/** Commits one-time consumption before the caller performs its separately authorized operation. */
export async function consumeAccountConnectCode(
  database: DatabaseClient,
  code: string,
  purpose: AccountConnectCodePurpose,
  expectedUserId?: string,
  now = new Date(),
): Promise<string> {
  const isProvisionCode = code.startsWith(SLACK_AGENT_PROVISION_CODE_PREFIX);
  if (isProvisionCode !== (purpose === "slack-agent-provision")) {
    throw invalidCredential("AUTH_CODE_PURPOSE_MISMATCH", "This code cannot be used for this operation");
  }
  const codeHash = accountConnectCodeHash(code, purpose);
  return database.transaction(async (transaction) => {
    const [connectCode] = await transaction
      .select()
      .from(accountCliLoginCodes)
      .where(eq(accountCliLoginCodes.tokenHash, codeHash))
      .for("update");
    if (!connectCode) {
      throw invalidCredential("AUTH_INVALID_CODE", "The connect code is invalid");
    }
    if (connectCode.consumedAt) {
      throw invalidCredential("AUTH_CODE_CONSUMED", "The connect code has already been used");
    }
    if (connectCode.expiresAt <= now) {
      throw invalidCredential("AUTH_CODE_EXPIRED", "The connect code has expired");
    }

    const [user] = await transaction.select().from(users).where(eq(users.id, connectCode.userId)).limit(1);
    const [issuer] = await transaction.select().from(users).where(eq(users.id, connectCode.issuedByUserId)).limit(1);
    assertActiveCodeUsers(user, issuer);
    if (expectedUserId && expectedUserId !== user.id) {
      throw new AuthServiceError(
        "AUTH_USER_MISMATCH",
        "deterministic",
        "The connect code belongs to another user",
        409,
      );
    }

    // Conditional, so a code two callers reach at once is redeemed by exactly one of them.
    const [consumed] = await transaction
      .update(accountCliLoginCodes)
      .set({ consumedAt: now })
      .where(and(eq(accountCliLoginCodes.id, connectCode.id), isNull(accountCliLoginCodes.consumedAt)))
      .returning({ id: accountCliLoginCodes.id });
    if (!consumed) {
      throw invalidCredential("AUTH_CODE_CONSUMED", "The connect code has already been used");
    }
    return user.id;
  });
}

function assertActiveCodeUsers(
  user: typeof users.$inferSelect | undefined,
  issuer: typeof users.$inferSelect | undefined,
): asserts user is typeof users.$inferSelect {
  if (!user || !issuer) {
    throw invalidCredential("AUTH_INVALID_CODE", "The connect code is invalid");
  }
  if (user.suspendedAt || issuer.suspendedAt) {
    throw invalidCredential("AUTH_USER_SUSPENDED", "The user account is suspended");
  }
}

// Tag the stored hash, not only its input: legacy login consumers compute plain hex and cannot match it after rollback.
function accountConnectCodeHash(code: string, purpose: AccountConnectCodePurpose): string {
  return `${purpose === "slack-agent-provision" ? SLACK_AGENT_PROVISION_CODE_PREFIX : ""}${hashSecret(code)}`;
}
