import { createHash, randomUUID } from "node:crypto";
import {
  AGENT_SKILL_BUNDLE_TEMPLATE,
  AGENT_SKILL_TEMPLATE,
  AGENT_SKILLS_INSTALL_RESOLVE_TEMPLATE,
  AGENT_SKILLS_INSTALL_TEMPLATE,
  AGENT_SKILLS_TEMPLATE,
  COMPUTER_AGENT_SKILLS_TEMPLATE,
  ListAgentSkillsResponseSchema,
  SKILL_FORMAT_HEADER,
  SKILL_SHA256_HEADER,
  SKILL_UPLOAD_CONTENT_TYPE,
  SkillDetailSchema,
} from "@opentag/shared";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootstrapInitialAdmin } from "../../admin/bootstrap.js";
import { createApp } from "../../app.js";
import { createDatabaseClient, type DatabaseClient } from "../../db/client.js";
import { AgentService } from "../../services/agents/index.js";
import type { UserAuthService } from "../../services/auth/index.js";
import { MachineAuthService } from "../../services/computers/index.js";
import { SkillService } from "../../services/skills/index.js";
import { RemoteSkillService } from "../../services/skills/source/remote-skill-service.js";
import { SkillSourceFetcher } from "../../services/skills/source/source-fetcher.js";
import { FakeSkillObjectStore } from "../support/fake-skill-object-store.js";
import { skillManifest, tarGz } from "../support/skill-archive-fixtures.js";
import { staticTransport } from "../support/skill-source-fixtures.js";
import { type MigratedTestDatabase, startMigratedTestDatabase } from "./migrated-test-database.js";

/**
 * The Skill surfaces exercised over real HTTP against a real PostgreSQL and an in-memory object
 * store. The unit suites prove the domain rules and the transport guards; this suite proves the
 * database constraints the service depends on and the wire contract a client actually sees.
 */

let testDatabase: MigratedTestDatabase;
let databaseUrl: string;

beforeAll(async () => {
  testDatabase = await startMigratedTestDatabase();
  databaseUrl = testDatabase.databaseUrl;
}, 120_000);
afterAll(async () => testDatabase.stop());
beforeEach(async () => testDatabase.reset());

const openPools: { end: () => Promise<unknown> }[] = [];
const openApps: { close: () => Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
  await Promise.all(openPools.splice(0).map((pool) => pool.end()));
});

interface Harness {
  accountId: string;
  agentId: string;
  computerId: string;
  machineToken: string;
  app: ReturnType<typeof createApp>;
  database: DatabaseClient;
  sql: ReturnType<typeof createDatabaseClient>["sql"];
  store: FakeSkillObjectStore;
}

async function boot(): Promise<Harness> {
  const client = createDatabaseClient(databaseUrl);
  openPools.push(client.sql);
  const bootstrap = await bootstrapInitialAdmin(client.database, {
    displayName: "Skill Tester",
    email: `skills-api-${randomUUID()}@company.example`,
  });
  const accountId = bootstrap.userId;

  const agentService = new AgentService(client.database);
  const machineAuth = new MachineAuthService(client.database);
  const issued = await machineAuth.issueForAccount(accountId, {});
  const exchange = await machineAuth.exchangeConnectCode({
    code: issued.code,
    installationId: randomUUID(),
    displayName: "skills-workstation",
    platform: "linux",
    arch: "x64",
    clientVersion: "0.0.2",
  });
  const agent = await agentService.createForAccount(accountId, {
    computerId: exchange.computerId,
    displayName: "Skill Agent",
    name: "skill-agent",
    runtimeProvider: "codex",
  });

  const store = new FakeSkillObjectStore();
  const service = new SkillService({ database: client.database, store, keyPrefix: "skills" });
  const authService = {
    getAuthenticatedUser: async () => ({
      tokenExpiresAt: new Date("2030-01-01T00:00:00.000Z"),
      me: { user: { id: accountId } },
    }),
    getActiveUserById: async () => ({ me: { user: { id: accountId } } }),
  } as unknown as UserAuthService;

  // The remote-install routes are exercised with a local stub: an integration test may not depend on
  // the public network, and the transport under test here is HTTP plus PostgreSQL, not git.
  const remote = new RemoteSkillService({ skills: service, fetcher: await remoteSkillFetcher() });
  const app = createApp({
    authService,
    machineAuthService: machineAuth,
    skills: { service, remote },
  });
  openApps.push(app);
  return {
    accountId,
    agentId: agent.id,
    computerId: exchange.computerId,
    machineToken: exchange.machineToken,
    app,
    database: client.database,
    sql: client.sql,
    store,
  };
}

