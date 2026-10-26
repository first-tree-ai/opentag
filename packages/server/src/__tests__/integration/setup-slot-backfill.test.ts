import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { inArray } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabaseClient } from "../../db/client.js";
import { migrateDatabase, verifyDatabaseMigrations } from "../../db/migrate.js";
import { agents, computers, imBindings, users } from "../../db/schema/index.js";
import { startPostgresTestContainer } from "./postgres-test-container.js";

/**
 * `0068_release_terminal_setup_slots` is a data migration: it must release the rows that previous
 * binaries left terminal-and-never-activated, and it must not touch a live connection. This suite
 * migrates to 0067, plants exactly those rows, migrates forward, and reads the outcome.
 */
const migrationsFolder = fileURLToPath(new URL("../../../drizzle", import.meta.url));
const THROUGH_0067_IDX = 67;
const CURRENT_MIGRATION_COUNT = 71;
const EARLY = new Date("2026-08-01T00:00:00.000Z");
const ACCOUNT = "00000000-0000-4000-8000-000000000201";
const COMPUTER = "00000000-0000-4000-8000-000000000202";

type Journal = {
  version: string;
  dialect: string;
  entries: Array<{ idx: number; version: string; when: number; tag: string; breakpoints: boolean }>;
};

let container: StartedPostgreSqlContainer;
let databaseUrl: string;

beforeAll(async () => {
  container = await startPostgresTestContainer();
  databaseUrl = container.getConnectionUri();
}, 120_000);

afterAll(async () => {
  await container.stop();
});

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

