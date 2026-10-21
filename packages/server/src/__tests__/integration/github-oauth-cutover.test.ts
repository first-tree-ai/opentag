import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabaseClient } from "../../db/client.js";
import { GitHubConnectionRecheckStore } from "../../services/github/github-recheck-store.js";
import { GitHubCredentialRefreshStore } from "../../services/github/github-refresh-store.js";
import { newOAuthFlowContext } from "../../services/github/oauth-flow.js";
import { startPostgresTestContainer } from "./postgres-test-container.js";

const migrations = readMigrationFiles({
  migrationsFolder: fileURLToPath(new URL("../../../drizzle", import.meta.url)),
});
const journal: { entries: Array<{ tag: string }> } = JSON.parse(
  await readFile(new URL("../../../drizzle/meta/_journal.json", import.meta.url), "utf8"),
);
const cutoverIndex = journal.entries.findIndex((entry) => entry.tag === "0065_github_oauth_cutover");
const cutoverMigration = migrations[cutoverIndex];
if (!cutoverMigration) throw new Error("OAuth cutover migration is missing");
let container: Awaited<ReturnType<typeof startPostgresTestContainer>>;
let sql: ReturnType<typeof postgres>;
let client: ReturnType<typeof createDatabaseClient>;
let accountId: string;
const clientId = "Ov23isolatedvalidation";
beforeAll(async () => {
  container = await startPostgresTestContainer();
  sql = postgres(container.getConnectionUri(), { max: 1, onnotice: () => undefined });
  client = createDatabaseClient(container.getConnectionUri());
  for (const migration of migrations.slice(0, cutoverIndex))
    await sql.begin(async (tx) => {
      for (const statement of migration.sql) await tx.unsafe(statement);
    });
  const [account] =
    await sql`insert into users(email,display_name) values ('oauth-cutover@example.invalid','Local migration fixture') returning id`;
  accountId = account?.id;
  await seedLegacyConnections();
}, 120000);
async function seedLegacyConnections() {
  for (const [index, status] of ["pending", "active", "reauthorization_required", "revoked", "superseded"].entries()) {
    const active = status === "active";
    const identity = status !== "pending";
    await sql`insert into github_connections(account_id,github_host,app_id,status,github_user_id,github_login,credential_ciphertext,credential_key_id,access_expires_at,refresh_expires_at,next_recheck_at,repository_bindings,authorization_version,recheck_generation)
   values (${accountId},'github.com',${String(100 + index)},${status},${identity ? "42" : null},${identity ? "fixture-user" : null},${active ? "synthetic-encrypted-old-secret" : null},${active ? "fixture-key" : null},${active ? new Date(Date.now() + 3600000) : null},${active ? new Date(Date.now() + 86400000) : null},${active ? new Date() : null},'[{"historical":true}]',7,3)`;
  }
  const context = newOAuthFlowContext({
    intent: "create",
    loginSessionHash: "a".repeat(64),
    returnSurface: "account-integrations",
    expiresAt: new Date(Date.now() + 600000),
  });
  await sql`update github_connections set oauth_state_hash=${"b".repeat(64)}, oauth_context=${sql.json(context)}, oauth_context_ciphertext='synthetic-pkce', oauth_context_key_id='fixture-key' where app_id='100'`;
  await sql`update github_connections set refresh_attempt_id=${crypto.randomUUID()}, refresh_claim_until=now()+interval '1 minute', refresh_status='claimed', recheck_required=true where app_id='101'`;
}

afterAll(async () => {
  await client?.sql.end();
  await sql?.end();
  await container?.stop();
});