const AUTH = { authorization: "Bearer account-token" };

const DISCOVERY_SCHEMA_V2 = "https://schemas.agentskills.io/discovery/0.2.0/schema.json";

/** A well-known host publishing two Skills from archive artifacts, all in process. */
async function remoteSkillFetcher(): Promise<SkillSourceFetcher> {
  const routes = new Map<string, () => { status: number; body?: Uint8Array | string }>();
  const entries: Record<string, unknown>[] = [];
  for (const name of ["demo", "other"]) {
    const artifact = await tarGz([{ name: "SKILL.md", body: skillManifest(name) }]);
    const url = `https://skills.example.test/artifacts/${name}.tar.gz`;
    routes.set(url, () => ({ status: 200, body: artifact }));
    entries.push({
      name,
      description: `${name} Skill`,
      type: "archive",
      url,
      digest: sha256(artifact),
    });
  }
  routes.set("https://skills.example.test/.well-known/agent-skills/index.json", () => ({
    status: 200,
    body: JSON.stringify({ $schema: DISCOVERY_SCHEMA_V2, skills: entries }),
  }));
  return new SkillSourceFetcher({
    allowLoopback: false,
    resolveAddresses: async () => ["93.184.216.34"],
    transport: staticTransport(Object.fromEntries([...routes.entries()].map(([url, respond]) => [url, respond]))),
  });
}

const REMOTE_SOURCE = "https://skills.example.test";

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function seededRow(sql: Harness["sql"], agentId: string, name: string): Promise<void> {
  await sql`
    insert into agent_skills (agent_id, name, description, source, object_key, archive_sha256, archive_bytes, file_count)
    values (${agentId}, ${name}, 'seeded', 'web_upload', ${`keys/${randomUUID()}`}, ${"c".repeat(64)}, 1, 1)
  `;
}

describe("agent_skills constraints", () => {
  it("exists after the migration and enforces the unique name and check constraints", async () => {
    const harness = await boot();
    const [table] = await harness.sql<
      { name: string | null }[]
    >`select to_regclass('public.agent_skills')::text as name`;
    expect(table?.name).toBe("agent_skills");

    // The name checks force lowercase, so the case-insensitive unique index is exercised with a
    // verbatim duplicate; a case variant would be rejected by the format check instead.
    await seededRow(harness.sql, harness.agentId, "demo");
    await expect(seededRow(harness.sql, harness.agentId, "demo")).rejects.toMatchObject({ code: "23505" });

    await expect(
      harness.sql`
        insert into agent_skills (agent_id, name, description, source, object_key, archive_sha256, archive_bytes, file_count)
        values (${harness.agentId}, 'bad-sha', 'seeded', 'web_upload', ${`keys/${randomUUID()}`}, 'nothex', 1, 1)
      `,
    ).rejects.toMatchObject({ code: "23514" });

    // Trailing and consecutive hyphens are forbidden by the same rule the shared schema enforces.
    await expect(seededRow(harness.sql, harness.agentId, "pdf-")).rejects.toMatchObject({ code: "23514" });
    await expect(seededRow(harness.sql, harness.agentId, "a--b")).rejects.toMatchObject({ code: "23514" });
    await expect(seededRow(harness.sql, harness.agentId, "good-name")).resolves.toBeUndefined();
  });
});

