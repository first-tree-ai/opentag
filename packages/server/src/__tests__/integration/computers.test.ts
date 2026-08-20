import { fileURLToPath } from "node:url";
import { ComputerSchema, HTTP_PATHS, PROVIDER_READINESS_V1_HEADER } from "@opentag/shared";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootstrapInitialAdmin } from "../../admin/bootstrap.js";
import { createApp } from "../../app.js";
import { createDatabaseClient } from "../../db/client.js";
import { migrateDatabase } from "../../db/migrate.js";
import { computers, memberships, teams, users } from "../../db/schema/index.js";
import { AuthService, AuthTokenService } from "../../services/auth/index.js";
import { ComputerService } from "../../services/computers/index.js";

const migrationsFolder = fileURLToPath(new URL("../../../drizzle", import.meta.url));
const jwtSecret = "im-binding-test-secret-at-least-32-characters";
let container: StartedPostgreSqlContainer;
let databaseUrl: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:17-alpine").start();
  databaseUrl = container.getConnectionUri();
}, 120_000);

afterAll(async () => container.stop());

beforeEach(async () => {
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
  try {
    await sql.unsafe("drop schema if exists public cascade");
    await sql.unsafe("drop schema if exists drizzle cascade");
    await sql.unsafe("create schema public");
  } finally {
    await sql.end();
  }
});

async function fixture() {
  await migrateDatabase(databaseUrl, migrationsFolder);
  const client = createDatabaseClient(databaseUrl);
  const bootstrap = await bootstrapInitialAdmin(client.database, {
    displayName: "Admin",
    email: "admin@example.com",
    teamDisplayName: "Example",
    teamName: "example",
  });
  const tokens = new AuthTokenService(jwtSecret, 900, 3600);
  const auth = new AuthService(client.database, tokens);
  const service = new ComputerService(client.database, auth, { presenceTimeoutMs: 90_000 });
  return { ...client, auth, bootstrap, service };
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
    capabilities: { imMessageTool: 0 as const },
  };
}

describe("Computer persistence", () => {
  it("registers one stable Computer and fences an older instance", async () => {
    const value = await fixture();
    const computerId = crypto.randomUUID();
    const first = crypto.randomUUID();
    const second = crypto.randomUUID();
    try {
      await value.service.register(value.bootstrap.userId, registerFrame(computerId, first));
      await value.service.register(value.bootstrap.userId, registerFrame(computerId, second));
      expect(await value.service.heartbeat(value.bootstrap.userId, computerId, first)).toBe(false);
      expect(await value.service.disconnect(computerId, first)).toBe(false);
      expect(await value.service.heartbeat(value.bootstrap.userId, computerId, second)).toBe(true);
      expect(await value.database.select().from(computers)).toHaveLength(1);
    } finally {
      await value.sql.end();
    }
  });

  it("rejects cross-user Computer takeover", async () => {
    const value = await fixture();
    const computerId = crypto.randomUUID();
    try {
      await value.service.register(value.bootstrap.userId, registerFrame(computerId, crypto.randomUUID()));
      const [secondUser] = await value.database
        .insert(users)
        .values({ email: "second@example.com", displayName: "Second" })
        .returning();
      if (!secondUser) throw new Error("Second user was not created");
      await value.database.insert(memberships).values({
        teamId: value.bootstrap.teamId,
        userId: secondUser.id,
        role: "member",
      });
      await expect(
        value.service.register(secondUser.id, registerFrame(computerId, crypto.randomUUID())),
      ).rejects.toMatchObject({
        code: "COMPUTER_IDENTITY_CONFLICT",
      });
      const [stored] = await value.database.select().from(computers).where(eq(computers.id, computerId));
      expect(stored?.ownerUserId).toBe(value.bootstrap.userId);
    } finally {
      await value.sql.end();
    }
  });

  it("lists only the authenticated user's Computers through /api/v1/me/computers", async () => {
    const value = await fixture();
    const computerId = crypto.randomUUID();
    try {
      await value.service.register(value.bootstrap.userId, registerFrame(computerId, crypto.randomUUID()));
      const credentials = await value.auth.exchangeConnectCode(value.bootstrap.connectCode);
      const app = createApp({ authService: value.auth, computerService: value.service });
      try {
        const response = await app.inject({
          method: "GET",
          url: HTTP_PATHS.meComputers,
          headers: { authorization: `Bearer ${credentials.accessToken}` },
        });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({
          computers: [{ id: computerId, ownerUserId: value.bootstrap.userId, connectionStatus: "online" }],
        });
        const legacyComputer = ComputerSchema.omit({ providerReadiness: true }).strict();
        expect(legacyComputer.parse(response.json().computers[0])).not.toHaveProperty("providerReadiness");

        const negotiated = await app.inject({
          method: "GET",
          url: HTTP_PATHS.meComputers,
          headers: {
            authorization: `Bearer ${credentials.accessToken}`,
            [PROVIDER_READINESS_V1_HEADER]: "1",
          },
        });
        expect(negotiated.json().computers[0]).toMatchObject({
          providerReadiness: [{ provider: "codex", status: "checking", observedAt: null }],
        });
      } finally {
        await app.close();
      }
    } finally {
      await value.sql.end();
    }
  });

  it("rejects heartbeat after the user loses every active membership", async () => {
    const value = await fixture();
    const computerId = crypto.randomUUID();
    const instanceId = crypto.randomUUID();
    try {
      await value.service.register(value.bootstrap.userId, registerFrame(computerId, instanceId));
      await value.database
        .update(memberships)
        .set({ status: "left", updatedAt: new Date() })
        .where(eq(memberships.userId, value.bootstrap.userId));
      await expect(value.service.heartbeat(value.bootstrap.userId, computerId, instanceId)).rejects.toMatchObject({
        code: "AUTH_MEMBERSHIP_REQUIRED",
      });
    } finally {
      await value.sql.end();
    }
  });

  it("keeps one user-owned Computer active when one of multiple Team memberships ends", async () => {
    const value = await fixture();
    const computerId = crypto.randomUUID();
    const instanceId = crypto.randomUUID();
    try {
      const [secondTeam] = await value.database
        .insert(teams)
        .values({ name: "second", displayName: "Second" })
        .returning();
      if (!secondTeam) throw new Error("Second Team was not created");
      await value.database.insert(memberships).values({
        teamId: secondTeam.id,
        userId: value.bootstrap.userId,
        role: "member",
      });
      await value.service.register(value.bootstrap.userId, registerFrame(computerId, instanceId));
      await value.database
        .update(memberships)
        .set({ status: "left", updatedAt: new Date() })
        .where(eq(memberships.teamId, value.bootstrap.teamId));

      await expect(value.service.heartbeat(value.bootstrap.userId, computerId, instanceId)).resolves.toBe(true);
      expect(await value.database.select().from(computers)).toHaveLength(1);
    } finally {
      await value.sql.end();
    }
  });
});
