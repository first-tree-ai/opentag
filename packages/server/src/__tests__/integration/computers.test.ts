import {
  HTTP_PATHS,
  PROVIDER_READINESS_V1_HEADER,
  RUNTIME_PROTOCOL_V2,
  WorkspaceComputerSummarySchema,
  workspaceComputerConnectCodesPath,
} from "@opentag/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createApp } from "../../app.js";
import { createBetterAuth } from "../../auth/better-auth.js";
import { BetterAuthSessionTokens } from "../../auth/session-tokens.js";
import { createDatabaseClient } from "../../db/client.js";
import {
  accountComputers,
  computerConnectCodes,
  computerCredentials,
  computers,
  users,
  workspaceComputerCredentials,
  workspaceComputers,
} from "../../db/schema/index.js";
import { ConnectionRegistry } from "../../runtime/connection-registry.js";
import { AuthService } from "../../services/auth/index.js";
import { ComputerService, MachineAuthService } from "../../services/computers/index.js";
import { bootstrapTestAccount as bootstrapInitialAdmin } from "../test-account.js";
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
    workspaceDisplayName: "Example",
    workspaceName: "example",
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
    onCredentialRotated: async (workspaceComputerId) => {
      await registry.closeEnrollment(workspaceComputerId);
    },
  });
  const service = new ComputerService(client.database, auth);
  return { ...client, auth, bootstrap, machineAuth, registry, service };
}