describe("Skill HTTP surfaces", () => {
  it("completes the account lifecycle and serves the computer manifest", async () => {
    const harness = await boot();
    const bytes = await tarGz([{ name: "SKILL.md", body: skillManifest("http-skill") }]);
    const digest = sha256(bytes);

    const uploaded = await harness.app.inject({
      method: "POST",
      url: AGENT_SKILLS_TEMPLATE.replace(":agentId", harness.agentId),
      headers: {
        ...AUTH,
        "content-type": SKILL_UPLOAD_CONTENT_TYPE,
        [SKILL_SHA256_HEADER]: digest,
        [SKILL_FORMAT_HEADER]: "tar.gz",
        "content-length": String(bytes.byteLength),
      },
      payload: Buffer.from(bytes),
    });
    expect(uploaded.statusCode).toBe(200);
    const detail = SkillDetailSchema.parse(uploaded.json());
    // A bearer token marks the human CLI; the stored sha is the Server's re-packed archive, not the
    // uploader's declared digest.
    expect(detail).toMatchObject({ name: "http-skill", source: "cli_upload" });
    expect(detail.archiveSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(detail.archiveSha256).not.toBe(digest);
    expect(harness.store.keys()).toHaveLength(1);

    const listed = await harness.app.inject({
      method: "GET",
      url: AGENT_SKILLS_TEMPLATE.replace(":agentId", harness.agentId),
      headers: AUTH,
    });
    expect(listed.statusCode).toBe(200);
    expect(ListAgentSkillsResponseSchema.parse(listed.json())).toMatchObject({ storage: "available" });

    const fetched = await harness.app.inject({
      method: "GET",
      url: AGENT_SKILL_TEMPLATE.replace(":agentId", harness.agentId).replace(":skillId", detail.id),
      headers: AUTH,
    });
    expect(fetched.statusCode).toBe(200);

    const bundle = await harness.app.inject({
      method: "GET",
      url: AGENT_SKILL_BUNDLE_TEMPLATE.replace(":agentId", harness.agentId).replace(":skillId", detail.id),
      headers: AUTH,
    });
    expect(bundle.statusCode).toBe(200);
    expect(bundle.headers[SKILL_SHA256_HEADER]).toBe(detail.archiveSha256);
    expect(bundle.headers["cache-control"]).toBe("no-store");
    expect(bundle.headers["content-disposition"]).toBe('attachment; filename="http-skill.tar.gz"');
    expect(sha256(bundle.rawPayload)).toBe(detail.archiveSha256);

    const computerManifest = () =>
      harness.app.inject({
        method: "GET",
        url: COMPUTER_AGENT_SKILLS_TEMPLATE.replace(":agentId", harness.agentId),
        headers: { authorization: `Bearer ${harness.machineToken}` },
      });
    expect((await computerManifest()).json()).toMatchObject({ skills: [{ id: detail.id, name: "http-skill" }] });

    const disabled = await harness.app.inject({
      method: "PATCH",
      url: AGENT_SKILL_TEMPLATE.replace(":agentId", harness.agentId).replace(":skillId", detail.id),
      headers: AUTH,
      payload: { enabled: false },
    });
    expect(disabled.statusCode).toBe(200);
    expect((await computerManifest()).json()).toEqual({ skills: [] });

    const removed = await harness.app.inject({
      method: "DELETE",
      url: AGENT_SKILL_TEMPLATE.replace(":agentId", harness.agentId).replace(":skillId", detail.id),
      headers: AUTH,
    });
    expect(removed.statusCode).toBe(204);
    expect(harness.store.keys()).toEqual([]);
    const empty = await harness.app.inject({
      method: "GET",
      url: AGENT_SKILLS_TEMPLATE.replace(":agentId", harness.agentId),
      headers: AUTH,
    });
    expect(ListAgentSkillsResponseSchema.parse(empty.json()).skills).toEqual([]);
  });
});

/** The fingerprints a preview reports, so an install states exact content. */
async function selectionsFor(harness: Harness, agentId: string, names: string[]) {
  const preview = await harness.app.inject({
    method: "POST",
    url: AGENT_SKILLS_INSTALL_RESOLVE_TEMPLATE.replace(":agentId", agentId),
    headers: AUTH,
    payload: { source: REMOTE_SOURCE },
  });
  const skills = preview.json().skills as { name: string; fingerprint: string }[];
  return names.map((name) => ({
    name,
    fingerprint: skills.find((candidate) => candidate.name === name)?.fingerprint ?? "absent",
  }));
}

describe("Remote Skill installation over HTTP", () => {
  const resolveUrl = (agentId: string) => AGENT_SKILLS_INSTALL_RESOLVE_TEMPLATE.replace(":agentId", agentId);
  const installUrl = (agentId: string) => AGENT_SKILLS_INSTALL_TEMPLATE.replace(":agentId", agentId);

  it("previews a source and installs a selection as url_install rows", async () => {
    const harness = await boot();

    const preview = await harness.app.inject({
      method: "POST",
      url: resolveUrl(harness.agentId),
      headers: AUTH,
      payload: { source: REMOTE_SOURCE },
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().skills.map((candidate: { name: string }) => candidate.name)).toEqual(["demo", "other"]);

    const installed = await harness.app.inject({
      method: "POST",
      url: installUrl(harness.agentId),
      headers: AUTH,
      payload: { source: REMOTE_SOURCE, selections: await selectionsFor(harness, harness.agentId, ["demo"]) },
    });
    expect(installed.statusCode).toBe(200);
    expect(installed.json().results).toEqual([{ name: "demo", status: "installed" }]);

    const list = await harness.app.inject({
      method: "GET",
      url: AGENT_SKILLS_TEMPLATE.replace(":agentId", harness.agentId),
      headers: AUTH,
    });
    const skills = ListAgentSkillsResponseSchema.parse(list.json()).skills;
    expect(skills.map((skill) => [skill.name, skill.source])).toEqual([["demo", "url_install"]]);

    const rows = await harness.sql<{ source: string }[]>`
      select source from agent_skills where agent_id = ${harness.agentId}
    `;
    expect(rows.map((row) => row.source)).toEqual(["url_install"]);

    // A second install of the same name skips rather than replacing: the revision is untouched.
    const repeated = await harness.app.inject({
      method: "POST",
      url: installUrl(harness.agentId),
      headers: AUTH,
      payload: { source: REMOTE_SOURCE, selections: await selectionsFor(harness, harness.agentId, ["demo"]) },
    });
    expect(repeated.json().results).toEqual([{ name: "demo", status: "skipped_name_conflict" }]);
    const after = await harness.app.inject({
      method: "GET",
      url: AGENT_SKILLS_TEMPLATE.replace(":agentId", harness.agentId),
      headers: AUTH,
    });
    expect(ListAgentSkillsResponseSchema.parse(after.json()).skills[0]?.revision).toBe(1);
  }, 60_000);

  it("keeps an Agent readable after the documented rollback statement", async () => {
    const harness = await boot();
    await harness.app.inject({
      method: "POST",
      url: installUrl(harness.agentId),
      headers: AUTH,
      payload: { source: REMOTE_SOURCE, selections: await selectionsFor(harness, harness.agentId, ["demo"]) },
    });
    const before = await harness.sql<{ source: string }[]>`
      select source from agent_skills where agent_id = ${harness.agentId}
    `;
    expect(before.map((row) => row.source)).toEqual(["url_install"]);

    // The documented rollback step: an older Server validates `source` against the three earlier enum
    // values, so the rows have to be moved before the code is rolled back.
    await harness.sql`
      update agent_skills set source = 'web_upload' where source = 'url_install'
    `;

    const after = await harness.app.inject({
      method: "GET",
      url: AGENT_SKILLS_TEMPLATE.replace(":agentId", harness.agentId),
      headers: AUTH,
    });
    const listed = ListAgentSkillsResponseSchema.parse(after.json()).skills;
    expect(listed.map((skill) => skill.source)).toEqual(["web_upload"]);
    // The Skill itself is untouched: same id, same revision, same stored archive.
    expect(listed[0]?.revision).toBe(1);
    expect(listed[0]?.fileCount).toBe(1);
  }, 60_000);

  it("reports a source it cannot read as a source failure, not a server error", async () => {
    const harness = await boot();
    const response = await harness.app.inject({
      method: "POST",
      url: resolveUrl(harness.agentId),
      headers: AUTH,
      payload: { source: "{{EMAIL_5h5v3q2f}}:owner/repo.git" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatchObject({ code: "SKILL_SOURCE_INVALID", category: "validation" });
  });
});
