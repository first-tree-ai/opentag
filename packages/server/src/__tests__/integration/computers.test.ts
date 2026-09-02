import {
  AccountComputerSummarySchema,
  accountComputerConnectCodePath,
  HTTP_PATHS,
  PROVIDER_READINESS_V1_HEADER,
  RUNTIME_PROTOCOL_V2,
} from "@opentag/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { bootstrapInitialAdmin } from "../../admin/bootstrap.js";
import { createApp } from "../../app.js";
import { createBetterAuth } from "../../auth/better-auth.js";
import { BetterAuthSessionTokens } from "../../auth/session-tokens.js";
import { createDatabaseClient } from "../../db/client.js";
import { computerConnectCodes, computerCredentials, computers, users } from "../../db/schema/index.js";
import { ConnectionRegistry } from "../../runtime/connection-registry.js";
import { AuthService, ConnectCodeService, hashSecret } from "../../services/auth/index.js";
import { ComputerService, MachineAuthService } from "../../services/computers/index.js";
import { type MigratedTestDatabase, startMigratedTestDatabase } from "./migrated-test-database.js";

const betterAuthSecret = "computer-test-secret-at-least-32-characters";
let testDatabase: MigratedTestDatabase;
let databaseUrl: string;

beforeAll(async () => {
  testDatabase = await startMigratedTestDatabase();
  databaseUrl = testDatabase.databaseUrl;
}, 120_000);

afterAll(async () => testDatabase.stop());
beforeEach(async () => testDatabase.reset());

async function fixture() {
  const client = createDatabaseClient(databaseUrl);
  const bootstrap = await bootstrapInitialAdmin(client.database, {
    displayName: "Admin",
    email: "admin@example.com",
  });
  const auth = new AuthService(
    client.database,
    new BetterAuthSessionTokens(
      createBetterAuth(client.database, {
        onSessionCreating: async () => {},
        publicUrl: "http://localhost:8000",
        secret: betterAuthSecret,
        secureCookies: false,
        sessionTtlSeconds: 3600,
      }),
      client.database,
    ),
  );
  const registry = new ConnectionRegistry();
  const machineAuth = new MachineAuthService(client.database, {
    onCredentialRotated: async (computerId) => {
      await registry.closeComputer(computerId);
    },
  });
  const service = new ComputerService(client.database, auth);
  return { ...client, auth, bootstrap, machineAuth, registry, service };
}

function registerFrame(installationId: string, instanceId: string) {
  return {
    type: "computer:register" as const,
    requestId: crypto.randomUUID(),
    installationId,
    instanceId,
    displayName: "workstation",
    platform: "linux" as const,
    arch: "x64",
    clientVersion: "0.0.2",
    capabilities: { imCredentialGrant: 0 as const },
    protocolVersion: RUNTIME_PROTOCOL_V2,
    supportedCapabilities: { imCredentialGrant: { min: 1, max: 1 } },
    requiredServerCapabilities: [],
  };
}

function exchangeInput(code: string, installationId: string) {
  return {
    code,
    installationId,
    displayName: "workstation" as const,
    platform: "linux" as const,
    arch: "x64",
    clientVersion: "0.0.2",
  };
}

async function connect(
  value: Awaited<ReturnType<typeof fixture>>,
  accountId = value.bootstrap.userId,
  installationId: string = crypto.randomUUID(),
) {
  const issued = await value.machineAuth.issueForAccount(accountId, {});
  return value.machineAuth.exchangeConnectCode(exchangeInput(issued.code, installationId));
}

async function repair(
  value: Awaited<ReturnType<typeof fixture>>,
  targetComputerId: string,
  accountId = value.bootstrap.userId,
  installationId = crypto.randomUUID(),
) {
  const issued = await value.machineAuth.issueForAccount(accountId, { mode: "repair", targetComputerId });
  return value.machineAuth.exchangeConnectCode(exchangeInput(issued.code, installationId));
}

