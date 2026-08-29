import {
  HTTP_PATHS,
  PROVIDER_READINESS_V1_HEADER,
  RUNTIME_PROTOCOL_V2,
  WorkspaceComputerSummarySchema,
  workspaceComputerConnectCodesPath,
  workspaceComputersPath,
} from "@opentag/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { bootstrapInitialAdmin } from "../../admin/bootstrap.js";
import { createApp } from "../../app.js";
import { createBetterAuth } from "../../auth/better-auth.js";
import { BetterAuthSessionTokens } from "../../auth/session-tokens.js";
import { createDatabaseClient } from "../../db/client.js";
import { computers, workspaceAdminGrants, workspaceComputers, workspaces } from "../../db/schema/index.js";
import { ConnectionRegistry } from "../../runtime/connection-registry.js";
import { AuthService } from "../../services/auth/index.js";
import { ComputerService, MachineAuthService } from "../../services/computers/index.js";
import { WorkspaceAdminAccess } from "../../services/workspace-admin-access/index.js";
import { WorkspaceAdminService } from "../../services/workspaces/index.js";
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
  const workspaceService = new WorkspaceAdminService(client.database);
  return { ...client, auth, bootstrap, machineAuth, registry, service, workspaceService };
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
    clientVersion: "0.0.1",
    capabilities: { imCredentialGrant: 0 as const },
    protocolVersion: RUNTIME_PROTOCOL_V2,
    supportedCapabilities: { imCredentialGrant: { min: 1, max: 1 } },
    requiredServerCapabilities: [],
  };
}

async function enroll(
  value: Awaited<ReturnType<typeof fixture>>,
  workspaceId = value.bootstrap.workspaceId,
  accountId = value.bootstrap.userId,
  computerId = crypto.randomUUID(),
) {
  const issued = await value.machineAuth.issueForWorkspaceAdmin(accountId, workspaceId);
  return value.machineAuth.exchangeConnectCode({
    code: issued.code,
    computerId,
    displayName: "workstation",
    platform: "linux",
    arch: "x64",
    clientVersion: "0.0.1",
  });
}