describe("one-time OAuth migration on isolated PostgreSQL", () => {
  it("rolls back DDL and invalidation together on a pre-commit failure", async () => {
    const before = await sql`select * from github_connections order by app_id`;
    await expect(
      sql.begin(async (tx) => {
        for (const statement of cutoverMigration.sql) await tx.unsafe(statement);
        throw new Error("simulate deployment interruption");
      }),
    ).rejects.toThrow("simulate deployment interruption");
    expect(await sql`select * from github_connections order by app_id`).toEqual(before);
    expect(
      await sql`select column_name from information_schema.columns where table_name='github_connections' and column_name='oauth_client_id'`,
    ).toHaveLength(0);
  });
  it("retains history, clears old credentials and rejects resurrection after commit", async () => {
    const before = await sql`select * from github_connections order by app_id`;
    await sql.begin(async (tx) => {
      for (const statement of cutoverMigration.sql) await tx.unsafe(statement);
    });
    const after = await sql`select * from github_connections order by app_id`;
    expect(after).toHaveLength(before.length);
    for (let i = 0; i < after.length; i++) {
      expect(after[i]).toMatchObject({
        id: before[i]?.id,
        account_id: accountId,
        app_id: before[i]?.app_id,
        oauth_client_id: null,
        github_user_id: before[i]?.github_user_id,
        repository_bindings: before[i]?.repository_bindings,
        credential_ciphertext: null,
        credential_key_id: null,
        access_expires_at: null,
        refresh_expires_at: null,
        oauth_context: null,
        oauth_state_hash: null,
        oauth_context_ciphertext: null,
        oauth_context_key_id: null,
        refresh_attempt_id: null,
        refresh_claim_until: null,
        refresh_status: "idle",
        next_recheck_at: null,
      });
      if (i < 3)
        expect(after[i]).toMatchObject({
          status: "revoked",
          authorization_version: "8",
          recheck_generation: "4",
          last_error_code: "GITHUB_OAUTH_RECONNECT_REQUIRED",
        });
      else expect(after[i]).toEqual({ ...before[i], oauth_client_id: null });
    }
    await expect(sql`update github_connections set status='pending' where app_id='100'`).rejects.toMatchObject({
      code: "23514",
    });
    await expect(
      sql`insert into github_connections(account_id,github_host,app_id) values(${accountId},'github.com','999')`,
    ).rejects.toMatchObject({ code: "23514" });
  });
  it.each([null, "", " "])("rejects an OAuth row with invalid client ID %s", async (oauthClientId) => {
    await expect(
      sql`insert into github_connections(account_id,github_host,oauth_client_id,status) values(${accountId},'github.com',${oauthClientId},'revoked')`,
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("admits one new OAuth row and isolates it from legacy App selectors and worker claims", async () => {
    const [oauth] =
      await sql`insert into github_connections(account_id,github_host,oauth_client_id,status,github_user_id,github_login,credential_ciphertext,credential_key_id,access_expires_at,refresh_expires_at,next_recheck_at)
   values(${accountId},'github.com',${clientId},'active','42','fixture-user','new-synthetic-secret','new-key',now()+interval '1 hour',now()+interval '1 day',now()) returning *`;
    const revoked =
      await sql`update github_connections set status='revoked' where app_id='101' and status='active' returning id`;
    expect(revoked).toHaveLength(0);
    expect((await sql`select * from github_connections where id=${oauth?.id}`)[0]).toEqual(oauth);
    const oldIds = await sql`select id from github_connections where app_id is not null`;
    const refresh = new GitHubCredentialRefreshStore(client.database, { oauthClientId: clientId });
    const recheck = new GitHubConnectionRecheckStore(client.database, { oauthClientId: clientId });
    for (const old of oldIds) expect((await refresh.claimRefresh(old.id)).claimed).toBe(false);
    expect((await recheck.listDueForRecheck({ limit: 10 })).map((row) => row.connectionId)).toEqual([oauth?.id]);
    expect(
      await new GitHubConnectionRecheckStore(client.database, { oauthClientId: "another-client" }).listDueForRecheck({
        limit: 10,
      }),
    ).toEqual([]);
    await expect(
      sql`insert into github_connections(account_id,github_host,oauth_client_id) values(${accountId},'github.com','different-client')`,
    ).rejects.toMatchObject({ code: "23505" });
    await expect(
      sql`insert into github_connections(account_id,github_host,app_id,oauth_client_id,status) values(${accountId},'github.com','111','wrong-shape','revoked')`,
    ).rejects.toMatchObject({ code: "23514" });
  });
});