describe("Computer connection persistence", () => {
  it("enforces the 0.0.2 Client floor and strict SemVer before any side effects", async () => {
    const value = await fixture();
    try {
      const issued = await value.machineAuth.issueForAccount(value.bootstrap.userId, {});
      const computerId = crypto.randomUUID();
      await expect(
        value.machineAuth.exchangeConnectCode({
          ...exchangeInput(issued.code, computerId),
          clientVersion: "0.0.1",
        }),
      ).rejects.toMatchObject({ code: "CLIENT_VERSION_UNSUPPORTED", statusCode: 400 });
      await expect(
        value.machineAuth.exchangeConnectCode({
          ...exchangeInput(issued.code, computerId),
          clientVersion: "0.0.3-01",
        }),
      ).rejects.toMatchObject({ code: "CLIENT_VERSION_UNSUPPORTED", statusCode: 400 });
      const [unspent] = await value.database
        .select({ consumedAt: computerConnectCodes.consumedAt })
        .from(computerConnectCodes);
      expect(unspent?.consumedAt).toBeNull();

      const exchange = await value.machineAuth.exchangeConnectCode(exchangeInput(issued.code, computerId));
      const [before] = await value.database.select().from(computers).where(eq(computers.id, exchange.computerId));
      await expect(
        value.service.register(exchange, {
          ...registerFrame(exchange.installationId, crypto.randomUUID()),
          clientVersion: "1.0.0+build..7",
        }),
      ).rejects.toMatchObject({ code: "CLIENT_VERSION_UNSUPPORTED", statusCode: 400 });
      await expect(
        value.service.register(exchange, {
          ...registerFrame(exchange.installationId, crypto.randomUUID()),
          clientVersion: "0.0.1",
        }),
      ).rejects.toMatchObject({ code: "CLIENT_VERSION_UNSUPPORTED", statusCode: 400 });
      const [after] = await value.database.select().from(computers).where(eq(computers.id, exchange.computerId));
      expect(after).toEqual(before);
    } finally {
      await value.sql.end();
    }
  });

  it("registers one Computer and fences an older instance", async () => {
    const value = await fixture();
    try {
      const exchange = await connect(value);
      const first = crypto.randomUUID();
      const second = crypto.randomUUID();
      await value.service.register(exchange, registerFrame(exchange.installationId, first));
      await value.service.register(exchange, registerFrame(exchange.installationId, second));
      expect(await value.service.heartbeat(exchange, first)).toBe(false);
      expect(await value.service.disconnect(exchange.computerId, first)).toBe(false);
      expect(await value.service.heartbeat(exchange, second)).toBe(true);
      expect(await value.database.select().from(computers)).toHaveLength(1);
      const [computer] = await value.database.select().from(computers);
      expect(computer).toMatchObject({
        id: exchange.computerId,
        ownerAccountId: value.bootstrap.userId,
        currentInstallationId: exchange.installationId,
        currentInstanceId: second,
        displayName: "workstation",
        platform: "linux",
      });
      const [credential] = await value.database
        .select()
        .from(computerCredentials)
        .where(eq(computerCredentials.id, exchange.credentialId));
      expect(credential).toMatchObject({
        id: exchange.credentialId,
        computerId: exchange.computerId,
        issuedByUserId: value.bootstrap.userId,
        revokedAt: null,
      });
    } finally {
      await value.sql.end();
    }
  });

  it("creates a new Computer for every create code and never reuses an installation", async () => {
    const value = await fixture();
    try {
      const first = await connect(value);
      const second = await connect(value);
      expect(second.computerId).not.toBe(first.computerId);
      expect(second.installationId).not.toBe(first.installationId);
      expect(await value.database.select().from(computers)).toHaveLength(2);
      await expect(connect(value, value.bootstrap.userId, first.installationId)).rejects.toMatchObject({
        code: "COMPUTER_IDENTITY_CONFLICT",
        statusCode: 409,
      });
    } finally {
      await value.sql.end();
    }
  });

  it("rotates the machine credential and rejects Account tokens as machine authority", async () => {
    const value = await fixture();
    try {
      const computerId = crypto.randomUUID();
      const first = await connect(value, value.bootstrap.userId, computerId);
      await expect(value.machineAuth.verifyMachineToken(first.machineToken)).resolves.toMatchObject({
        computerId: first.computerId,
        installationId: computerId,
      });

      const account = await value.auth.exchangeConnectCode(value.bootstrap.connectCode);
      await expect(value.machineAuth.verifyMachineToken(account.accessToken)).rejects.toMatchObject({
        code: "AUTH_INVALID_TOKEN",
        statusCode: 401,
      });
      await expect(
        value.machineAuth.verifyMachineToken(`otmc_${"-".repeat(36)}.${"a".repeat(43)}`),
      ).rejects.toMatchObject({
        code: "AUTH_INVALID_TOKEN",
        statusCode: 401,
      });

      const rotatedInstallationId = crypto.randomUUID();
      const rotated = await repair(value, first.computerId, value.bootstrap.userId, rotatedInstallationId);
      expect(rotated.computerId).toBe(first.computerId);
      expect(rotated.installationId).toBe(rotatedInstallationId);
      await expect(value.machineAuth.verifyMachineToken(first.machineToken)).rejects.toMatchObject({
        code: "AUTH_INVALID_TOKEN",
      });
      await expect(value.machineAuth.verifyMachineToken(rotated.machineToken)).resolves.toMatchObject({
        computerId: first.computerId,
        installationId: rotatedInstallationId,
      });
      const credentials = await value.database
        .select()
        .from(computerCredentials)
        .where(eq(computerCredentials.computerId, first.computerId));
      expect(credentials).toHaveLength(2);
      expect(credentials.find((row) => row.id === first.credentialId)).toMatchObject({
        revokedAt: expect.any(Date),
        revokedByUserId: value.bootstrap.userId,
      });
      expect(credentials.find((row) => row.id === rotated.credentialId)).toMatchObject({
        revokedAt: null,
      });
      const [accountComputer] = await value.database.select().from(computers).where(eq(computers.id, first.computerId));
      expect(accountComputer).toMatchObject({
        id: first.computerId,
        ownerAccountId: value.bootstrap.userId,
        currentInstallationId: rotatedInstallationId,
      });
    } finally {
      await value.sql.end();
    }
  });

  it("rolls back Computer repair when the account-owned identity diverges", async () => {
    const value = await fixture();
    try {
      const computerId = crypto.randomUUID();
      const first = await connect(value, value.bootstrap.userId, computerId);
      const issued = await value.machineAuth.issueForAccount(value.bootstrap.userId, {
        mode: "repair",
        targetComputerId: first.computerId,
      });
      const [otherUser] = await value.database
        .insert(users)
        .values({ email: "other-owner@example.com", displayName: "Other" })
        .returning();
      if (!otherUser) throw new Error("Other Account fixture was not created");
      await value.database
        .update(computers)
        .set({ ownerAccountId: otherUser.id })
        .where(eq(computers.id, first.computerId));

      const before = {
        computers: await value.database.select().from(computers),
        targetCredentials: await value.database.select().from(computerCredentials),
        codes: await value.database.select().from(computerConnectCodes),
      };

      await expect(
        value.machineAuth.exchangeConnectCode({
          code: issued.code,
          installationId: crypto.randomUUID(),
          displayName: "mutated",
          platform: "darwin",
          arch: "arm64",
          clientVersion: "9.9.9",
        }),
      ).rejects.toMatchObject({ code: "AUTH_INVALID_CODE", statusCode: 401 });

      expect(await value.database.select().from(computers)).toEqual(before.computers);
      expect(await value.database.select().from(computerCredentials)).toEqual(before.targetCredentials);
      expect(await value.database.select().from(computerConnectCodes)).toEqual(before.codes);
      expect(before.codes.filter((row) => row.consumedAt === null)).toHaveLength(1);
      expect(before.computers[0]).toMatchObject({
        ownerAccountId: otherUser.id,
        currentInstallationId: computerId,
      });
    } finally {
      await value.sql.end();
    }
  });

  it("rejects a repair that reuses an installation already bound to another Computer", async () => {
    const value = await fixture();
    try {
      const first = await connect(value, value.bootstrap.userId, crypto.randomUUID());
      const second = await connect(value, value.bootstrap.userId, crypto.randomUUID());
      const issued = await value.machineAuth.issueForAccount(value.bootstrap.userId, {
        mode: "repair",
        targetComputerId: second.computerId,
      });
      const before = {
        computers: await value.database.select().from(computers),
        targetCredentials: await value.database.select().from(computerCredentials),
        codes: await value.database.select().from(computerConnectCodes),
      };

      await expect(
        value.machineAuth.exchangeConnectCode({
          code: issued.code,
          installationId: first.installationId,
          displayName: "mutated",
          platform: "darwin",
          arch: "arm64",
          clientVersion: "9.9.9",
        }),
      ).rejects.toMatchObject({ code: "COMPUTER_IDENTITY_CONFLICT", statusCode: 409 });

      expect(await value.database.select().from(computers)).toEqual(before.computers);
      expect(await value.database.select().from(computerCredentials)).toEqual(before.targetCredentials);
      expect(before.codes.filter((row) => row.consumedAt === null)).toHaveLength(1);
      const [code] = await value.database
        .select()
        .from(computerConnectCodes)
        .where(eq(computerConnectCodes.tokenHash, hashSecret(issued.code)));
      expect(code).toMatchObject({ consumedAt: null });
    } finally {
      await value.sql.end();
    }
  });

  it("rejects an old WebSocket credential rotated after authentication but before registration", async () => {
    const value = await fixture();
    const computerId = crypto.randomUUID();
    const first = await connect(value, value.bootstrap.userId, computerId);
    const app = createApp({
      authService: value.auth,
      computerService: value.service,
      machineAuthService: value.machineAuth,
      runtime: { authTimeoutMs: 1_000, registerTimeoutMs: 1_000, registry: value.registry },
    });
    try {
      const address = await app.listen({ host: "127.0.0.1", port: 0 });
      const oldSocket = new WebSocket(`${address.replace("http", "ws")}${HTTP_PATHS.computerRuntimeWebSocket}`);
      const oldFrames = frameQueue(oldSocket);
      await opened(oldSocket);
      oldSocket.send(
        JSON.stringify({
          type: "auth",
          requestId: crypto.randomUUID(),
          protocolVersion: 1,
          machineToken: first.machineToken,
        }),
      );
      expect(await oldFrames.next()).toMatchObject({ type: "auth:result", ok: true });
      expect(await oldFrames.next()).toMatchObject({ type: "server:welcome" });

      const rotatedInstallationId = crypto.randomUUID();
      const rotated = await repair(value, first.computerId, value.bootstrap.userId, rotatedInstallationId);
      const oldClose = closeCode(oldSocket);
      oldSocket.send(JSON.stringify(webSocketRegisterFrame(computerId, crypto.randomUUID())));
      expect(await oldFrames.next()).toMatchObject({ type: "error", code: "COMPUTER_NOT_REGISTERED" });
      await expect(oldClose).resolves.toBe(4409);
      expect(value.registry.currentInstanceId(first.computerId)).toBeUndefined();
      const [afterOldRegistration] = await value.database
        .select({ currentInstanceId: computers.currentInstanceId })
        .from(computers)
        .where(eq(computers.id, first.computerId));
      expect(afterOldRegistration?.currentInstanceId).toBeNull();

      const newSocket = new WebSocket(`${address.replace("http", "ws")}${HTTP_PATHS.computerRuntimeWebSocket}`);
      const newFrames = frameQueue(newSocket);
      await opened(newSocket);
      newSocket.send(
        JSON.stringify({
          type: "auth",
          requestId: crypto.randomUUID(),
          protocolVersion: 1,
          machineToken: rotated.machineToken,
        }),
      );
      expect(await newFrames.next()).toMatchObject({ type: "auth:result", ok: true });
      expect(await newFrames.next()).toMatchObject({ type: "server:welcome" });
      const newInstanceId = crypto.randomUUID();
      newSocket.send(JSON.stringify(webSocketRegisterFrame(rotatedInstallationId, newInstanceId)));
      expect(await newFrames.next()).toMatchObject({ type: "computer:register:result", ok: true });
      expect(value.registry.currentInstanceId(first.computerId)).toBe(newInstanceId);
      newSocket.close();
    } finally {
      await app.close();
      await value.sql.end();
    }
  });

  it("consumes a Computer connect code exactly once under concurrent exchange", async () => {
    const value = await fixture();
    try {
      const issued = await value.machineAuth.issueForAccount(value.bootstrap.userId, {});
      const input = {
        code: issued.code,
        installationId: crypto.randomUUID(),
        displayName: "workstation",
        platform: "linux" as const,
        arch: "x64",
        clientVersion: "0.0.2",
      };
      const results = await Promise.allSettled([
        value.machineAuth.exchangeConnectCode(input),
        value.machineAuth.exchangeConnectCode(input),
      ]);
      expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
      expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1);
      const rejected = results.find(({ status }) => status === "rejected");
      expect(rejected).toMatchObject({ reason: { code: "AUTH_CODE_CONSUMED", statusCode: 401 } });
    } finally {
      await value.sql.end();
    }
  });

  it("exchanges a Computer connect code through the public machine route", async () => {
    const value = await fixture();
    try {
      const issued = await value.machineAuth.issueForAccount(value.bootstrap.userId, {});
      const installationId = crypto.randomUUID();
      const app = createApp({
        authService: value.auth,
        computerConnectCode: {
          downloadBaseUrl: "https://storage.googleapis.com/opentag-release/releases",
          environment: "staging",
          publicUrl: "https://dev.example.com",
        },
        computerService: value.service,
        machineAuthService: value.machineAuth,
      });
      try {
        const response = await app.inject({
          method: "POST",
          url: HTTP_PATHS.computerConnectExchange,
          payload: {
            code: issued.code,
            installationId,
            displayName: "workstation",
            platform: "linux",
            arch: "x64",
            clientVersion: "0.0.2",
          },
        });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({
          computerId: expect.any(String),
          installationId,
          machineToken: expect.stringMatching(/^otmc_/),
        });
      } finally {
        await app.close();
      }
    } finally {
      await value.sql.end();
    }
  });

  it("issues connect codes through the Account-native route", async () => {
    const value = await fixture();
    try {
      const account = await value.auth.exchangeConnectCode(value.bootstrap.connectCode);
      const app = createApp({
        authService: value.auth,
        computerConnectCode: {
          downloadBaseUrl: "https://storage.googleapis.com/opentag-release/releases",
          environment: "staging",
          publicUrl: "https://dev.example.com",
        },
        computerService: value.service,
        machineAuthService: value.machineAuth,
      });
      try {
        const issued = await app.inject({
          method: "POST",
          url: HTTP_PATHS.accountComputerConnectCodes,
          headers: { authorization: `Bearer ${account.accessToken}` },
        });
        expect(issued.statusCode).toBe(201);
        expect(issued.headers["cache-control"]).toBe("no-store");
        const command = issued.json().bootstrapCommand as string;
        expect(command).toContain(
          'opentag_installer="$(mktemp)" && curl -fsSL https://storage.googleapis.com/opentag-release/releases/staging/install.sh -o "$opentag_installer" && sh "$opentag_installer" && rm -f "$opentag_installer" && PATH="$HOME/.local/bin${PATH:+:$PATH}" "$HOME/.local/bin/opentag-staging" connect --server https://dev.example.com -- otcc_',
        );
        const code = command.split(" -- ").at(-1);
        if (!code) throw new Error("Computer connect command did not contain a code");

        const exchanged = await app.inject({
          method: "POST",
          url: HTTP_PATHS.computerConnectExchange,
          payload: {
            code,
            installationId: crypto.randomUUID(),
            displayName: "workstation",
            platform: "linux",
            arch: "x64",
            clientVersion: "0.0.2",
          },
        });
        expect(exchanged.statusCode).toBe(200);
        expect(exchanged.json().machineToken).toMatch(/^otmc_/);
      } finally {
        await app.close();
      }
    } finally {
      await value.sql.end();
    }
  });

  it("rejects machine credentials on Account management routes and lists Computers for Account auth", async () => {
    const value = await fixture();
    try {
      const exchange = await connect(value);
      await value.service.register(exchange, registerFrame(exchange.installationId, crypto.randomUUID()));
      const account = await value.auth.exchangeConnectCode(value.bootstrap.connectCode);
      const app = createApp({
        authService: value.auth,
        computerConnectCode: {
          downloadBaseUrl: "https://storage.googleapis.com/opentag-release/releases",
          environment: "staging",
          publicUrl: "https://dev.example.com",
        },
        computerService: value.service,
        machineAuthService: value.machineAuth,
      });
      try {
        const denied = await app.inject({
          method: "GET",
          url: HTTP_PATHS.accountComputers,
          headers: { authorization: `Bearer ${exchange.machineToken}` },
        });
        expect(denied.statusCode).toBe(401);

        const codeDenied = await app.inject({
          method: "POST",
          url: HTTP_PATHS.accountComputerConnectCodes,
          headers: { authorization: `Bearer ${exchange.machineToken}` },
        });
        expect(codeDenied.statusCode).toBe(401);

        const response = await app.inject({
          method: "GET",
          url: HTTP_PATHS.accountComputers,
          headers: { authorization: `Bearer ${account.accessToken}` },
        });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({
          computers: [
            {
              computerId: exchange.computerId,
              connectionStatus: "online",
            },
          ],
        });
        expect(AccountComputerSummarySchema.parse(response.json().computers[0])).not.toHaveProperty(
          "providerReadiness",
        );

        const negotiated = await app.inject({
          method: "GET",
          url: HTTP_PATHS.accountComputers,
          headers: {
            authorization: `Bearer ${account.accessToken}`,
            [PROVIDER_READINESS_V1_HEADER]: "1",
          },
        });
        expect(negotiated.json().computers[0]).toMatchObject({
          providerReadiness: [
            { provider: "codex", status: "checking", observedAt: null },
            { provider: "claude-code", status: "checking", observedAt: null },
          ],
        });
      } finally {
        await app.close();
      }
    } finally {
      await value.sql.end();
    }
  });
});