describe("Computer enrollment persistence", () => {
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
    } finally {
      await value.sql.end();
    }
  });

  it("isolates two Workspace enrollments for the same physical Computer", async () => {
    const value = await fixture();
    try {
      const [secondWorkspace] = await value.database
        .insert(workspaces)
        .values({ name: "second", displayName: "Second" })
        .returning();
      if (!secondWorkspace) throw new Error("Second Workspace was not created");
      await value.database.insert(workspaceAdminGrants).values({
        workspaceId: secondWorkspace.id,
        userId: value.bootstrap.userId,
        grantedByUserId: value.bootstrap.userId,
      });
      const computerId = crypto.randomUUID();
      const first = await enroll(value, value.bootstrap.workspaceId, value.bootstrap.userId, computerId);
      const second = await enroll(value, secondWorkspace.id, value.bootstrap.userId, computerId);
      expect(second.workspaceComputerId).not.toBe(first.workspaceComputerId);
      expect(second.machineToken).not.toBe(first.machineToken);

      const firstInstance = crypto.randomUUID();
      const secondInstance = crypto.randomUUID();
      await value.service.register(first, registerFrame(computerId, firstInstance));
      await value.service.register(second, registerFrame(computerId, secondInstance));
      expect(await value.service.heartbeat(first, firstInstance)).toBe(true);
      expect(await value.service.heartbeat(second, secondInstance)).toBe(true);

      const rows = await value.database
        .select()
        .from(workspaceComputers)
        .where(eq(workspaceComputers.computerId, computerId));
      expect(rows).toHaveLength(2);
      expect(rows.map(({ currentInstanceId }) => currentInstanceId).sort()).toEqual(
        [firstInstance, secondInstance].sort(),
      );
    } finally {
      await value.sql.end();
    }
  });

  it("rotates the enrollment credential and rejects Account tokens as machine authority", async () => {
    const value = await fixture();
    try {
      const computerId = crypto.randomUUID();
      const first = await enroll(value, value.bootstrap.workspaceId, value.bootstrap.userId, computerId);
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

      const rotated = await enroll(value, value.bootstrap.workspaceId, value.bootstrap.userId, computerId);
      expect(rotated.workspaceComputerId).toBe(first.workspaceComputerId);
      await expect(value.machineAuth.verifyMachineToken(first.machineToken)).rejects.toMatchObject({
        code: "AUTH_INVALID_TOKEN",
      });
      await expect(value.machineAuth.verifyMachineToken(rotated.machineToken)).resolves.toMatchObject({
        workspaceComputerId: first.workspaceComputerId,
      });
    } finally {
      await value.sql.end();
    }
  });

  it("rejects an old WebSocket credential rotated after authentication but before registration", async () => {
    const value = await fixture();
    const computerId = crypto.randomUUID();
    const first = await enroll(value, value.bootstrap.workspaceId, value.bootstrap.userId, computerId);
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

      const rotated = await enroll(value, value.bootstrap.workspaceId, value.bootstrap.userId, computerId);
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
      newSocket.send(JSON.stringify(webSocketRegisterFrame(computerId, newInstanceId)));
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
      const issued = await value.machineAuth.issueForWorkspaceAdmin(
        value.bootstrap.userId,
        value.bootstrap.workspaceId,
      );
      const input = {
        code: issued.code,
        computerId: crypto.randomUUID(),
        displayName: "workstation",
        platform: "linux" as const,
        arch: "x64",
        clientVersion: "0.0.1",
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

  it("preserves infrastructure failures while concealing missing or revoked Workspace authority", async () => {
    const value = await fixture();
    try {
      const workspaceAdmins = new WorkspaceAdminAccess(value.database);
      const machineAuth = new MachineAuthService(value.database, { workspaceAdmins });
      const input = {
        computerId: crypto.randomUUID(),
        displayName: "workstation",
        platform: "linux" as const,
        arch: "x64",
        clientVersion: "0.0.1",
      };

      const lockFailure = new Error("workspace lock connection lost");
      const first = await machineAuth.issueForWorkspaceAdmin(value.bootstrap.userId, value.bootstrap.workspaceId);
      vi.spyOn(workspaceAdmins, "lockWorkspace").mockRejectedValueOnce(lockFailure);
      await expect(machineAuth.exchangeConnectCode({ ...input, code: first.code })).rejects.toBe(lockFailure);

      const authorityFailure = new Error("authority query connection lost");
      const second = await machineAuth.issueForWorkspaceAdmin(value.bootstrap.userId, value.bootstrap.workspaceId);
      vi.spyOn(workspaceAdmins, "requireAdmin").mockRejectedValueOnce(authorityFailure);
      await expect(machineAuth.exchangeConnectCode({ ...input, code: second.code })).rejects.toBe(authorityFailure);

      const third = await machineAuth.issueForWorkspaceAdmin(value.bootstrap.userId, value.bootstrap.workspaceId);
      await value.database
        .update(workspaceAdminGrants)
        .set({ revokedByUserId: value.bootstrap.userId, revokedAt: new Date() })
        .where(eq(workspaceAdminGrants.userId, value.bootstrap.userId));
      await expect(machineAuth.exchangeConnectCode({ ...input, code: third.code })).rejects.toMatchObject({
        code: "AUTH_INVALID_CODE",
        statusCode: 401,
      });
    } finally {
      vi.restoreAllMocks();
      await value.sql.end();
    }
  });

  it("exchanges a Computer connect code through the public machine route", async () => {
    const value = await fixture();
    try {
      const issued = await value.machineAuth.issueForWorkspaceAdmin(
        value.bootstrap.userId,
        value.bootstrap.workspaceId,
      );
      const computerId = crypto.randomUUID();
      const app = createApp({
        authService: value.auth,
        computerConnectCode: { environment: "staging", publicUrl: "https://dev.example.com" },
        computerService: value.service,
        machineAuthService: value.machineAuth,
        workspaceService: value.workspaceService,
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
            clientVersion: "0.0.1",
          },
        });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({
          workspaceId: value.bootstrap.workspaceId,
          computerId,
          machineToken: expect.stringMatching(/^otmc_/),
        });
      } finally {
        await app.close();
      }
    } finally {
      await value.sql.end();
    }
  });

  it("issues Account and machine connect codes through distinct real routes", async () => {
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
        const issued = await app.inject({
          method: "POST",
          url: workspaceComputerConnectCodesPath(value.bootstrap.workspaceId),
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
            clientVersion: "0.0.1",
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

  it("rejects machine credentials on a real management route and lists enrollments for Account auth", async () => {
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
        workspaceService: value.workspaceService,
      });
      try {
        const denied = await app.inject({
          method: "GET",
          url: workspaceComputersPath(value.bootstrap.workspaceId),
          headers: { authorization: `Bearer ${enrollment.machineToken}` },
        });
        expect(denied.statusCode).toBe(401);

        const codeDenied = await app.inject({
          method: "POST",
          url: workspaceComputerConnectCodesPath(value.bootstrap.workspaceId),
          headers: { authorization: `Bearer ${enrollment.machineToken}` },
        });
        expect(codeDenied.statusCode).toBe(401);

        const response = await app.inject({
          method: "GET",
          url: workspaceComputersPath(value.bootstrap.workspaceId),
          headers: { authorization: `Bearer ${account.accessToken}` },
        });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({
          computers: [
            {
              computerId: enrollment.computerId,
              connectionStatus: "online",
            },
          ],
        });
        expect(WorkspaceComputerSummarySchema.parse(response.json().computers[0])).not.toHaveProperty(
          "providerReadiness",
        );

        const negotiated = await app.inject({
          method: "GET",
          url: workspaceComputersPath(value.bootstrap.workspaceId),
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