async function truncatedMigrations(lastIndex: number): Promise<string> {
  const journal = JSON.parse(await readFile(join(migrationsFolder, "meta/_journal.json"), "utf8")) as Journal;
  const folder = await mkdtemp(join(tmpdir(), `opentag-${lastIndex}-migrations-`));
  await mkdir(join(folder, "meta"));
  const entries = journal.entries.filter(({ idx }) => idx <= lastIndex);
  for (const entry of entries) {
    await copyFile(join(migrationsFolder, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
  }
  await writeFile(join(folder, "meta/_journal.json"), JSON.stringify({ ...journal, entries }, null, 2));
  return folder;
}

async function journalCount(sql: postgres.Sql): Promise<number> {
  const [row] = await sql<{ count: string }[]>`select count(*)::text as count from drizzle.__drizzle_migrations`;
  return Number(row?.count ?? 0);
}

describe("terminal setup slot backfill", () => {
  it("releases never-activated terminal rows and leaves live connections alone", async () => {
    const throughPrevious = await truncatedMigrations(THROUGH_0067_IDX);
    const client = createDatabaseClient(databaseUrl);
    const fixtures = {
      canceled: { binding: "00000000-0000-4000-8000-000000000301", agent: "00000000-0000-4000-8000-000000000401" },
      expired: { binding: "00000000-0000-4000-8000-000000000302", agent: "00000000-0000-4000-8000-000000000402" },
      failed: { binding: "00000000-0000-4000-8000-000000000303", agent: "00000000-0000-4000-8000-000000000403" },
      live: { binding: "00000000-0000-4000-8000-000000000304", agent: "00000000-0000-4000-8000-000000000404" },
      reauthorizationCanceled: {
        binding: "00000000-0000-4000-8000-000000000305",
        agent: "00000000-0000-4000-8000-000000000405",
      },
      inFlight: { binding: "00000000-0000-4000-8000-000000000306", agent: "00000000-0000-4000-8000-000000000406" },
    };
    const lease = new Date(EARLY.getTime() + 60_000);
    const terminalNeverActivated = (id: string, setupState: "canceled" | "expired" | "failed") => ({
      id,
      provider: "feishu" as const,
      status: "provisioning" as const,
      setupAttemptId: crypto.randomUUID(),
      setupIntent: "create" as const,
      setupState,
      setupOwnerInstanceId: crypto.randomUUID(),
      setupOwnerHeartbeatAt: EARLY,
      encryptedSetupContext: "legacy-context",
      setupExpiresAt: lease,
      connectionOwnerInstanceId: crypto.randomUUID(),
      connectionFencingEpoch: 1,
      connectionLeaseExpiresAt: lease,
      lastErrorCode: `FEISHU_SETUP_${setupState.toUpperCase()}`,
      createdAt: EARLY,
      updatedAt: EARLY,
    });
    const live = (id: string, appId: string, setupState: "succeeded" | "canceled") => ({
      id,
      provider: "feishu" as const,
      status: "active" as const,
      externalAppId: appId,
      externalTeamId: "tenant_live",
      externalBotId: `ou_${appId}`,
      credentialSchemaVersion: 1,
      credentialGeneration: 1,
      encryptedCredential: "live-credential",
      grantedCapabilities: ["im:message:send_as_bot"],
      setupAttemptId: crypto.randomUUID(),
      setupIntent: "reauthorize" as const,
      setupState,
      connectionOwnerInstanceId: crypto.randomUUID(),
      connectionFencingEpoch: 1,
      connectionLeaseExpiresAt: lease,
      observedConnectedAt: EARLY,
      observedAt: EARLY,
      activatedAt: EARLY,
      createdAt: EARLY,
      updatedAt: EARLY,
    });
    try {
      await migrateDatabase(databaseUrl, throughPrevious);
      await client.database
        .insert(users)
        .values({ id: ACCOUNT, email: "backfill@example.com", displayName: "Backfill" });
      await client.database.insert(computers).values({
        id: COMPUTER,
        ownerAccountId: ACCOUNT,
        currentInstallationId: crypto.randomUUID(),
        displayName: "backfill",
        platform: "linux",
        arch: "x64",
        clientVersion: "0.0.1",
      });
      await client.database.insert(agents).values(
        Object.entries(fixtures).map(([name, fixture]) => ({
          id: fixture.agent,
          createdByUserId: ACCOUNT,
          computerId: COMPUTER,
          name: `agent-${name.toLowerCase()}`,
          displayName: `Agent ${name}`,
          runtimeProvider: "codex" as const,
        })),
      );
      await client.database.insert(imBindings).values([
        { ...terminalNeverActivated(fixtures.canceled.binding, "canceled"), agentId: fixtures.canceled.agent },
        { ...terminalNeverActivated(fixtures.expired.binding, "expired"), agentId: fixtures.expired.agent },
        { ...terminalNeverActivated(fixtures.failed.binding, "failed"), agentId: fixtures.failed.agent },
        { ...live(fixtures.live.binding, "cli_live", "succeeded"), agentId: fixtures.live.agent },
        {
          ...live(fixtures.reauthorizationCanceled.binding, "cli_reauth", "canceled"),
          lastErrorCode: "FEISHU_SETUP_CANCELED",
          agentId: fixtures.reauthorizationCanceled.agent,
        },
        {
          ...terminalNeverActivated(fixtures.inFlight.binding, "canceled"),
          setupState: "awaiting_user" as const,
          lastErrorCode: null,
          agentId: fixtures.inFlight.agent,
        },
      ]);

      // The upgrade under test.
      await migrateDatabase(databaseUrl, migrationsFolder);

      const migrated = await client.database
        .select()
        .from(imBindings)
        .where(
          inArray(
            imBindings.id,
            Object.values(fixtures).map((fixture) => fixture.binding),
          ),
        );
      const byId = new Map(migrated.map((row) => [row.id, row]));
      for (const state of ["canceled", "expired", "failed"] as const) {
        const row = byId.get(fixtures[state].binding);
        // Released: no longer current, and every field a second attempt or a connection could use is gone.
        expect(row).toMatchObject({
          status: "disabled",
          setupState: state,
          encryptedSetupContext: null,
          setupOwnerInstanceId: null,
          setupOwnerHeartbeatAt: null,
          setupExpiresAt: null,
          connectionOwnerInstanceId: null,
          connectionLeaseExpiresAt: null,
          credentialGeneration: 0,
        });
        expect(row?.disabledAt).not.toBeNull();
        expect(row?.setupAttemptId).not.toBeNull();
        expect(row?.updatedAt.getTime()).toBeGreaterThan(EARLY.getTime());
      }

      // A working connection is a connection: the fence must leave it entirely alone.
      expect(byId.get(fixtures.live.binding)).toMatchObject({
        status: "active",
        setupState: "succeeded",
        disabledAt: null,
        encryptedCredential: "live-credential",
        credentialGeneration: 1,
        activatedAt: EARLY,
      });
      // A canceled reauthorization keeps the working connection, its secret and its lease.
      const reauthorizationCanceled = byId.get(fixtures.reauthorizationCanceled.binding);
      expect(reauthorizationCanceled).toMatchObject({
        status: "active",
        setupState: "canceled",
        disabledAt: null,
        encryptedCredential: "live-credential",
        credentialGeneration: 1,
        setupOwnerInstanceId: null,
      });
      expect(reauthorizationCanceled?.connectionOwnerInstanceId).not.toBeNull();
      expect(reauthorizationCanceled?.connectionLeaseExpiresAt).toEqual(lease);
      // An attempt still in flight is current and keeps its context.
      expect(byId.get(fixtures.inFlight.binding)).toMatchObject({
        status: "provisioning",
        setupState: "awaiting_user",
        disabledAt: null,
        encryptedSetupContext: "legacy-context",
      });
      expect(byId.get(fixtures.inFlight.binding)?.setupOwnerInstanceId).not.toBeNull();

      const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
      try {
        expect(await journalCount(sql)).toBe(CURRENT_MIGRATION_COUNT);
      } finally {
        await sql.end();
      }
      await verifyDatabaseMigrations(databaseUrl, migrationsFolder);
    } finally {
      await client.sql.end();
      await rm(throughPrevious, { recursive: true, force: true });
    }
  });
});