describe("Connect code redemption status", () => {
  it("reports pending before redemption and the exact Computer after it", async () => {
    const value = await fixture();
    try {
      const issued = await value.machineAuth.issueForAccount(value.bootstrap.userId, {});
      const pending = await value.machineAuth.getConnectCodeStatusForAccount(
        value.bootstrap.userId,
        issued.connectCodeId,
      );
      expect(pending).toEqual({
        connectCodeId: issued.connectCodeId,
        state: "pending",
        computerId: null,
        redeemedAt: null,
      });

      const exchange = await value.machineAuth.exchangeConnectCode(exchangeInput(issued.code, crypto.randomUUID()));
      const redeemed = await value.machineAuth.getConnectCodeStatusForAccount(
        value.bootstrap.userId,
        issued.connectCodeId,
      );
      expect(redeemed.state).toBe("redeemed");
      expect(redeemed.computerId).toBe(exchange.computerId);
      expect(redeemed.redeemedAt).not.toBeNull();

      // Durable evidence, not a reachability report: the machine that redeemed the code has not
      // connected yet, and the verdict still names it.
      const { computers: listed } = await value.service.listAccountComputers(value.bootstrap.userId);
      const machine = listed.find((one) => one.computerId === exchange.computerId);
      expect(machine?.connectionStatus).toBe("offline");
    } finally {
      await value.sql.end();
    }
  });

  it("correlates each code with its own redeemer when machines answer out of order", async () => {
    const value = await fixture();
    try {
      const first = await value.machineAuth.issueForAccount(value.bootstrap.userId, {});
      const second = await value.machineAuth.issueForAccount(value.bootstrap.userId, {});
      // The second code is spent first: correlation follows the code, never the order of arrival.
      const secondEnrollment = await value.machineAuth.exchangeConnectCode(
        exchangeInput(second.code, crypto.randomUUID()),
      );
      const firstEnrollment = await value.machineAuth.exchangeConnectCode(
        exchangeInput(first.code, crypto.randomUUID()),
      );

      const firstStatus = await value.machineAuth.getConnectCodeStatusForAccount(
        value.bootstrap.userId,
        first.connectCodeId,
      );
      const secondStatus = await value.machineAuth.getConnectCodeStatusForAccount(
        value.bootstrap.userId,
        second.connectCodeId,
      );
      expect(firstStatus).toMatchObject({ state: "redeemed", computerId: firstEnrollment.computerId });
      expect(secondStatus).toMatchObject({ state: "redeemed", computerId: secondEnrollment.computerId });
      expect(firstStatus.computerId).not.toBe(secondStatus.computerId);
    } finally {
      await value.sql.end();
    }
  });

  it("fails closed for an expired code and for a revoked code, never naming a Computer", async () => {
    const value = await fixture();
    try {
      const expiring = await value.machineAuth.issueForAccount(value.bootstrap.userId, {});
      await value.database
        .update(computerConnectCodes)
        .set({ expiresAt: new Date() })
        .where(eq(computerConnectCodes.id, expiring.connectCodeId));
      await expect(
        value.machineAuth.getConnectCodeStatusForAccount(value.bootstrap.userId, expiring.connectCodeId),
      ).resolves.toEqual({
        connectCodeId: expiring.connectCodeId,
        state: "expired",
        computerId: null,
        redeemedAt: null,
      });

      const revoking = await value.machineAuth.issueForAccount(value.bootstrap.userId, {});
      await value.database
        .update(computerConnectCodes)
        .set({ revokedByUserId: value.bootstrap.userId, revokedAt: new Date() })
        .where(eq(computerConnectCodes.id, revoking.connectCodeId));
      await expect(
        value.machineAuth.getConnectCodeStatusForAccount(value.bootstrap.userId, revoking.connectCodeId),
      ).resolves.toEqual({
        connectCodeId: revoking.connectCodeId,
        state: "revoked",
        computerId: null,
        redeemedAt: null,
      });
    } finally {
      await value.sql.end();
    }
  });

  it("answers a foreign Account and an unknown id with the same not-found", async () => {
    const value = await fixture();
    try {
      const otherAccountId = crypto.randomUUID();
      await value.database.insert(users).values({
        id: otherAccountId,
        email: "other@example.com",
        displayName: "Other",
      });
      const issued = await value.machineAuth.issueForAccount(value.bootstrap.userId, {});

      await expect(
        value.machineAuth.getConnectCodeStatusForAccount(otherAccountId, issued.connectCodeId),
      ).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND", statusCode: 404 });
      await expect(
        value.machineAuth.getConnectCodeStatusForAccount(value.bootstrap.userId, crypto.randomUUID()),
      ).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND", statusCode: 404 });
    } finally {
      await value.sql.end();
    }
  });

  it("answers repeated and concurrent reads identically across the redemption boundary", async () => {
    const value = await fixture();
    try {
      const issued = await value.machineAuth.issueForAccount(value.bootstrap.userId, {});
      const read = () => value.machineAuth.getConnectCodeStatusForAccount(value.bootstrap.userId, issued.connectCodeId);

      const before = await Promise.all([read(), read(), read()]);
      for (const verdict of before) expect(verdict).toEqual(before[0]);

      const exchange = await value.machineAuth.exchangeConnectCode(exchangeInput(issued.code, crypto.randomUUID()));
      const after = await Promise.all([read(), read(), read()]);
      for (const verdict of after) {
        expect(verdict).toEqual(after[0]);
        expect(verdict).toMatchObject({ state: "redeemed", computerId: exchange.computerId });
      }
    } finally {
      await value.sql.end();
    }
  });

  it("serves the poll over HTTP to the issuing Account only, and never leaks the code", async () => {
    const value = await fixture();
    try {
      const account = await value.auth.exchangeConnectCode(value.bootstrap.connectCode);
      const otherAccountId = crypto.randomUUID();
      await value.database.insert(users).values({
        id: otherAccountId,
        email: "other@example.com",
        displayName: "Other",
      });
      const otherLogin = await new ConnectCodeService(value.database).issueForUser(otherAccountId);
      const otherAccount = await value.auth.exchangeConnectCode(otherLogin.code);
      const app = createApp({
        authService: value.auth,
        computerConnectCode: {
          downloadBaseUrl: "https://storage.googleapis.com/opentag-release/releases",
          environment: "staging",
          publicUrl: "https://dev.example.com",
        },
        computerService: value.service,
        machineAuthService: value.machineAuth,
      });
      try {
        const issued = await app.inject({
          method: "POST",
          url: HTTP_PATHS.accountComputerConnectCodes,
          headers: { authorization: `Bearer ${account.accessToken}` },
        });
        expect(issued.statusCode).toBe(201);
        const { connectCodeId } = issued.json() as { connectCodeId: string };

        const pending = await app.inject({
          method: "GET",
          url: accountComputerConnectCodePath(connectCodeId),
          headers: { authorization: `Bearer ${account.accessToken}` },
        });
        expect(pending.statusCode).toBe(200);
        expect(pending.headers["cache-control"]).toBe("no-store");
        expect(pending.json()).toEqual({ connectCodeId, state: "pending", computerId: null, redeemedAt: null });

        // The code redeems; the Account reads back the exact Computer, and the answer carries no
        // code, hash, or machine token.
        const command = issued.json().bootstrapCommand as string;
        const code = command.split(" -- ").at(-1);
        if (!code) throw new Error("Computer connect command did not contain a code");
        const exchange = await value.machineAuth.exchangeConnectCode(exchangeInput(code, crypto.randomUUID()));
        const redeemed = await app.inject({
          method: "GET",
          url: accountComputerConnectCodePath(connectCodeId),
          headers: { authorization: `Bearer ${account.accessToken}` },
        });
        expect(redeemed.statusCode).toBe(200);
        expect(redeemed.json()).toEqual({
          connectCodeId,
          state: "redeemed",
          computerId: exchange.computerId,
          redeemedAt: expect.any(String),
        });
        expect(redeemed.body).not.toContain(code);
        expect(redeemed.body).not.toContain(exchange.machineToken);

        // Another Account's token and the machine's own credential both fail closed.
        const foreign = await app.inject({
          method: "GET",
          url: accountComputerConnectCodePath(connectCodeId),
          headers: { authorization: `Bearer ${otherAccount.accessToken}` },
        });
        expect(foreign.statusCode).toBe(404);
        const machine = await app.inject({
          method: "GET",
          url: accountComputerConnectCodePath(connectCodeId),
          headers: { authorization: `Bearer ${exchange.machineToken}` },
        });
        expect(machine.statusCode).toBe(401);
        const anonymous = await app.inject({ method: "GET", url: accountComputerConnectCodePath(connectCodeId) });
        expect(anonymous.statusCode).toBe(401);
      } finally {
        await app.close();
      }
    } finally {
      await value.sql.end();
    }
  });
});

function opened(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) return Promise.resolve();
  return new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
}

function webSocketRegisterFrame(computerId: string, instanceId: string) {
  const {
    protocolVersion: _protocolVersion,
    requiredServerCapabilities: _required,
    supportedCapabilities: _supported,
    ...frame
  } = registerFrame(computerId, instanceId);
  return frame;
}

function frameQueue(socket: WebSocket): { next(): Promise<Record<string, unknown>> } {
  const buffered: Array<Record<string, unknown>> = [];
  const waiting: Array<(frame: Record<string, unknown>) => void> = [];
  socket.on("message", (data) => {
    const frame = JSON.parse(data.toString()) as Record<string, unknown>;
    const resolve = waiting.shift();
    if (resolve) resolve(frame);
    else buffered.push(frame);
  });
  return {
    next: async () => {
      const frame = buffered.shift();
      if (frame) return frame;
      return new Promise<Record<string, unknown>>((resolve) => waiting.push(resolve));
    },
  };
}

function closeCode(socket: WebSocket): Promise<number> {
  return new Promise((resolve) => socket.once("close", resolve));
}