function registerFrame(computerId: string, instanceId: string) {
  return {
    type: "computer:register" as const,
    requestId: crypto.randomUUID(),
    computerId,
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

function exchangeInput(code: string, computerId: string) {
  return {
    code,
    computerId,
    displayName: "workstation" as const,
    platform: "linux" as const,
    arch: "x64",
    clientVersion: "0.0.2",
  };
}

async function enroll(
  value: Awaited<ReturnType<typeof fixture>>,
  accountId = value.bootstrap.userId,
  computerId: string = crypto.randomUUID(),
) {
  const issued = await value.machineAuth.issueForAccount(accountId, {});
  return value.machineAuth.exchangeConnectCode(exchangeInput(issued.code, computerId));
}

async function repair(
  value: Awaited<ReturnType<typeof fixture>>,
  targetComputerId: string,
  accountId = value.bootstrap.userId,
  computerId = crypto.randomUUID(),
) {
  const issued = await value.machineAuth.issueForAccount(accountId, { mode: "repair", targetComputerId });
  return value.machineAuth.exchangeConnectCode(exchangeInput(issued.code, computerId));
}

describe("Computer enrollment persistence", () => {
  it("enforces the 0.0.2 Client floor before consuming a code or mutating Computer observations", async () => {
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
      const [unspent] = await value.database
        .select({ consumedAt: computerConnectCodes.consumedAt })
        .from(computerConnectCodes);
      expect(unspent?.consumedAt).toBeNull();

      const enrollment = await value.machineAuth.exchangeConnectCode(exchangeInput(issued.code, computerId));
      const [before] = await value.database
        .select()
        .from(accountComputers)
        .where(eq(accountComputers.id, enrollment.workspaceComputerId));
      await expect(
        value.service.register(enrollment, {
          ...registerFrame(enrollment.computerId, crypto.randomUUID()),
          clientVersion: "0.0.1",
        }),
      ).rejects.toMatchObject({ code: "CLIENT_VERSION_UNSUPPORTED", statusCode: 400 });
      const [after] = await value.database
        .select()
        .from(accountComputers)
        .where(eq(accountComputers.id, enrollment.workspaceComputerId));
      expect(after).toEqual(before);
    } finally {
      await value.sql.end();
    }
  });

  it("registers one enrollment and fences an older instance", async () => {
    const value = await fixture();
    try {
      const enrollment = await enroll(value);
      const first = crypto.randomUUID();
      const second = crypto.randomUUID();
      await value.service.register(enrollment, registerFrame(enrollment.computerId, first));
      await value.service.register(enrollment, registerFrame(enrollment.computerId, second));
      expect(await value.service.heartbeat(enrollment, first)).toBe(false);
      expect(await value.service.disconnect(enrollment.workspaceComputerId, first)).toBe(false);
      expect(await value.service.heartbeat(enrollment, second)).toBe(true);
      expect(await value.database.select().from(computers)).toHaveLength(1);
      expect(await value.database.select().from(workspaceComputers)).toHaveLength(1);
      const [legacy] = await value.database.select().from(workspaceComputers);
      const [projected] = await value.database.select().from(accountComputers);
      expect(projected).toMatchObject({
        id: enrollment.workspaceComputerId,
        ownerAccountId: value.bootstrap.userId,
        currentInstallationId: enrollment.computerId,
        currentInstanceId: second,
        displayName: legacy?.displayName,
        platform: legacy?.platform,
      });
      const [legacyCredential] = await value.database
        .select()
        .from(workspaceComputerCredentials)
        .where(eq(workspaceComputerCredentials.id, enrollment.credentialId));
      const [targetCredential] = await value.database
        .select()
        .from(computerCredentials)
        .where(eq(computerCredentials.id, enrollment.credentialId));
      expect(targetCredential).toMatchObject({
        id: enrollment.credentialId,
        computerId: enrollment.workspaceComputerId,
        issuedByUserId: value.bootstrap.userId,
        revokedAt: null,
      });
      expect(legacyCredential).toBeUndefined();
      expect(legacy).toMatchObject({ currentInstanceId: null, connectedAt: null, lastSeenAt: null });
    } finally {
      await value.sql.end();
    }
  });

  it("ignores and does not mirror a divergent legacy observation", async () => {
    const value = await fixture();
    try {
      const enrollment = await enroll(value);
      const instanceId = crypto.randomUUID();
      await value.service.register(enrollment, registerFrame(enrollment.computerId, instanceId));
      await value.database
        .update(workspaceComputers)
        .set({ currentInstanceId: crypto.randomUUID() })
        .where(eq(workspaceComputers.id, enrollment.workspaceComputerId));
      const [legacyBefore] = await value.database
        .select()
        .from(workspaceComputers)
        .where(eq(workspaceComputers.id, enrollment.workspaceComputerId));
      const before = await value.database
        .select()
        .from(accountComputers)
        .where(eq(accountComputers.id, enrollment.workspaceComputerId));

      await expect(value.service.heartbeat(enrollment, instanceId)).resolves.toBe(true);
      await expect(value.service.disconnect(enrollment.workspaceComputerId, instanceId)).resolves.toBe(true);
      const [legacyAfter] = await value.database
        .select()
        .from(workspaceComputers)
        .where(eq(workspaceComputers.id, enrollment.workspaceComputerId));
      expect(legacyAfter).toEqual(legacyBefore);
      expect(before[0]?.currentInstanceId).toBe(instanceId);
      const [canonicalAfter] = await value.database
        .select()
        .from(accountComputers)
        .where(eq(accountComputers.id, enrollment.workspaceComputerId));
      expect(canonicalAfter?.currentInstanceId).toBeNull();
    } finally {
      await value.sql.end();
    }
  });

  it("creates a new Computer for every create code and never reuses an installation", async () => {
    const value = await fixture();
    try {
      const first = await enroll(value);
      const second = await enroll(value);
      expect(second.workspaceComputerId).not.toBe(first.workspaceComputerId);
      expect(second.computerId).not.toBe(first.computerId);
      expect(await value.database.select().from(accountComputers)).toHaveLength(2);
      await expect(enroll(value, value.bootstrap.userId, first.computerId)).rejects.toMatchObject({
        code: "COMPUTER_IDENTITY_CONFLICT",
        statusCode: 409,
      });
    } finally {
      await value.sql.end();
    }
  });

  it("rotates the enrollment credential and rejects Account tokens as machine authority", async () => {
    const value = await fixture();
    try {
      const computerId = crypto.randomUUID();
      const first = await enroll(value, value.bootstrap.userId, computerId);
      await expect(value.machineAuth.verifyMachineToken(first.machineToken)).resolves.toMatchObject({
        workspaceComputerId: first.workspaceComputerId,
        workspaceId: value.bootstrap.workspaceId,
        computerId,
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
      const rotated = await repair(value, first.workspaceComputerId, value.bootstrap.userId, rotatedInstallationId);
      expect(rotated.workspaceComputerId).toBe(first.workspaceComputerId);
      expect(rotated.computerId).toBe(rotatedInstallationId);
      await expect(value.machineAuth.verifyMachineToken(first.machineToken)).rejects.toMatchObject({
        code: "AUTH_INVALID_TOKEN",
      });
      await expect(value.machineAuth.verifyMachineToken(rotated.machineToken)).resolves.toMatchObject({
        workspaceComputerId: first.workspaceComputerId,
      });
      const credentials = await value.database
        .select()
        .from(computerCredentials)
        .where(eq(computerCredentials.computerId, first.workspaceComputerId));
      expect(credentials).toHaveLength(2);
      expect(credentials.find((row) => row.id === first.credentialId)).toMatchObject({
        revokedAt: expect.any(Date),
        revokedByUserId: value.bootstrap.userId,
      });
      expect(credentials.find((row) => row.id === rotated.credentialId)).toMatchObject({
        revokedAt: null,
      });
      expect(
        await value.database
          .select()
          .from(workspaceComputerCredentials)
          .where(eq(workspaceComputerCredentials.id, rotated.credentialId)),
      ).toEqual([]);
      const [accountComputer] = await value.database
        .select()
        .from(accountComputers)
        .where(eq(accountComputers.id, first.workspaceComputerId));
      expect(accountComputer).toMatchObject({
        id: first.workspaceComputerId,
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
      const first = await enroll(value, value.bootstrap.userId, computerId);
      const issued = await value.machineAuth.issueForAccount(value.bootstrap.userId, {
        mode: "repair",
        targetComputerId: first.workspaceComputerId,
      });
      const [otherUser] = await value.database
        .insert(users)
        .values({ email: "other-owner@example.com", displayName: "Other" })
        .returning();
      if (!otherUser) throw new Error("Other Account fixture was not created");
      await value.database
        .update(accountComputers)
        .set({ ownerAccountId: otherUser.id })
        .where(eq(accountComputers.id, first.workspaceComputerId));

      const before = {
        enrollments: await value.database.select().from(workspaceComputers),
        accountComputers: await value.database.select().from(accountComputers),
        legacyCredentials: await value.database.select().from(workspaceComputerCredentials),
        targetCredentials: await value.database.select().from(computerCredentials),
        codes: await value.database.select().from(computerConnectCodes),
      };

      await expect(
        value.machineAuth.exchangeConnectCode({
          code: issued.code,
          computerId: crypto.randomUUID(),
          displayName: "mutated",
          platform: "darwin",
          arch: "arm64",
          clientVersion: "9.9.9",
        }),
      ).rejects.toMatchObject({ code: "AUTH_INVALID_CODE", statusCode: 401 });

      expect(await value.database.select().from(workspaceComputers)).toEqual(before.enrollments);
      expect(await value.database.select().from(accountComputers)).toEqual(before.accountComputers);
      expect(await value.database.select().from(workspaceComputerCredentials)).toEqual(before.legacyCredentials);
      expect(await value.database.select().from(computerCredentials)).toEqual(before.targetCredentials);
      expect(await value.database.select().from(computerConnectCodes)).toEqual(before.codes);
      expect(before.codes.filter((row) => row.consumedAt === null)).toHaveLength(1);
      expect(before.accountComputers[0]).toMatchObject({
        ownerAccountId: otherUser.id,
        currentInstallationId: computerId,
      });
    } finally {
      await value.sql.end();
    }
  });

  it("rejects an old WebSocket credential rotated after authentication but before registration", async () => {
    const value = await fixture();
    const computerId = crypto.randomUUID();
    const first = await enroll(value, value.bootstrap.userId, computerId);
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
      const rotated = await repair(value, first.workspaceComputerId, value.bootstrap.userId, rotatedInstallationId);
      const oldClose = closeCode(oldSocket);
      oldSocket.send(JSON.stringify(webSocketRegisterFrame(computerId, crypto.randomUUID())));
      expect(await oldFrames.next()).toMatchObject({ type: "error", code: "COMPUTER_NOT_REGISTERED" });
      await expect(oldClose).resolves.toBe(4409);
      expect(value.registry.currentInstanceId(first.workspaceComputerId)).toBeUndefined();
      const [afterOldRegistration] = await value.database
        .select({ currentInstanceId: workspaceComputers.currentInstanceId })
        .from(workspaceComputers)
        .where(eq(workspaceComputers.id, first.workspaceComputerId));
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
      expect(value.registry.currentInstanceId(first.workspaceComputerId)).toBe(newInstanceId);
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
        computerId: crypto.randomUUID(),
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
      const computerId = crypto.randomUUID();
      const app = createApp({
        authService: value.auth,
        computerConnectCode: { environment: "staging", publicUrl: "https://dev.example.com" },
        computerService: value.service,
        machineAuthService: value.machineAuth,
      });
      try {
        const response = await app.inject({
          method: "POST",
          url: HTTP_PATHS.computerConnectExchange,
          payload: {
            code: issued.code,
            computerId,
            displayName: "workstation",
            platform: "linux",
            arch: "x64",
            clientVersion: "0.0.2",
          },
        });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({
          computerId,
          machineToken: expect.stringMatching(/^otmc_/),
        });
        expect(response.json()).not.toHaveProperty("workspaceId");
      } finally {
        await app.close();
      }
    } finally {
      await value.sql.end();
    }
  });

  it("issues connect codes only through the Account-native route", async () => {
    const value = await fixture();
    try {
      const account = await value.auth.exchangeConnectCode(value.bootstrap.connectCode);
      const app = createApp({
        authService: value.auth,
        computerConnectCode: { environment: "staging", publicUrl: "https://dev.example.com" },
        computerService: value.service,
        machineAuthService: value.machineAuth,
      });
      try {
        const retired = await app.inject({
          method: "POST",
          url: workspaceComputerConnectCodesPath(value.bootstrap.workspaceId),
          headers: { authorization: `Bearer ${account.accessToken}` },
        });
        expect(retired.statusCode).toBe(404);
        const issued = await app.inject({
          method: "POST",
          url: HTTP_PATHS.accountComputerConnectCodes,
          headers: { authorization: `Bearer ${account.accessToken}` },
        });
        expect(issued.statusCode).toBe(201);
        expect(issued.headers["cache-control"]).toBe("no-store");
        const command = issued.json().bootstrapCommand as string;
        expect(command).toContain("opentag-staging computer connect --server https://dev.example.com -- otcc_");
        const code = command.split(" -- ").at(-1);
        if (!code) throw new Error("Computer connect command did not contain a code");

        const exchanged = await app.inject({
          method: "POST",
          url: HTTP_PATHS.computerConnectExchange,
          payload: {
            code,
            computerId: crypto.randomUUID(),
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
      const enrollment = await enroll(value);
      await value.service.register(enrollment, registerFrame(enrollment.computerId, crypto.randomUUID()));
      const account = await value.auth.exchangeConnectCode(value.bootstrap.connectCode);
      const app = createApp({
        authService: value.auth,
        computerConnectCode: { environment: "staging", publicUrl: "https://dev.example.com" },
        computerService: value.service,
        machineAuthService: value.machineAuth,
      });
      try {
        const denied = await app.inject({
          method: "GET",
          url: HTTP_PATHS.accountComputers,
          headers: { authorization: `Bearer ${enrollment.machineToken}` },
        });
        expect(denied.statusCode).toBe(401);

        const codeDenied = await app.inject({
          method: "POST",
          url: HTTP_PATHS.accountComputerConnectCodes,
          headers: { authorization: `Bearer ${enrollment.machineToken}` },
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
              computerId: enrollment.workspaceComputerId,
              connectionStatus: "online",
            },
          ],
        });
        expect(WorkspaceComputerSummarySchema.parse(response.json().computers[0])).not.toHaveProperty(
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
