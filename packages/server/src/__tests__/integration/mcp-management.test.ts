import { randomBytes, randomUUID } from "node:crypto";
import { MCP_ERROR_CODES } from "@opentag/shared";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootstrapInitialAdmin } from "../../admin/bootstrap.js";
import { createDatabaseClient, type DatabaseClient } from "../../db/client.js";
import {
  agentMcpServers,
  agents,
  mcpClientRegistrations,
  mcpServerAuthorizations,
  mcpServers,
} from "../../db/schema/index.js";
import { AgentService } from "../../services/agents/index.js";
import { MachineAuthService } from "../../services/computers/index.js";
import { ApplicationCipher } from "../../services/crypto.js";
import {
  countLiveBindings,
  McpAuthorizationService,
  McpCredentialCipher,
  McpOAuthClient,
  McpOAuthFlowService,
  McpOutboundFetcher,
  McpProbe,
  McpRefreshWorker,
  McpServerService,
} from "../../services/mcp/index.js";
import { OnboardingResetService } from "../../services/onboarding-reset/index.js";
import { McpFixtureServer } from "../fixtures/mcp-fixture-server.js";
import { type MigratedTestDatabase, startMigratedTestDatabase } from "./migrated-test-database.js";

/**
 * The management-plane paths P2, P3, P4, and P5 from the plan, run against a real PostgreSQL and a
 * loopback fixture Server that is also its own authorization server.
 *
 * Every acceptance goal this release can actually demonstrate is asserted here, because the goals
 * that need a running Agent cannot be: runtime delivery is not implemented, so "start an Agent and
 * watch it call a tool" proves nothing about this code. What these tests do prove is the management
 * plane those goals rest on — two Agents with different authorization kinds on one Server, per-Agent
 * on/off, different Servers per Agent, and the outbound and lifecycle rules that make it safe.
 */

let testDatabase: MigratedTestDatabase;
let databaseUrl: string;

/**
 * The flow secret a browser would hold in its cookie for the duration of one authorization.
 *
 * A constant is enough for the tests that only need a flow to complete. The test that proves the
 * binding actually binds uses a different value for the second browser, which is the whole point.
 */
const FLOW_SECRET = "test-flow-secret";

beforeAll(async () => {
  testDatabase = await startMigratedTestDatabase();
  databaseUrl = testDatabase.databaseUrl;
}, 120_000);
afterAll(async () => testDatabase.stop());
beforeEach(async () => testDatabase.reset());

const openPools: { end: () => Promise<unknown> }[] = [];
afterEach(async () => {
  await Promise.all(openPools.splice(0).map((pool) => pool.end()));
});

interface Harness {
  accountId: string;
  agentA: string;
  agentB: string;
  authorization: McpAuthorizationService;
  cipher: McpCredentialCipher;
  database: DatabaseClient;
  flows: McpOAuthFlowService;
  probe: McpProbe;
  refresh: McpRefreshWorker;
  servers: McpServerService;
}

/** The fixture's loopback plain HTTP is the local-development case, so the policy opts in. */
function buildHarness(
  database: DatabaseClient,
  accountId: string,
  agentA: string,
  agentB: string,
  accountSnapshotMaxBytes?: number,
): Harness {
  const cipher = new McpCredentialCipher(new ApplicationCipher(randomBytes(32)));
  const fetcher = new McpOutboundFetcher({ allowLoopback: true });
  const servers = new McpServerService({ database });
  const probe = new McpProbe({ fetcher });
  const oauth = new McpOAuthClient({ fetcher, publicUrl: "https://opentag.test" });
  const authorization = new McpAuthorizationService({
    database,
    cipher,
    probe,
    servers,
    ...(accountSnapshotMaxBytes === undefined ? {} : { accountSnapshotMaxBytes }),
  });
  const flows = new McpOAuthFlowService({ database, cipher, oauth, servers });
  const refresh = new McpRefreshWorker({ authorization, database, flows, servers });
  return { accountId, agentA, agentB, authorization, cipher, database, flows, probe, refresh, servers };
}

async function seed(agentNames = { a: "agent-a", b: "agent-b" }, accountSnapshotMaxBytes?: number) {
  const client = createDatabaseClient(databaseUrl);
  openPools.push(client.sql);
  const machineAuth = new MachineAuthService(client.database);
  const agentService = new AgentService(client.database);
  const bootstrap = await bootstrapInitialAdmin(client.database, {
    displayName: "Tester",
    email: `mcp-${randomUUID()}@company.example`,
  });
  const accountId = bootstrap.userId;
  const issued = await machineAuth.issueForAccount(accountId, {});
  const exchange = await machineAuth.exchangeConnectCode({
    code: issued.code,
    installationId: randomUUID(),
    displayName: "workstation",
    platform: "linux",
    arch: "x64",
    clientVersion: "0.0.2",
  });
  const agentA = await agentService.createForAccount(accountId, {
    computerId: exchange.computerId,
    displayName: "Agent A",
    name: agentNames.a,
    runtimeProvider: "codex",
  });
  const agentB = await agentService.createForAccount(accountId, {
    computerId: exchange.computerId,
    displayName: "Agent B",
    name: agentNames.b,
    runtimeProvider: "codex",
  });
  return {
    ...buildHarness(client.database, accountId, agentA.id, agentB.id, accountSnapshotMaxBytes),
    agentService,
    client,
  };
}

// ------------------------------------------------------------------ P2: management plane

describe("P2 — management plane, per-Agent authorization", () => {
  it("holds two different authorization kinds for two Agents on the same Server", async () => {
    const fixture = await McpFixtureServer.start();
    const harness = await seed();
    try {
      const server = await harness.servers.createServer(harness.accountId, {
        name: "fixture",
        url: fixture.endpoint,
        defaultAuthKind: "bearer",
      });
      // Both Agents mount the same definition.
      await harness.servers.attachServer(harness.accountId, harness.agentA, server.id, true);
      await harness.servers.attachServer(harness.accountId, harness.agentB, server.id, true);

      // Agent A authorizes with a Bearer key; Agent B with OAuth. Same Server, same Account.
      await harness.authorization.setBearerOrNone(harness.accountId, harness.agentA, server.id, {
        kind: "bearer",
        bearerKey: "key_a",
      });
      const started = await harness.flows.start(harness.accountId, harness.agentB, server.id, [], FLOW_SECRET);
      expect(started.authorizationUrl).toContain("/authorize");

      const rows = await harness.database
        .select()
        .from(mcpServerAuthorizations)
        .where(eq(mcpServerAuthorizations.mcpServerId, server.id));
      expect(rows).toHaveLength(2);
      const byAgent = new Map(rows.map((row) => [row.agentId, row]));
      expect(byAgent.get(harness.agentA)?.kind).toBe("bearer");
      expect(byAgent.get(harness.agentB)?.kind).toBe("oauth");
      // Two kinds coexist on one definition; `default_auth_kind` constrained neither of them.
      expect(server.defaultAuthKind).toBe("bearer");
    } finally {
      await fixture.stop();
    }
  });

  it("keeps mounts independent and reports different Server sets per Agent", async () => {
    const fixture = await McpFixtureServer.start();
    const harness = await seed();
    try {
      const s1 = await harness.servers.createServer(harness.accountId, {
        name: "s1",
        url: fixture.endpoint,
        defaultAuthKind: "none",
      });
      const s2 = await harness.servers.createServer(harness.accountId, {
        name: "s2",
        url: `${fixture.endpoint}?alt=1`,
        defaultAuthKind: "none",
      });
      const s3 = await harness.servers.createServer(harness.accountId, {
        name: "s3",
        url: `${fixture.endpoint}?alt=2`,
        defaultAuthKind: "none",
      });

      await harness.servers.attachServer(harness.accountId, harness.agentA, s1.id, true);
      await harness.servers.attachServer(harness.accountId, harness.agentB, s1.id, true);
      await harness.servers.attachServer(harness.accountId, harness.agentA, s2.id, true);
      await harness.servers.attachServer(harness.accountId, harness.agentB, s2.id, true);
      // s3 is mounted by neither, so neither Agent's set may contain it.
      await harness.servers.attachServer(harness.accountId, harness.agentA, s3.id, true);
      await harness.servers.detachServer(harness.accountId, harness.agentA, s3.id);

      const forA = await harness.servers.listAgentServers(harness.accountId, harness.agentA);
      const forB = await harness.servers.listAgentServers(harness.accountId, harness.agentB);
      expect(forA.map((entry) => entry.name)).toEqual(["s1", "s2"]);
      expect(forB.map((entry) => entry.name)).toEqual(["s1", "s2"]);
      expect(forA.some((entry) => entry.name === "s3")).toBe(false);
    } finally {
      await fixture.stop();
    }
  });

  it("carries the only enable switch, keeping the credential across a disable and enable", async () => {
    const fixture = await McpFixtureServer.start();
    const harness = await seed();
    try {
      const server = await harness.servers.createServer(harness.accountId, {
        name: "fixture",
        url: fixture.endpoint,
        defaultAuthKind: "bearer",
      });
      await harness.servers.attachServer(harness.accountId, harness.agentA, server.id, true);
      await harness.servers.attachServer(harness.accountId, harness.agentB, server.id, true);
      await harness.authorization.setBearerOrNone(harness.accountId, harness.agentA, server.id, {
        kind: "bearer",
        bearerKey: "key_a",
      });
      await harness.authorization.setBearerOrNone(harness.accountId, harness.agentB, server.id, {
        kind: "bearer",
        bearerKey: "key_b",
      });

      // Target 4: disabling is per Agent and touches nothing else.
      const disabled = await harness.servers.updateBinding(harness.accountId, harness.agentB, server.id, {
        enabled: false,
      });
      expect(disabled.enabled).toBe(false);
      expect(disabled.authorization?.status).toBe("active");
      expect(disabled.authorization?.hasCredential).toBe(true);

      const forA = await harness.servers.listAgentServers(harness.accountId, harness.agentA);
      expect(forA.find((entry) => entry.mcpServerId === server.id)?.enabled).toBe(true);

      // Re-enabling needs no reauthorization: the credential was never dropped.
      const enabled = await harness.servers.updateBinding(harness.accountId, harness.agentB, server.id, {
        enabled: true,
      });
      expect(enabled.enabled).toBe(true);
      expect(enabled.authorization?.status).toBe("active");
    } finally {
      await fixture.stop();
    }
  });

  it("reports the aggregate counts and lastProbedAt from the authorization rows", async () => {
    const fixture = await McpFixtureServer.start();
    const harness = await seed();
    try {
      const server = await harness.servers.createServer(harness.accountId, {
        name: "fixture",
        url: fixture.endpoint,
        defaultAuthKind: "bearer",
      });
      await harness.servers.attachServer(harness.accountId, harness.agentA, server.id, true);
      await harness.servers.attachServer(harness.accountId, harness.agentB, server.id, true);
      await harness.authorization.setBearerOrNone(harness.accountId, harness.agentA, server.id, {
        kind: "bearer",
        bearerKey: "key_a",
      });

      const before = await harness.servers.listServers(harness.accountId);
      expect(before[0]?.boundAgentCount).toBe(2);
      expect(before[0]?.authorizedAgentCount).toBe(1);
      expect(before[0]?.lastProbedAt).toBeNull();

      // A probe advances `probed_at` on its own row, and the aggregate picks it up as a `max`.
      await harness.authorization.probe(harness.accountId, harness.agentA, server.id);
      const after = await harness.servers.listServers(harness.accountId);
      expect(after[0]?.lastProbedAt).not.toBeNull();
      // The definition itself has no probe column, so automatic writing never advances its revision.
      expect(after[0]?.revision).toBe(1);
    } finally {
      await fixture.stop();
    }
  });
});

// ------------------------------------------------------------------ P3: OAuth round trip

describe("P3 — OAuth round trip against the fixture authorization server", () => {
  it("completes the flow, probes, and stores a modern-era snapshot", async () => {
    const fixture = await McpFixtureServer.start({
      toolPages: [
        { tools: [{ name: "first", description: "one" }], nextCursor: "page-1" },
        { tools: [{ name: "second", description: "two" }] },
      ],
    });
    const harness = await seed();
    try {
      const server = await harness.servers.createServer(harness.accountId, {
        name: "fixture",
        url: fixture.endpoint,
        defaultAuthKind: "oauth",
      });
      await harness.servers.attachServer(harness.accountId, harness.agentA, server.id, true);

      const started = await harness.flows.start(harness.accountId, harness.agentA, server.id, [], FLOW_SECRET);
      const state = new URL(started.authorizationUrl).searchParams.get("state") ?? "";
      expect(state.length).toBeGreaterThan(0);

      // Drive the authorize endpoint, then hand the code back the way the browser would.
      const authorize = await fetch(started.authorizationUrl, { redirect: "manual" });
      expect(authorize.status).toBe(302);
      const callback = new URL(authorize.headers.get("location") as string);
      const result = await harness.flows.callback(
        {
          code: callback.searchParams.get("code") ?? "",
          state: callback.searchParams.get("state") ?? "",
          iss: callback.searchParams.get("iss") ?? undefined,
        },
        FLOW_SECRET,
      );
      // The Account travels back too, so the callback's backstage probe has one to scope itself to.
      expect(result).toEqual({ accountId: harness.accountId, agentId: harness.agentA, mcpServerId: server.id });

      const [row] = await harness.database
        .select()
        .from(mcpServerAuthorizations)
        .where(eq(mcpServerAuthorizations.mcpServerId, server.id));
      expect(row?.status).toBe("active");
      expect(row?.state).toBeNull();
      expect(row?.pkceCiphertext).toBeNull();
      expect(row?.ciphertext).not.toBeNull();

      // The probe runs after the callback, so `probeState` starts pending and resolves here.
      const probe = await harness.authorization.probe(harness.accountId, harness.agentA, server.id);
      expect(probe.probeState).toBe("succeeded");
      expect(probe.toolsCount).toBe(2);
      expect(probe.protocolEra).toBe("modern");
      expect(probe.protocolVersion).toBe("2026-07-28");
    } finally {
      await fixture.stop();
    }
  });

  it("registers a client for DCR and reuses it instead of registering again", async () => {
    // DCR explicitly: with CIMD advertised, the client is this deployment's own URL and there is
    // nothing to register, so the path below would never run.
    const fixture = await McpFixtureServer.start({ capabilities: {}, dynamicRegistrationOnly: true });
    const harness = await seed();
    try {
      const server = await harness.servers.createServer(harness.accountId, {
        name: "fixture",
        url: fixture.endpoint,
        defaultAuthKind: "oauth",
      });
      await harness.servers.attachServer(harness.accountId, harness.agentA, server.id, true);
      await harness.flows.start(harness.accountId, harness.agentA, server.id, [], FLOW_SECRET);

      const registrations = await harness.database
        .select()
        .from(mcpClientRegistrations)
        .where(eq(mcpClientRegistrations.accountId, harness.accountId));
      expect(registrations).toHaveLength(1);
      expect(registrations[0]?.source).toBe("dcr");

      // A second start for another Agent at the same issuer reuses that registration rather than
      // registering again: it is the Account's client at that AS, not the Agent's.
      await harness.servers.attachServer(harness.accountId, harness.agentB, server.id, true);
      await harness.flows.start(harness.accountId, harness.agentB, server.id, [], FLOW_SECRET);
      const after = await harness.database
        .select()
        .from(mcpClientRegistrations)
        .where(eq(mcpClientRegistrations.accountId, harness.accountId));
      expect(after).toHaveLength(1);
      expect(after[0]?.clientId).toBe(registrations[0]?.clientId);
      // And the fixture really was asked once, so the reuse is not an illusion of the row count.
      expect(fixture.registrations).toBe(1);
    } finally {
      await fixture.stop();
    }
  });

  it("holds no registration row for a CIMD client, which is derivable", async () => {
    /*
     * Blocker: recording a CIMD row upserted over an existing DCR row, because
     * `mcp_client_registrations` is unique on `(Account, issuer)` while the lookup is scoped by
     * `source`. That repointed `client_id` and cleared the secret under every authorization already
     * using the row, so their next refresh presented a client the AS had never issued them — and
     * `invalid_client` is terminal. The client is this deployment's URL, so nothing needs storing.
     */
    const fixture = await McpFixtureServer.start({ capabilities: {} });
    const harness = await seed();
    try {
      const server = await harness.servers.createServer(harness.accountId, {
        name: "fixture",
        url: fixture.endpoint,
        defaultAuthKind: "oauth",
      });
      await harness.servers.attachServer(harness.accountId, harness.agentA, server.id, true);
      const started = await harness.flows.start(harness.accountId, harness.agentA, server.id, [], FLOW_SECRET);

      // No row is written...
      const registrations = await harness.database
        .select()
        .from(mcpClientRegistrations)
        .where(eq(mcpClientRegistrations.accountId, harness.accountId));
      expect(registrations).toHaveLength(0);

      // ...and the flow still completes, because the callback resolves the same derivable client.
      const authorize = await fetch(started.authorizationUrl, { redirect: "manual" });
      const callback = new URL(authorize.headers.get("location") as string);
      await expect(
        harness.flows.callback(
          {
            code: callback.searchParams.get("code") ?? "",
            state: callback.searchParams.get("state") ?? "",
            iss: callback.searchParams.get("iss") ?? undefined,
          },
          FLOW_SECRET,
        ),
      ).resolves.toMatchObject({ agentId: harness.agentA });
      const [row] = await harness.database
        .select()
        .from(mcpServerAuthorizations)
        .where(eq(mcpServerAuthorizations.agentId, harness.agentA));
      expect(row?.status).toBe("active");
    } finally {
      await fixture.stop();
    }
  });

  it("invalidates the previous state when a flow is restarted", async () => {
    const fixture = await McpFixtureServer.start();
    const harness = await seed();
    try {
      const server = await harness.servers.createServer(harness.accountId, {
        name: "fixture",
        url: fixture.endpoint,
        defaultAuthKind: "oauth",
      });
      await harness.servers.attachServer(harness.accountId, harness.agentA, server.id, true);

      const first = await harness.flows.start(harness.accountId, harness.agentA, server.id, [], FLOW_SECRET);
      const oldState = new URL(first.authorizationUrl).searchParams.get("state") ?? "";
      const second = await harness.flows.start(harness.accountId, harness.agentA, server.id, [], FLOW_SECRET);
      const newState = new URL(second.authorizationUrl).searchParams.get("state") ?? "";
      expect(newState).not.toBe(oldState);

      // The superseded state is no longer addressable, so an old callback URL cannot be redeemed.
      await expect(harness.flows.callback({ code: "stale", state: oldState }, FLOW_SECRET)).rejects.toMatchObject({
        code: "MCP_OAUTH_FLOW_INVALID",
      });
    } finally {
      await fixture.stop();
    }
  });

  /*
   * The session-fixation attack this binding exists to stop, driven through the real flow: A starts
   * an authorization, hands the URL to B, and B approves it. Before the binding, B's approval landed
   * a credential on A's Agent — a genuine consent screen for a genuine deployment, because the
   * client_id is deployment-wide, so nothing about the screen warns B.
   */
  it("refuses a callback presented by a browser that did not start the flow", async () => {
    const fixture = await McpFixtureServer.start();
    const harness = await seed();
    try {
      const server = await harness.servers.createServer(harness.accountId, {
        name: "fixture",
        url: fixture.endpoint,
        defaultAuthKind: "oauth",
      });
      await harness.servers.attachServer(harness.accountId, harness.agentA, server.id, true);

      // A starts the flow and keeps the returned secret; only the URL is forwarded to B.
      const aSecret = "flow-secret-for-browser-a";
      const started = await harness.flows.start(harness.accountId, harness.agentA, server.id, [], aSecret);
      const authorize = await fetch(started.authorizationUrl, { redirect: "manual" });
      const callback = new URL(authorize.headers.get("location") as string);
      const redeem = {
        code: callback.searchParams.get("code") ?? "",
        state: callback.searchParams.get("state") ?? "",
        iss: callback.searchParams.get("iss") ?? undefined,
      };

      // B holds the URL and the state, but not A's secret: the flow is refused and cleared.
      await expect(harness.flows.callback(redeem, "flow-secret-for-browser-b")).rejects.toMatchObject({
        code: "MCP_OAUTH_FLOW_INVALID",
      });
      // A missing cookie is refused the same way, without even performing the state lookup.
      await expect(harness.flows.callback(redeem, undefined)).rejects.toMatchObject({
        code: "MCP_OAUTH_FLOW_INVALID",
      });

      // And the credential really was not stored: the refusal is not cosmetic.
      const [row] = await harness.database
        .select()
        .from(mcpServerAuthorizations)
        .where(eq(mcpServerAuthorizations.agentId, harness.agentA));
      expect(row?.ciphertext).toBeNull();
      expect(row?.status).not.toBe("active");
    } finally {
      await fixture.stop();
    }
  });

  it("does not destroy a pending flow when a callback presents the wrong secret", async () => {
    /*
     * The refusal must be harmless to the flow it refused.
     *
     * Clearing on mismatch handed anyone who learned a `state` an unauthenticated way to kill a
     * pending authorization, and it made two concurrent flows impossible: one cookie name at one path
     * means starting flow B replaces the cookie flow A holds, so A's own callback would have
     * destroyed A.
     */
    const fixture = await McpFixtureServer.start();
    const harness = await seed();
    try {
      const server = await harness.servers.createServer(harness.accountId, {
        name: "fixture",
        url: fixture.endpoint,
        defaultAuthKind: "oauth",
      });
      await harness.servers.attachServer(harness.accountId, harness.agentA, server.id, true);

      const started = await harness.flows.start(harness.accountId, harness.agentA, server.id, [], FLOW_SECRET);
      const authorize = await fetch(started.authorizationUrl, { redirect: "manual" });
      const callback = new URL(authorize.headers.get("location") as string);
      const redeem = {
        code: callback.searchParams.get("code") ?? "",
        state: callback.searchParams.get("state") ?? "",
        iss: callback.searchParams.get("iss") ?? undefined,
      };

      // A stranger's attempt is refused...
      await expect(harness.flows.callback(redeem, "not-my-secret")).rejects.toMatchObject({
        code: MCP_ERROR_CODES.OAUTH_FLOW_INVALID,
      });

      // ...and the rightful browser can still complete the very same flow afterwards.
      await expect(harness.flows.callback(redeem, FLOW_SECRET)).resolves.toMatchObject({
        agentId: harness.agentA,
        mcpServerId: server.id,
      });
      const [row] = await harness.database
        .select()
        .from(mcpServerAuthorizations)
        .where(eq(mcpServerAuthorizations.agentId, harness.agentA));
      expect(row?.status).toBe("active");
    } finally {
      await fixture.stop();
    }
  });

  it("records a terminal status when the authorization is denied", async () => {
    /*
     * A denial has to leave `pending`, or the waiter cannot tell it apart from "still in flight".
     *
     * `mcp authorize` polls until `status` leaves `pending` (and the page's probe indicator does the
     * same), so a denial that only cleared the flow's state left the user watching a spinner for the
     * flow's full ten minutes before a timeout — which the review caught as a claim that did not hold.
     */
    const fixture = await McpFixtureServer.start({ denyAuthorization: true });
    const harness = await seed();
    try {
      const server = await harness.servers.createServer(harness.accountId, {
        name: "fixture",
        url: fixture.endpoint,
        defaultAuthKind: "oauth",
      });
      await harness.servers.attachServer(harness.accountId, harness.agentA, server.id, true);

      const started = await harness.flows.start(harness.accountId, harness.agentA, server.id, [], FLOW_SECRET);
      const authorize = await fetch(started.authorizationUrl, { redirect: "manual" });
      const callback = new URL(authorize.headers.get("location") as string);
      expect(callback.searchParams.get("error")).toBe("access_denied");

      await expect(
        harness.flows.callback(
          {
            error: "access_denied",
            state: callback.searchParams.get("state") ?? "",
          },
          FLOW_SECRET,
        ),
      ).rejects.toMatchObject({ code: MCP_ERROR_CODES.OAUTH_DENIED });

      const [row] = await harness.database
        .select()
        .from(mcpServerAuthorizations)
        .where(eq(mcpServerAuthorizations.agentId, harness.agentA));
      // Terminal: `status` left `pending`, the flow is gone, and the reason is recorded.
      expect(row?.status).toBe("error");
      expect(row?.failureCode).toBe(MCP_ERROR_CODES.OAUTH_DENIED);
      expect(row?.state).toBeNull();
      expect(row?.ciphertext).toBeNull();
    } finally {
      await fixture.stop();
    }
  });

  it("keeps a working credential when a re-authorization is denied", async () => {
    /*
     * Blocker: `#failFlow` wrote `status: "error"` unconditionally, and `resolveActiveCredential`
     * requires `active`, so denying a *re*-authorization on a working Agent left the ciphertext present
     * and unusable — the same user-visible outcome as the bug that stopped `start` from clearing it,
     * reached by a different door. The reason is still recorded, because the waiter has to be told the
     * flow ended, and `status` cannot carry that when a credential survives.
     */
    const fixture = await McpFixtureServer.start({ denyAuthorization: true });
    const harness = await seed();
    try {
      const server = await harness.servers.createServer(harness.accountId, {
        name: "fixture",
        url: fixture.endpoint,
        defaultAuthKind: "oauth",
      });
      await harness.servers.attachServer(harness.accountId, harness.agentA, server.id, true);

      // Grant a credential by hand, so the denial below is a *re*-authorization.
      await harness.authorization.setBearerOrNone(harness.accountId, harness.agentA, server.id, {
        kind: "bearer",
        bearerKey: "key_a",
      });
      await expect(
        harness.authorization.resolveActiveCredential(harness.accountId, harness.agentA, server.id),
      ).resolves.toBeDefined();

      const started = await harness.flows.start(harness.accountId, harness.agentA, server.id, [], FLOW_SECRET);
      const authorize = await fetch(started.authorizationUrl, { redirect: "manual" });
      const callback = new URL(authorize.headers.get("location") as string);
      await expect(
        harness.flows.callback(
          { error: "access_denied", state: callback.searchParams.get("state") ?? "" },
          FLOW_SECRET,
        ),
      ).rejects.toMatchObject({ code: MCP_ERROR_CODES.OAUTH_DENIED });

      const [row] = await harness.database
        .select()
        .from(mcpServerAuthorizations)
        .where(eq(mcpServerAuthorizations.agentId, harness.agentA));
      // The credential survives and is still usable...
      expect(row?.status).toBe("active");
      expect(row?.ciphertext).not.toBeNull();
      await expect(
        harness.authorization.resolveActiveCredential(harness.accountId, harness.agentA, server.id),
      ).resolves.toBeDefined();
      // ...the flow is over, and the reason is recorded so a waiter stops waiting.
      expect(row?.failureCode).toBe(MCP_ERROR_CODES.OAUTH_DENIED);
      expect(row?.state).toBeNull();
    } finally {
      await fixture.stop();
    }
  }, 30_000);

  it("leaves a working credential alone when a restart of the flow is abandoned", async () => {
    /*
     * S8. Starting a flow used to clear the credential and set `status: pending`, so a user who
     * clicked Authorize on an Agent that already worked and then closed the tab was left with an
     * unauthorized Agent — the flow destroyed the very thing it was re-authorizing.
     *
     * A live flow is identified by `state` being set and unexpired, which is how the callback finds
     * its row, so `status` does not have to be bent for the flow's sake.
     */
    const fixture = await McpFixtureServer.start();
    const harness = await seed();
    try {
      const server = await harness.servers.createServer(harness.accountId, {
        name: "fixture",
        url: fixture.endpoint,
        defaultAuthKind: "oauth",
      });
      await harness.servers.attachServer(harness.accountId, harness.agentA, server.id, true);

      // Complete one authorization so the Agent genuinely works.
      const first = await harness.flows.start(harness.accountId, harness.agentA, server.id, [], FLOW_SECRET);
      const authorize = await fetch(first.authorizationUrl, { redirect: "manual" });
      const callback = new URL(authorize.headers.get("location") as string);
      await harness.flows.callback(
        {
          code: callback.searchParams.get("code") ?? "",
          state: callback.searchParams.get("state") ?? "",
          iss: callback.searchParams.get("iss") ?? undefined,
        },
        FLOW_SECRET,
      );
      const [before] = await harness.database
        .select()
        .from(mcpServerAuthorizations)
        .where(eq(mcpServerAuthorizations.agentId, harness.agentA));
      expect(before?.status).toBe("active");

      // Start again and abandon it: the credential and its status must both survive.
      await harness.flows.start(harness.accountId, harness.agentA, server.id, [], FLOW_SECRET);
      const [after] = await harness.database
        .select()
        .from(mcpServerAuthorizations)
        .where(eq(mcpServerAuthorizations.agentId, harness.agentA));
      expect(after?.status).toBe("active");
      expect(after?.ciphertext).toBe(before?.ciphertext);
      // And it is still usable, which is the point of keeping it.
      await expect(
        harness.authorization.resolveActiveCredential(harness.accountId, harness.agentA, server.id),
      ).resolves.toBeDefined();
    } finally {
      await fixture.stop();
    }
  });

  it("does not resurrect a credential revoked while the exchange was in flight", async () => {
    /*
     * The exchange takes an upstream round trip, and the user can revoke or switch kind during it. The
     * callback's final write is fenced on the flow's own state, so a callback that lost that race
     * leaves the newer decision alone rather than restoring a credential the user just discarded.
     *
     * The revoke has to land *inside* the exchange to reach the fence: revoking before the callback
     * clears `state`, so the lookup refuses it first and the write is never attempted. The fixture's
     * `onTokenRequest` hook is that window.
     */
    // The hook fires inside the exchange, so it reads the ids from a holder the test fills first.
    const race: { harness?: Awaited<ReturnType<typeof seed>>; serverId?: string } = {};
    const fixture = await McpFixtureServer.start({
      onTokenRequest: async () => {
        // The user revokes while the token request is outstanding.
        if (race.harness && race.serverId) {
          await race.harness.authorization.revoke(race.harness.accountId, race.harness.agentA, race.serverId);
        }
      },
    });
    const harness = await seed();
    race.harness = harness;
    try {
      const server = await harness.servers.createServer(harness.accountId, {
        name: "fixture",
        url: fixture.endpoint,
        defaultAuthKind: "oauth",
      });
      await harness.servers.attachServer(harness.accountId, harness.agentA, server.id, true);
      race.serverId = server.id;

      const started = await harness.flows.start(harness.accountId, harness.agentA, server.id, [], FLOW_SECRET);
      const authorize = await fetch(started.authorizationUrl, { redirect: "manual" });
      const callback = new URL(authorize.headers.get("location") as string);

      await expect(
        harness.flows.callback(
          {
            code: callback.searchParams.get("code") ?? "",
            state: callback.searchParams.get("state") ?? "",
            iss: callback.searchParams.get("iss") ?? undefined,
          },
          FLOW_SECRET,
        ),
      ).rejects.toMatchObject({ code: MCP_ERROR_CODES.OAUTH_FLOW_INVALID });

      const [row] = await harness.database
        .select()
        .from(mcpServerAuthorizations)
        .where(eq(mcpServerAuthorizations.agentId, harness.agentA));
      expect(row?.status).toBe("revoked");
      expect(row?.ciphertext).toBeNull();
    } finally {
      await fixture.stop();
    }
  });

  it("redeems a callback only under the client registration the flow recorded", async () => {
    // DCR, so there is a recorded registration to redeem under. With CIMD there is none by design.
    const fixture = await McpFixtureServer.start({ dynamicRegistrationOnly: true });
    const harness = await seed();
    try {
      const server = await harness.servers.createServer(harness.accountId, {
        name: "fixture",
        url: fixture.endpoint,
        defaultAuthKind: "oauth",
      });
      await harness.servers.attachServer(harness.accountId, harness.agentA, server.id, true);

      const started = await harness.flows.start(harness.accountId, harness.agentA, server.id, [], FLOW_SECRET);
      const authorize = await fetch(started.authorizationUrl, { redirect: "manual" });
      const callback = new URL(authorize.headers.get("location") as string);
      await harness.flows.callback(
        {
          code: callback.searchParams.get("code") ?? "",
          state: callback.searchParams.get("state") ?? "",
          iss: callback.searchParams.get("iss") ?? undefined,
        },
        FLOW_SECRET,
      );

      /*
       * The whole point of B3: the callback exchanged the code under the client `start` registered.
       * Registering a second client here is what made a strict authorization server answer
       * `invalid_client`, so exactly one registration must exist for this (Account, issuer) pair and
       * the row must still point at it. The fixture's token endpoint rejects a code presented under a
       * client its authorization request did not name, so this passing means the exchange really used
       * the recorded client.
       */
      const registrations = await harness.database
        .select()
        .from(mcpClientRegistrations)
        .where(eq(mcpClientRegistrations.accountId, harness.accountId));
      expect(registrations).toHaveLength(1);
      expect(registrations[0]?.source).toBe("dcr");
      const [row] = await harness.database
        .select()
        .from(mcpServerAuthorizations)
        .where(eq(mcpServerAuthorizations.agentId, harness.agentA));
      expect(row?.status).toBe("active");
      expect(row?.clientRegistrationId).toBe(registrations[0]?.id);
    } finally {
      await fixture.stop();
    }
  });

  it("marks the authorization revoked when the token endpoint reports invalid_grant", async () => {
    const fixture = await McpFixtureServer.start();
    const harness = await seed();
    try {
      const server = await harness.servers.createServer(harness.accountId, {
        name: "fixture",
        url: fixture.endpoint,
        defaultAuthKind: "oauth",
      });
      await harness.servers.attachServer(harness.accountId, harness.agentA, server.id, true);
      const started = await harness.flows.start(harness.accountId, harness.agentA, server.id, [], FLOW_SECRET);
      const authorize = await fetch(started.authorizationUrl, { redirect: "manual" });
      const callback = new URL(authorize.headers.get("location") as string);
      await harness.flows.callback(
        {
          code: callback.searchParams.get("code") ?? "",
          state: callback.searchParams.get("state") ?? "",
          iss: callback.searchParams.get("iss") ?? undefined,
        },
        FLOW_SECRET,
      );

      // The issuer stays put — the envelope's AAD names it, so moving the AS is a different
      // property — while the grant itself starts failing.
      const [row] = await harness.database
        .select()
        .from(mcpServerAuthorizations)
        .where(eq(mcpServerAuthorizations.mcpServerId, server.id));
      fixture.failTokenEndpoint("invalid_grant");
      await harness.database
        .update(mcpServerAuthorizations)
        .set({ accessTokenExpiresAt: new Date(0) })
        .where(eq(mcpServerAuthorizations.id, row?.id as string));

      await harness.flows.refreshAuthorization(row?.id as string);
      const [after] = await harness.database
        .select()
        .from(mcpServerAuthorizations)
        .where(eq(mcpServerAuthorizations.id, row?.id as string));
      // `invalid_grant` is terminal: the credential is definitively gone, so it is cleared and the
      // user is asked to authorize again rather than the row being retried forever.
      expect(after?.status).toBe("revoked");
      expect(after?.ciphertext).toBeNull();
    } finally {
      await fixture.stop();
    }
  }, 30_000);

  it("refreshes an expiring token without re-probing", async () => {
    const fixture = await McpFixtureServer.start();
    const harness = await seed();
    try {
      const server = await harness.servers.createServer(harness.accountId, {
        name: "fixture",
        url: fixture.endpoint,
        defaultAuthKind: "oauth",
      });
      await harness.servers.attachServer(harness.accountId, harness.agentA, server.id, true);
      const started = await harness.flows.start(harness.accountId, harness.agentA, server.id, [], FLOW_SECRET);
      const authorize = await fetch(started.authorizationUrl, { redirect: "manual" });
      const callback = new URL(authorize.headers.get("location") as string);
      await harness.flows.callback(
        {
          code: callback.searchParams.get("code") ?? "",
          state: callback.searchParams.get("state") ?? "",
          iss: callback.searchParams.get("iss") ?? undefined,
        },
        FLOW_SECRET,
      );
      await harness.authorization.probe(harness.accountId, harness.agentA, server.id);

      const [before] = await harness.database
        .select()
        .from(mcpServerAuthorizations)
        .where(eq(mcpServerAuthorizations.mcpServerId, server.id));
      const tokensBefore = fixture.tokensIssued;
      await harness.database
        .update(mcpServerAuthorizations)
        .set({ accessTokenExpiresAt: new Date(0) })
        .where(eq(mcpServerAuthorizations.id, before?.id as string));

      const passes = await harness.refresh.runOnce();
      expect(passes).toBe(1);
      expect(fixture.tokensIssued).toBeGreaterThan(tokensBefore);

      const [after] = await harness.database
        .select()
        .from(mcpServerAuthorizations)
        .where(eq(mcpServerAuthorizations.id, before?.id as string));
      expect(after?.status).toBe("active");
      expect(after?.refreshGeneration).toBe((before?.refreshGeneration ?? 0) + 1);
      expect(after?.lastRefreshedAt).not.toBeNull();
      expect(after?.refreshClaimId).toBeNull();
      // A successful refresh does not re-probe, so the snapshot timestamp is unchanged.
      expect(after?.probedAt?.getTime()).toBe(before?.probedAt?.getTime());
    } finally {
      await fixture.stop();
    }
  }, 30_000);

  it("treats a token with no expires_in as short-lived rather than never expiring", async () => {
    /*
     * S7. `expires_in` is optional, and storing no expiry made the token immortal to the refresh
     * worker: its `due` predicate compares `access_token_expires_at`, and a null never compares due —
     * so the token was never refreshed and simply died at the authorization server's discretion.
     */
    const fixture = await McpFixtureServer.start({ omitExpiresIn: true });
    const harness = await seed();
    try {
      const server = await harness.servers.createServer(harness.accountId, {
        name: "fixture",
        url: fixture.endpoint,
        defaultAuthKind: "oauth",
      });
      await harness.servers.attachServer(harness.accountId, harness.agentA, server.id, true);
      const started = await harness.flows.start(harness.accountId, harness.agentA, server.id, [], FLOW_SECRET);
      const authorize = await fetch(started.authorizationUrl, { redirect: "manual" });
      const callback = new URL(authorize.headers.get("location") as string);
      await harness.flows.callback(
        {
          code: callback.searchParams.get("code") ?? "",
          state: callback.searchParams.get("state") ?? "",
          iss: callback.searchParams.get("iss") ?? undefined,
        },
        FLOW_SECRET,
      );

      // An expiry was recorded rather than left null, so the refresh pass can see it is due.
      const [row] = await harness.database
        .select()
        .from(mcpServerAuthorizations)
        .where(eq(mcpServerAuthorizations.agentId, harness.agentA));
      expect(row?.status).toBe("active");
      // Asserted non-null first so a missing expiry fails here rather than throwing inside the next line.
      expect(row?.accessTokenExpiresAt).not.toBeNull();
      const expiresAt = row?.accessTokenExpiresAt;
      expect(expiresAt).toBeInstanceOf(Date);
      // Within the refresh lead, which is what makes the next pass select it.
      expect((expiresAt as Date).getTime()).toBeLessThanOrEqual(Date.now() + 10 * 60 * 1000);

      const passes = await harness.refresh.runOnce();
      expect(passes).toBe(1);
    } finally {
      await fixture.stop();
    }
  }, 30_000);

  it("never asks the fixture for a refresh when the credential has no refresh token", async () => {
    const fixture = await McpFixtureServer.start();
    const harness = await seed();
    try {
      const server = await harness.servers.createServer(harness.accountId, {
        name: "fixture",
        url: fixture.endpoint,
        defaultAuthKind: "oauth",
      });
      await harness.servers.attachServer(harness.accountId, harness.agentA, server.id, true);
      await harness.authorization.setBearerOrNone(harness.accountId, harness.agentA, server.id, {
        kind: "bearer",
        bearerKey: "key_a",
      });
      // A Bearer row is not an OAuth row, so the refresh pass must leave it alone entirely.
      const passes = await harness.refresh.runOnce();
      expect(passes).toBe(0);
    } finally {
      await fixture.stop();
    }
  });

  it("can write a Bearer key over a row that still names an authorization server", async () => {
    /*
     * Switching from OAuth to Bearer used to store a key that could not be decrypted.
     *
     * The envelope was sealed with the old row's `authorizationServer` as AAD while the same write set
     * that column to null, so `resolveActiveCredential` then opened it with null and failed. Any row
     * that had been through an abandoned OAuth `start` or an OAuth `revoke` still carries a value
     * there, which is the ordinary state a user reaches by changing their mind. The PUT returned 200
     * and every probe failed, and re-entering the same key "fixed" it only because the second write
     * found the column already null.
     */
    const fixture = await McpFixtureServer.start();
    const harness = await seed();
    try {
      const server = await harness.servers.createServer(harness.accountId, {
        name: "fixture",
        url: fixture.endpoint,
        defaultAuthKind: "oauth",
      });
      await harness.servers.attachServer(harness.accountId, harness.agentA, server.id, true);

      // An abandoned OAuth start leaves `authorizationServer` set.
      await harness.flows.start(harness.accountId, harness.agentA, server.id, [], FLOW_SECRET);
      const [during] = await harness.database
        .select()
        .from(mcpServerAuthorizations)
        .where(eq(mcpServerAuthorizations.agentId, harness.agentA));
      expect(during?.authorizationServer).not.toBeNull();

      // Switching to a Bearer key must produce a credential that actually opens.
      await harness.authorization.setBearerOrNone(harness.accountId, harness.agentA, server.id, {
        kind: "bearer",
        bearerKey: "key_a",
      });
      const outcome = await harness.authorization.probe(harness.accountId, harness.agentA, server.id);
      expect(outcome.probeState).toBe("succeeded");
    } finally {
      await fixture.stop();
    }
  });
});

// ------------------------------------------------------------------ P4: SSRF regression

describe("P4 — the outbound gate refuses every private destination in the discovery chain", () => {
  const privateTargets = [
    "http://169.254.169.254/latest/meta-data/",
    "http://10.0.0.1/prm",
    "http://192.168.0.1/metadata",
  ] as const;

  it("refuses a challenge that names a private resource_metadata document, making no request", async () => {
    const fixture = await McpFixtureServer.start({
      challenge: () => `Bearer resource_metadata="${privateTargets[0]}"`,
    });
    const harness = await seed();
    try {
      const server = await harness.servers.createServer(harness.accountId, {
        name: "fixture",
        url: fixture.endpoint,
        defaultAuthKind: "oauth",
      });
      await harness.servers.attachServer(harness.accountId, harness.agentA, server.id, true);
      // A hosted deployment: loopback is not the case under test here, and every private target is
      // refused whatever the scheme.
      const hosted = new McpOutboundFetcher({ allowLoopback: false });
      const oauth = new McpOAuthClient({ fetcher: hosted, publicUrl: "https://opentag.test" });
      await expect(
        oauth.protectedResourceMetadata(harness.accountId, "https://mcp.example.com/mcp", privateTargets[0]),
      ).rejects.toMatchObject({ code: "MCP_URL_BLOCKED" });
    } finally {
      await fixture.stop();
    }
  });

  it("refuses a Protected Resource Metadata document that names a private authorization server", async () => {
    const fixture = await McpFixtureServer.start({
      protectedResourceMetadata: () => ({ authorization_servers: ["http://10.0.0.1"] }),
    });
    const harness = await seed();
    try {
      const loopback = new McpOutboundFetcher({ allowLoopback: true });
      const hosted = new McpOutboundFetcher({ allowLoopback: false });
      const reader = new McpOAuthClient({ fetcher: loopback, publicUrl: "https://opentag.test" });
      const { metadata } = await reader.protectedResourceMetadata(harness.accountId, fixture.endpoint);
      // The document is readable, and it names a private issuer — the peer controls that field.
      expect(metadata.authorizationServers).toEqual(["http://10.0.0.1"]);

      // A deployment that cannot reach its own loopback refuses the private issuer at the step that
      // would dial it, before any request leaves.
      const hostedClient = new McpOAuthClient({ fetcher: hosted, publicUrl: "https://opentag.test" });
      await expect(
        hostedClient.authorizationServerMetadata(harness.accountId, "http://10.0.0.1"),
      ).rejects.toMatchObject({ code: "MCP_URL_BLOCKED" });
    } finally {
      await fixture.stop();
    }
  });

  it("refuses an authorization server whose token endpoint is private", async () => {
    /*
     * Two independent refusals, and both are wanted:
     *
     * - A plain-HTTP non-loopback endpoint is invalid for OAuth, so the metadata reader refuses it.
     *   That is the earlier and cheaper check, and it is what stops `javascript:` reaching the browser
     *   through `location.assign`.
     * - An `https:` endpoint on a private address is syntactically fine and only the outbound gate can
     *   judge it, which it does before any request is made.
     */
    const fixture = await McpFixtureServer.start({
      authorizationServerMetadata: (self) => ({
        issuer: self,
        authorization_endpoint: `${self}/authorize`,
        token_endpoint: "http://192.168.0.1/token",
      }),
    });
    const harness = await seed();
    try {
      const loopback = new McpOutboundFetcher({ allowLoopback: true });
      const issuer = fixture.endpoint.replace(/\/mcp$/, "");
      const reader = new McpOAuthClient({ fetcher: loopback, publicUrl: "https://opentag.test" });
      await expect(reader.authorizationServerMetadata(harness.accountId, issuer)).rejects.toThrow(/could not be read/u);
    } finally {
      await fixture.stop();
    }

    // The gate still refuses a private destination that passed the scheme check.
    const httpsFixture = await McpFixtureServer.start({
      authorizationServerMetadata: (self) => ({
        issuer: self,
        authorization_endpoint: `${self}/authorize`,
        token_endpoint: "https://192.168.0.1/token",
      }),
    });
    try {
      const loopback = new McpOutboundFetcher({ allowLoopback: true });
      const issuer = httpsFixture.endpoint.replace(/\/mcp$/, "");
      const reader = new McpOAuthClient({ fetcher: loopback, publicUrl: "https://opentag.test" });
      const metadata = await reader.authorizationServerMetadata(harness.accountId, issuer);
      expect(metadata.tokenEndpoint).toBe("https://192.168.0.1/token");

      const hostedClient = new McpOAuthClient({
        fetcher: new McpOutboundFetcher({ allowLoopback: false }),
        publicUrl: "https://opentag.test",
      });
      await expect(
        hostedClient.exchangeAuthorizationCode(harness.accountId, metadata, {
          code: "x",
          codeVerifier: "v",
          client: { source: "cimd", clientId: "c", tokenEndpointAuthMethod: "none" },
          resource: "https://mcp.example.com/mcp",
        }),
      ).rejects.toMatchObject({ code: MCP_ERROR_CODES.URL_BLOCKED });
    } finally {
      await httpsFixture.stop();
    }
  });

  it("refuses the fixture itself when loopback is not permitted", async () => {
    const fixture = await McpFixtureServer.start();
    const harness = await seed();
    try {
      const hosted = new McpOutboundFetcher({ allowLoopback: false });
      await expect(hosted.fetchOutbound(harness.accountId, fixture.endpoint)).rejects.toMatchObject({
        code: "MCP_URL_BLOCKED",
      });
    } finally {
      await fixture.stop();
    }
  });
});

// ------------------------------------------------------------------ P5: lifecycle

describe("P5 — a soft-deleted Agent releases its mounts", () => {
  it("drops boundAgentCount to zero and lets the definition be deleted", async () => {
    const fixture = await McpFixtureServer.start();
    const harness = await seed();
    try {
      const server = await harness.servers.createServer(harness.accountId, {
        name: "fixture",
        url: fixture.endpoint,
        defaultAuthKind: "bearer",
      });
      await harness.servers.attachServer(harness.accountId, harness.agentA, server.id, true);
      await harness.authorization.setBearerOrNone(harness.accountId, harness.agentA, server.id, {
        kind: "bearer",
        bearerKey: "key_a",
      });
      expect(await countLiveBindings(harness.database, server.id)).toBe(1);

      // The real soft-delete path: the lifecycle requires a suspend first, then the status change.
      await harness.agentService.suspendById(harness.accountId, harness.agentA);
      await harness.agentService.deleteById(harness.accountId, harness.agentA);
      const [deleted] = await harness.database
        .select({ status: agents.status })
        .from(agents)
        .where(eq(agents.id, harness.agentA));
      expect(deleted?.status).toBe("deleted");

      // The mount and its credential are removed with the Agent, not merely ignored: a soft delete is
      // not a cascade, so these rows would otherwise hold a credential the Account can no longer see
      // or revoke through any route.
      const remaining = await harness.database
        .select()
        .from(agentMcpServers)
        .where(eq(agentMcpServers.mcpServerId, server.id));
      expect(remaining).toHaveLength(0);
      const credentials = await harness.database
        .select()
        .from(mcpServerAuthorizations)
        .where(eq(mcpServerAuthorizations.agentId, harness.agentA));
      expect(credentials).toHaveLength(0);
      expect(await countLiveBindings(harness.database, server.id)).toBe(0);

      const listed = await harness.servers.listServers(harness.accountId);
      expect(listed[0]?.boundAgentCount).toBe(0);

      // The delete succeeds rather than answering MCP_SERVER_IN_USE.
      await harness.servers.deleteServer(harness.accountId, server.id);
      const servers = await harness.servers.listServers(harness.accountId);
      expect(servers).toHaveLength(0);
    } finally {
      await fixture.stop();
    }
  });

  it("refuses every MCP path for a soft-deleted Agent", async () => {
    /*
     * S6, the reachability half. `readJoinedBinding` checked only the Server's Account, so a deleted
     * Agent still resolved its mount and its credential — which meant an outbound probe, an OAuth
     * `start`, and a read all worked on behalf of an Agent the Account had retired. The cleanup above
     * removes the rows, and the join now also excludes a deleted Agent, so neither a row that slipped
     * through nor a race can reach a retired Agent's credential.
     */
    const fixture = await McpFixtureServer.start();
    const harness = await seed();
    try {
      const server = await harness.servers.createServer(harness.accountId, {
        name: "fixture",
        url: fixture.endpoint,
        defaultAuthKind: "bearer",
      });
      await harness.servers.attachServer(harness.accountId, harness.agentA, server.id, true);
      await harness.authorization.setBearerOrNone(harness.accountId, harness.agentA, server.id, {
        kind: "bearer",
        bearerKey: "key_a",
      });
      // Confirmed working before the delete, so the refusals below mean something.
      await expect(harness.authorization.probe(harness.accountId, harness.agentA, server.id)).resolves.toMatchObject({
        probeState: "succeeded",
      });

      await harness.agentService.suspendById(harness.accountId, harness.agentA);
      await harness.agentService.deleteById(harness.accountId, harness.agentA);

      /*
       * The cleanup removes the rows, so this test would pass on that alone. The join is the guard for
       * rows that exist anyway — a deployment that predates the cleanup, or a mount created in a race
       * with the delete — so they are re-inserted here to exercise it directly.
       */
      await harness.database
        .insert(agentMcpServers)
        .values({ agentId: harness.agentA, mcpServerId: server.id, enabled: true });

      await expect(harness.servers.readProbeContext(harness.accountId, harness.agentA, server.id)).rejects.toThrow();
      await expect(harness.authorization.probe(harness.accountId, harness.agentA, server.id)).rejects.toThrow();
      await expect(
        harness.flows.start(harness.accountId, harness.agentA, server.id, [], FLOW_SECRET),
      ).rejects.toThrow();
      await expect(harness.servers.readAgentServer(harness.accountId, harness.agentA, server.id)).rejects.toThrow();
    } finally {
      await fixture.stop();
    }
  });

  it("leaves no mount behind for a soft-deleted Agent after an onboarding reset", async () => {
    const fixture = await McpFixtureServer.start();
    const harness = await seed();
    try {
      const server = await harness.servers.createServer(harness.accountId, {
        name: "fixture",
        url: fixture.endpoint,
        defaultAuthKind: "bearer",
      });
      await harness.servers.attachServer(harness.accountId, harness.agentA, server.id, true);
      await harness.authorization.setBearerOrNone(harness.accountId, harness.agentA, server.id, {
        kind: "bearer",
        bearerKey: "key_a",
      });
      await harness.servers.attachServer(harness.accountId, harness.agentB, server.id, true);

      const reset = new OnboardingResetService({
        agents: harness.agentService,
        database: harness.database,
        environment: "staging",
        registry: { closeComputer: async () => true },
      });
      await reset.resetOnboarding(harness.accountId);

      // The verification inside the reset already asserts this; the explicit read is what proves the
      // cleanup happened rather than merely that nothing complained.
      const mounts = await harness.database
        .select()
        .from(agentMcpServers)
        .innerJoin(agents, eq(agents.id, agentMcpServers.agentId))
        .where(eq(agents.createdByUserId, harness.accountId));
      expect(mounts).toHaveLength(0);
      const authorizations = await harness.database
        .select()
        .from(mcpServerAuthorizations)
        .innerJoin(agents, eq(agents.id, mcpServerAuthorizations.agentId))
        .where(eq(agents.createdByUserId, harness.accountId));
      expect(authorizations).toHaveLength(0);

      // The definition itself is kept, matching how the reset already keeps GitHub connections.
      const defined = await harness.database
        .select()
        .from(mcpServers)
        .where(eq(mcpServers.accountId, harness.accountId));
      expect(defined).toHaveLength(1);

      // Nothing references a deleted Agent, so the definition is deletable again.
      await harness.servers.deleteServer(harness.accountId, server.id);
    } finally {
      await fixture.stop();
    }
  });

  it("releases mounts and authorizations for a deleted Agent, keeping the definition", async () => {
    const fixture = await McpFixtureServer.start();
    const harness = await seed();
    try {
      const server = await harness.servers.createServer(harness.accountId, {
        name: "fixture",
        url: fixture.endpoint,
        defaultAuthKind: "bearer",
      });
      await harness.servers.attachServer(harness.accountId, harness.agentA, server.id, true);
      await harness.authorization.setBearerOrNone(harness.accountId, harness.agentA, server.id, {
        kind: "bearer",
        bearerKey: "key_a",
      });
      // A grant exists and counts as live while the Agent is live.
      expect(await countLiveBindings(harness.database, server.id)).toBe(1);

      // Detaching is the explicit "this Agent no longer uses it" action and takes the credential
      // with it, so no usable secret survives for an unmounted Server.
      await harness.servers.detachServer(harness.accountId, harness.agentA, server.id);
      const authorizations = await harness.database
        .select()
        .from(mcpServerAuthorizations)
        .where(eq(mcpServerAuthorizations.mcpServerId, server.id));
      expect(authorizations).toHaveLength(0);
    } finally {
      await fixture.stop();
    }
  });

  it("does not rotate the shared registration when a second Agent starts a flow", async () => {
    /*
     * The reviewer's scenario, and the reason the DCR path needed its own fixture: with CIMD the
     * client is this deployment's URL, so re-registering cannot change it and the bug is invisible.
     *
     * `mcp_client_registrations` is keyed by `(account, issuer)`, so it holds ONE client for the whole
     * Account. When `start` registered unconditionally, the second Agent's start replaced that client
     * — and the first Agent's authorization, which had been requested under the old one, then failed
     * every refresh with `invalid_client`. Authorizing a second Agent silently destroyed the first.
     */
    const fixture = await McpFixtureServer.start({ dynamicRegistrationOnly: true });
    const harness = await seed();
    try {
      const server = await harness.servers.createServer(harness.accountId, {
        name: "fixture",
        url: fixture.endpoint,
        defaultAuthKind: "oauth",
      });
      await harness.servers.attachServer(harness.accountId, harness.agentA, server.id, true);
      await harness.servers.attachServer(harness.accountId, harness.agentB, server.id, true);

      // Agent A completes a full authorization, leaving it active and refreshable.
      const first = await harness.flows.start(harness.accountId, harness.agentA, server.id, [], FLOW_SECRET);
      const firstAuthorize = await fetch(first.authorizationUrl, { redirect: "manual" });
      const firstCallback = new URL(firstAuthorize.headers.get("location") as string);
      await harness.flows.callback(
        {
          code: firstCallback.searchParams.get("code") ?? "",
          state: firstCallback.searchParams.get("state") ?? "",
          iss: firstCallback.searchParams.get("iss") ?? undefined,
        },
        FLOW_SECRET,
      );
      const registrationsAfterFirst = await harness.database
        .select()
        .from(mcpClientRegistrations)
        .where(eq(mcpClientRegistrations.accountId, harness.accountId));
      expect(registrationsAfterFirst).toHaveLength(1);
      const clientForA = registrationsAfterFirst[0]?.clientId;

      // Agent B starts a flow at the same issuer. This is the second `start` that used to rotate the row.
      await harness.flows.start(harness.accountId, harness.agentB, server.id, [], FLOW_SECRET);
      const registrationsAfterSecond = await harness.database
        .select()
        .from(mcpClientRegistrations)
        .where(eq(mcpClientRegistrations.accountId, harness.accountId));

      // Still one row, still the client Agent A authorized under, and only one registration was made.
      expect(registrationsAfterSecond).toHaveLength(1);
      expect(registrationsAfterSecond[0]?.clientId).toBe(clientForA);
      expect(fixture.registrations).toBe(1);

      // And Agent A's existing authorization still refreshes: the failure this prevents is terminal.
      await harness.database
        .update(mcpServerAuthorizations)
        .set({ accessTokenExpiresAt: new Date(0) })
        .where(eq(mcpServerAuthorizations.agentId, harness.agentA));
      const passes = await harness.refresh.runOnce();
      expect(passes).toBe(1);
      const [rowA] = await harness.database
        .select()
        .from(mcpServerAuthorizations)
        .where(eq(mcpServerAuthorizations.agentId, harness.agentA));
      expect(rowA?.status).toBe("active");
    } finally {
      await fixture.stop();
    }
  });

  it("keeps a client registration when its referencing Server is deleted", async () => {
    // DCR: the row is the thing this test is about, and CIMD deliberately stores none.
    const fixture = await McpFixtureServer.start({ dynamicRegistrationOnly: true });
    const harness = await seed();
    try {
      const server = await harness.servers.createServer(harness.accountId, {
        name: "fixture",
        url: fixture.endpoint,
        defaultAuthKind: "oauth",
      });
      await harness.servers.attachServer(harness.accountId, harness.agentA, server.id, true);
      await harness.flows.start(harness.accountId, harness.agentA, server.id, [], FLOW_SECRET);
      const before = await harness.database
        .select()
        .from(mcpClientRegistrations)
        .where(eq(mcpClientRegistrations.accountId, harness.accountId));
      expect(before).toHaveLength(1);

      await harness.servers.detachServer(harness.accountId, harness.agentA, server.id);
      await harness.servers.deleteServer(harness.accountId, server.id);

      // The registration is the Account's asset at that issuer, not the Server's: it is reusable by
      // every Server that resolves there, so deleting one Server must not discard it.
      const after = await harness.database
        .select()
        .from(mcpClientRegistrations)
        .where(eq(mcpClientRegistrations.accountId, harness.accountId));
      expect(after).toHaveLength(1);
    } finally {
      await fixture.stop();
    }
  });
});

// ------------------------------------------------------------------ effective values

describe("Agent-level overrides", () => {
  it("sends Agent A to its overridden URL and Agent B to the shared one", async () => {
    const overridden = await McpFixtureServer.start();
    const shared = await McpFixtureServer.start();
    const harness = await seed();
    try {
      const server = await harness.servers.createServer(harness.accountId, {
        name: "fixture",
        url: shared.endpoint,
        defaultAuthKind: "none",
      });
      await harness.servers.attachServer(harness.accountId, harness.agentA, server.id, true);
      await harness.servers.attachServer(harness.accountId, harness.agentB, server.id, true);
      await harness.servers.updateBinding(harness.accountId, harness.agentA, server.id, { url: overridden.endpoint });

      const forA = await harness.servers.listAgentServers(harness.accountId, harness.agentA);
      const forB = await harness.servers.listAgentServers(harness.accountId, harness.agentB);
      expect(forA[0]?.effective.url).toBe(overridden.endpoint);
      expect(forA[0]?.overridden.url).toBe(true);
      expect(forB[0]?.effective.url).toBe(shared.endpoint);
      expect(forB[0]?.overridden.url).toBe(false);

      // Probing follows the effective value, so the two Agents genuinely reach different origins.
      await harness.authorization.probe(harness.accountId, harness.agentA, server.id);
      await harness.authorization.probe(harness.accountId, harness.agentB, server.id);
      expect(overridden.requestsFor("server/discover").length).toBeGreaterThan(0);
      expect(shared.requestsFor("server/discover").length).toBeGreaterThan(0);
    } finally {
      await overridden.stop();
      await shared.stop();
    }
  });

  it("distinguishes restoring inheritance from overriding with nothing", async () => {
    const harness = await seed();
    const shared = await McpFixtureServer.start();
    try {
      const server = await harness.servers.createServer(harness.accountId, {
        name: "fixture",
        url: shared.endpoint,
        defaultAuthKind: "none",
        extraHeaders: { "x-workspace-id": "shared" },
      });
      await harness.servers.attachServer(harness.accountId, harness.agentA, server.id, true);

      // Inherited first.
      let entry = (await harness.servers.listAgentServers(harness.accountId, harness.agentA))[0];
      expect(entry?.effective.extraHeaders).toEqual({ "x-workspace-id": "shared" });
      expect(entry?.overridden.extraHeaders).toBe(false);

      // Override with nothing: the Agent now sends no extra headers at all, while the shared set is
      // untouched for every other Agent.
      await harness.servers.updateBinding(harness.accountId, harness.agentA, server.id, { emptyExtraHeaders: true });
      entry = (await harness.servers.listAgentServers(harness.accountId, harness.agentA))[0];
      expect(entry?.effective.extraHeaders).toEqual({});
      expect(entry?.overridden.extraHeaders).toBe(true);
      const definition = await harness.servers.listServers(harness.accountId);
      expect(definition[0]?.extraHeaders).toEqual({ "x-workspace-id": "shared" });

      // Restore inheritance: a different action with a different result.
      await harness.servers.updateBinding(harness.accountId, harness.agentA, server.id, { clearExtraHeaders: true });
      entry = (await harness.servers.listAgentServers(harness.accountId, harness.agentA))[0];
      expect(entry?.effective.extraHeaders).toEqual({ "x-workspace-id": "shared" });
      expect(entry?.overridden.extraHeaders).toBe(false);
    } finally {
      await shared.stop();
    }
  });

  it("treats an empty authorization scheme as a legitimate override", async () => {
    const fixture = await McpFixtureServer.start();
    const harness = await seed();
    try {
      const server = await harness.servers.createServer(harness.accountId, {
        name: "fixture",
        url: fixture.endpoint,
        defaultAuthKind: "bearer",
        authScheme: "Bearer",
      });
      await harness.servers.attachServer(harness.accountId, harness.agentA, server.id, true);
      await harness.authorization.setBearerOrNone(harness.accountId, harness.agentA, server.id, {
        kind: "bearer",
        bearerKey: "key_a",
      });
      await harness.servers.updateBinding(harness.accountId, harness.agentA, server.id, { authScheme: "" });

      const entry = (await harness.servers.listAgentServers(harness.accountId, harness.agentA))[0];
      // Empty is a value, not an absence: it must not fall back to `Bearer`.
      expect(entry?.effective.authScheme).toBe("");
      expect(entry?.overridden.authScheme).toBe(true);
      const headers = await harness.authorization.buildHeaders(harness.accountId, harness.agentA, server.id);
      expect(headers.authorization).toBe("key_a");
    } finally {
      await fixture.stop();
    }
  });

  it("re-probes only the Agent whose override changed, and every Agent for a shared edit", async () => {
    const fixture = await McpFixtureServer.start();
    const harness = await seed();
    try {
      const server = await harness.servers.createServer(harness.accountId, {
        name: "fixture",
        url: fixture.endpoint,
        defaultAuthKind: "bearer",
      });
      await harness.servers.attachServer(harness.accountId, harness.agentA, server.id, true);
      await harness.servers.attachServer(harness.accountId, harness.agentB, server.id, true);
      for (const agentId of [harness.agentA, harness.agentB]) {
        await harness.authorization.setBearerOrNone(harness.accountId, agentId, server.id, {
          kind: "bearer",
          bearerKey: `key_${agentId}`,
        });
        await harness.authorization.probe(harness.accountId, agentId, server.id);
      }
      const afterProbe = async () => {
        const rows = await harness.database
          .select({ agentId: mcpServerAuthorizations.agentId, probeState: mcpServerAuthorizations.probeState })
          .from(mcpServerAuthorizations)
          .where(eq(mcpServerAuthorizations.mcpServerId, server.id));
        return new Map(rows.map((row) => [row.agentId, row.probeState]));
      };
      expect([...(await afterProbe()).values()]).toEqual(["succeeded", "succeeded"]);

      // An Agent-level override re-probes just that Agent.
      await harness.servers.updateBinding(harness.accountId, harness.agentA, server.id, { authScheme: "Token" });
      let states = await afterProbe();
      expect(states.get(harness.agentA)).toBe("pending");
      expect(states.get(harness.agentB)).toBe("succeeded");

      // A shared-definition edit re-probes every mount.
      const definition = (await harness.servers.listServers(harness.accountId))[0];
      await harness.servers.updateServer(harness.accountId, server.id, {
        expectedRevision: definition?.revision as number,
        authScheme: "Bearer",
      });
      states = await afterProbe();
      expect(states.get(harness.agentA)).toBe("pending");
      expect(states.get(harness.agentB)).toBe("pending");

      /*
       * S5: the background pass actually runs them.
       *
       * `markProbesPending` promised "a background pass re-probes them" and no such pass existed, so
       * these rows stayed pending until somebody clicked Re-probe — and a freshly authorized row stayed
       * pending forever, which is also why `mcp authorize` could never finish its wait.
       */
      await harness.refresh.runOnce();
      states = await afterProbe();
      expect(states.get(harness.agentA)).toBe("succeeded");
      expect(states.get(harness.agentB)).toBe("succeeded");
    } finally {
      await fixture.stop();
    }
  });

  it("drops the cached protocol era when the effective endpoint changes", async () => {
    const first = await McpFixtureServer.start();
    const second = await McpFixtureServer.start();
    const harness = await seed();
    try {
      const server = await harness.servers.createServer(harness.accountId, {
        name: "fixture",
        url: first.endpoint,
        defaultAuthKind: "bearer",
      });
      await harness.servers.attachServer(harness.accountId, harness.agentA, server.id, true);
      await harness.servers.attachServer(harness.accountId, harness.agentB, server.id, true);
      for (const agentId of [harness.agentA, harness.agentB]) {
        await harness.authorization.setBearerOrNone(harness.accountId, agentId, server.id, {
          kind: "bearer",
          bearerKey: `key_${agentId}`,
        });
        await harness.authorization.probe(harness.accountId, agentId, server.id);
      }
      const eraOf = async (agentId: string) => {
        const [row] = await harness.database
          .select()
          .from(mcpServerAuthorizations)
          .where(and(eq(mcpServerAuthorizations.mcpServerId, server.id), eq(mcpServerAuthorizations.agentId, agentId)));
        return { era: row?.protocolEra, version: row?.protocolVersion };
      };
      expect(await eraOf(harness.agentA)).toEqual({ era: "modern", version: "2026-07-28" });

      // A shared endpoint change moves the origin for every mount, so every cached era must go.
      const definition = (await harness.servers.listServers(harness.accountId))[0];
      await harness.servers.updateServer(harness.accountId, server.id, {
        expectedRevision: definition?.revision as number,
        url: second.endpoint,
      });
      expect(await eraOf(harness.agentA)).toEqual({ era: null, version: null });
      expect(await eraOf(harness.agentB)).toEqual({ era: null, version: null });

      // Re-probing at the new origin caches the new era rather than reusing the old one.
      await harness.authorization.probe(harness.accountId, harness.agentA, server.id);
      expect((await eraOf(harness.agentA)).era).toBe("modern");
      expect(second.requestsFor("server/discover").length).toBeGreaterThan(0);
    } finally {
      await first.stop();
      await second.stop();
    }
  }, 30_000);

  it("refuses a protected-resource document that names a different endpoint", async () => {
    /*
     * S3. The advertised `resource` becomes the authorization request's `resource` while the token
     * request sends the endpoint, so a Server allowed to advertise something else could have this
     * deployment obtain a token for a *different* resource server at a shared authorization server —
     * and the two requests would disagree about what they were asking for.
     *
     * RFC 9728 §3.3 requires the document to name the resource it describes, so a mismatch is refused
     * at discovery and `start` fails rather than proceeding.
     */
    const fixture = await McpFixtureServer.start({
      protectedResourceMetadata: (self) => ({
        // A usable issuer is offered, so the *only* thing wrong is the resource name — otherwise the
        // test would pass because discovery found nothing, not because the check under test fired.
        resource: "https://other.example.com/mcp",
        authorization_servers: [self],
      }),
    });
    const harness = await seed();
    try {
      const server = await harness.servers.createServer(harness.accountId, {
        name: "fixture",
        url: fixture.endpoint,
        defaultAuthKind: "oauth",
      });
      await harness.servers.attachServer(harness.accountId, harness.agentA, server.id, true);
      await expect(
        harness.flows.start(harness.accountId, harness.agentA, server.id, [], FLOW_SECRET),
      ).rejects.toThrow();
    } finally {
      await fixture.stop();
    }
  }, 30_000);

  it("revokes an OAuth credential when the endpoint moves to a new origin", async () => {
    /*
     * S2. An access token is issued for one resource, and the AS's `resource` binding is what stops it
     * being presented elsewhere — the specification forbids the reuse this would have allowed. A Bearer
     * key is left alone, because nothing binds it to an origin.
     */
    const first = await McpFixtureServer.start();
    const second = await McpFixtureServer.start();
    const harness = await seed();
    try {
      const server = await harness.servers.createServer(harness.accountId, {
        name: "fixture",
        url: first.endpoint,
        defaultAuthKind: "oauth",
      });
      await harness.servers.attachServer(harness.accountId, harness.agentA, server.id, true);
      await harness.servers.attachServer(harness.accountId, harness.agentB, server.id, true);

      // Agent A holds an OAuth token; Agent B holds a Bearer key.
      const started = await harness.flows.start(harness.accountId, harness.agentA, server.id, [], FLOW_SECRET);
      const authorize = await fetch(started.authorizationUrl, { redirect: "manual" });
      const callback = new URL(authorize.headers.get("location") as string);
      await harness.flows.callback(
        {
          code: callback.searchParams.get("code") ?? "",
          state: callback.searchParams.get("state") ?? "",
          iss: callback.searchParams.get("iss") ?? undefined,
        },
        FLOW_SECRET,
      );
      await harness.authorization.setBearerOrNone(harness.accountId, harness.agentB, server.id, {
        kind: "bearer",
        bearerKey: "key_b",
      });

      const stateOf = async (agentId: string) => {
        const [row] = await harness.database
          .select()
          .from(mcpServerAuthorizations)
          .where(and(eq(mcpServerAuthorizations.mcpServerId, server.id), eq(mcpServerAuthorizations.agentId, agentId)));
        return row;
      };
      expect((await stateOf(harness.agentA))?.status).toBe("active");

      // A different origin: the token was issued for the old resource and must not follow.
      const definition = (await harness.servers.listServers(harness.accountId))[0];
      await harness.servers.updateServer(harness.accountId, server.id, {
        expectedRevision: definition?.revision as number,
        url: second.endpoint,
      });

      const moved = await stateOf(harness.agentA);
      expect(moved?.status).toBe("revoked");
      expect(moved?.ciphertext).toBeNull();
      // The Bearer key is untouched: it is not bound to an origin, and dropping it would be a surprise.
      const bearer = await stateOf(harness.agentB);
      expect(bearer?.status).toBe("active");
      expect(bearer?.ciphertext).not.toBeNull();
    } finally {
      await first.stop();
      await second.stop();
    }
  }, 30_000);

  it("does not let a flow started before an origin change authorize the new origin", async () => {
    /*
     * The reviewer's ordering case. `markProbesPending` dropped the credential but left the flow
     * columns alone, so a callback already in flight still resolved the row — `#redeemCode` is fenced
     * on `state`, which nobody had cleared — and wrote `status: active` with a token minted by the OLD
     * authorization server. The row then claimed to be authorized against the new origin with a
     * credential issued for the old one, which is the reuse the specification forbids and the reason
     * the credential is dropped at all.
     */
    const first = await McpFixtureServer.start();
    const second = await McpFixtureServer.start();
    const harness = await seed();
    try {
      const server = await harness.servers.createServer(harness.accountId, {
        name: "fixture",
        url: first.endpoint,
        defaultAuthKind: "oauth",
      });
      await harness.servers.attachServer(harness.accountId, harness.agentA, server.id, true);

      // A flow is started and left open; the URL changes while its consent screen would be up.
      const started = await harness.flows.start(harness.accountId, harness.agentA, server.id, [], FLOW_SECRET);
      const authorize = await fetch(started.authorizationUrl, { redirect: "manual" });
      const callback = new URL(authorize.headers.get("location") as string);
      const definition = (await harness.servers.listServers(harness.accountId))[0];
      await harness.servers.updateServer(harness.accountId, server.id, {
        expectedRevision: definition?.revision as number,
        url: second.endpoint,
      });

      // The callback now has nothing to land on: its flow was cleared by the origin change.
      await expect(
        harness.flows.callback(
          {
            code: callback.searchParams.get("code") ?? "",
            state: callback.searchParams.get("state") ?? "",
            iss: callback.searchParams.get("iss") ?? undefined,
          },
          FLOW_SECRET,
        ),
      ).rejects.toMatchObject({ code: MCP_ERROR_CODES.OAUTH_FLOW_INVALID });

      const [row] = await harness.database
        .select()
        .from(mcpServerAuthorizations)
        .where(eq(mcpServerAuthorizations.agentId, harness.agentA));
      expect(row?.status).not.toBe("active");
      expect(row?.ciphertext).toBeNull();
    } finally {
      await first.stop();
      await second.stop();
    }
  }, 30_000);

  it("drops a probe result that lost the race against a newer write", async () => {
    /*
     * S4. The probe takes an upstream round trip and its write was keyed only on `(agent, server)`, so
     * a slow result landed on whatever the row had become: revoking and immediately re-probing brought
     * back `succeeded` and a tool snapshot on the revoked row.
     *
     * The row has to change *during* the probe for this to be the real race, so the fixture holds the
     * upstream request open until the newer write has landed. Racing two promises without that would
     * pass or fail on timing rather than on the fence.
     */
    const race: { harness?: Awaited<ReturnType<typeof seed>>; serverId?: string; release?: () => void } = {};
    const held = new Promise<void>((resolve) => {
      race.release = resolve;
    });
    const fixture = await McpFixtureServer.start({
      onMcpRequest: async () => {
        // The probe is now in flight; change the row, then let it finish.
        if (race.harness && race.serverId) {
          await race.harness.authorization.setBearerOrNone(race.harness.accountId, race.harness.agentA, race.serverId, {
            kind: "bearer",
            bearerKey: "key_b",
          });
        }
        await held;
      },
    });
    const harness = await seed();
    race.harness = harness;
    try {
      const server = await harness.servers.createServer(harness.accountId, {
        name: "fixture",
        url: fixture.endpoint,
        defaultAuthKind: "bearer",
      });
      await harness.servers.attachServer(harness.accountId, harness.agentA, server.id, true);
      race.serverId = server.id;
      await harness.authorization.setBearerOrNone(harness.accountId, harness.agentA, server.id, {
        kind: "bearer",
        bearerKey: "key_a",
      });
      const [before] = await harness.database
        .select()
        .from(mcpServerAuthorizations)
        .where(eq(mcpServerAuthorizations.agentId, harness.agentA));

      // The probe runs against the current revision; the row changes while it is in flight.
      const probe = harness.authorization.probe(harness.accountId, harness.agentA, server.id);
      race.release?.();
      await probe;

      const [after] = await harness.database
        .select()
        .from(mcpServerAuthorizations)
        .where(eq(mcpServerAuthorizations.agentId, harness.agentA));
      // The newer write's revision stands, and the stale result did not overwrite its probe state.
      expect(after?.revision).toBeGreaterThan(before?.revision as number);
      expect(after?.probeState).toBe("pending");
      expect(after?.probedAt).toBeNull();
    } finally {
      await fixture.stop();
    }
  }, 30_000);

  it("drops only the overriding Agent's cached era when its URL override changes", async () => {
    const shared = await McpFixtureServer.start();
    const overridden = await McpFixtureServer.start();
    const harness = await seed();
    try {
      const server = await harness.servers.createServer(harness.accountId, {
        name: "fixture",
        url: shared.endpoint,
        defaultAuthKind: "bearer",
      });
      await harness.servers.attachServer(harness.accountId, harness.agentA, server.id, true);
      await harness.servers.attachServer(harness.accountId, harness.agentB, server.id, true);
      for (const agentId of [harness.agentA, harness.agentB]) {
        await harness.authorization.setBearerOrNone(harness.accountId, agentId, server.id, {
          kind: "bearer",
          bearerKey: `key_${agentId}`,
        });
        await harness.authorization.probe(harness.accountId, agentId, server.id);
      }
      const eraOf = async (agentId: string) => {
        const [row] = await harness.database
          .select({ era: mcpServerAuthorizations.protocolEra })
          .from(mcpServerAuthorizations)
          .where(and(eq(mcpServerAuthorizations.mcpServerId, server.id), eq(mcpServerAuthorizations.agentId, agentId)));
        return row?.era;
      };

      // Agent A's own endpoint moves, so only Agent A's era is stale.
      await harness.servers.updateBinding(harness.accountId, harness.agentA, server.id, { url: overridden.endpoint });
      expect(await eraOf(harness.agentA)).toBeNull();
      expect(await eraOf(harness.agentB)).toBe("modern");

      // Renaming the authorization header is not an origin change, so it must not drop the era.
      await harness.servers.updateBinding(harness.accountId, harness.agentB, server.id, { authScheme: "Token" });
      expect(await eraOf(harness.agentB)).toBe("modern");
    } finally {
      await shared.stop();
      await overridden.stop();
    }
  }, 30_000);

  it("counts only active credentials as authorized", async () => {
    const fixture = await McpFixtureServer.start();
    const harness = await seed();
    try {
      const server = await harness.servers.createServer(harness.accountId, {
        name: "fixture",
        url: fixture.endpoint,
        defaultAuthKind: "bearer",
      });
      await harness.servers.attachServer(harness.accountId, harness.agentA, server.id, true);
      await harness.servers.attachServer(harness.accountId, harness.agentB, server.id, true);
      for (const agentId of [harness.agentA, harness.agentB]) {
        await harness.authorization.setBearerOrNone(harness.accountId, agentId, server.id, {
          kind: "bearer",
          bearerKey: `key_${agentId}`,
        });
      }
      expect((await harness.servers.listServers(harness.accountId))[0]?.authorizedAgentCount).toBe(2);

      // A revoked credential is not authorization, so the count must fall even though the row exists.
      await harness.authorization.revoke(harness.accountId, harness.agentA, server.id);
      expect((await harness.servers.listServers(harness.accountId))[0]?.authorizedAgentCount).toBe(1);
      // The mount is untouched: revoking is about the credential, not about the Server.
      expect((await harness.servers.listServers(harness.accountId))[0]?.boundAgentCount).toBe(2);
    } finally {
      await fixture.stop();
    }
  });

  it("exposes the per-Agent protocol era in the Server detail matrix", async () => {
    const fixture = await McpFixtureServer.start();
    const harness = await seed();
    try {
      const server = await harness.servers.createServer(harness.accountId, {
        name: "fixture",
        url: fixture.endpoint,
        defaultAuthKind: "bearer",
      });
      await harness.servers.attachServer(harness.accountId, harness.agentA, server.id, true);
      await harness.authorization.setBearerOrNone(harness.accountId, harness.agentA, server.id, {
        kind: "bearer",
        bearerKey: "key_a",
      });
      await harness.authorization.probe(harness.accountId, harness.agentA, server.id);

      const detail = await harness.servers.getServerDetail(harness.accountId, server.id);
      const row = detail.agents.find((agent) => agent.agentId === harness.agentA);
      expect(row?.protocolEra).toBe("modern");
      expect(row?.protocolVersion).toBe("2026-07-28");
    } finally {
      await fixture.stop();
    }
  });

  it("does not advance the definition revision when a probe writes", async () => {
    const fixture = await McpFixtureServer.start();
    const harness = await seed();
    try {
      const server = await harness.servers.createServer(harness.accountId, {
        name: "fixture",
        url: fixture.endpoint,
        defaultAuthKind: "bearer",
      });
      await harness.servers.attachServer(harness.accountId, harness.agentA, server.id, true);
      await harness.authorization.setBearerOrNone(harness.accountId, harness.agentA, server.id, {
        kind: "bearer",
        bearerKey: "key_a",
      });
      await harness.authorization.probe(harness.accountId, harness.agentA, server.id);

      // A user edit fenced on the revision captured before the probe must still succeed: the probe
      // wrote only the authorization row, so it never invalidated the editor's `expectedRevision`.
      await harness.servers.updateServer(harness.accountId, server.id, {
        expectedRevision: server.revision,
      });
      const [row] = await harness.database.select().from(mcpServers).where(eq(mcpServers.id, server.id));
      expect(row?.revision).toBe(server.revision + 1);
    } finally {
      await fixture.stop();
    }
  });
});

// ------------------------------------------------------------------ constraints

describe("datastore constraints", () => {
  it("refuses a second authorization row for one (Server, Agent) pair", async () => {
    const harness = await seed();
    const fixture = await McpFixtureServer.start();
    try {
      const server = await harness.servers.createServer(harness.accountId, {
        name: "fixture",
        url: fixture.endpoint,
        defaultAuthKind: "none",
      });
      await harness.servers.attachServer(harness.accountId, harness.agentA, server.id, true);

      // The auto-created `none` row is the pair's one row, so a raw insert of a second must fail.
      await expect(
        harness.database.insert(mcpServerAuthorizations).values({
          agentId: harness.agentA,
          mcpServerId: server.id,
          kind: "none",
          status: "active",
        }),
      ).rejects.toThrow();
    } finally {
      await fixture.stop();
    }
  });

  it("creates an anonymous authorization row when mounting a none-default Server", async () => {
    const fixture = await McpFixtureServer.start();
    const harness = await seed();
    try {
      const server = await harness.servers.createServer(harness.accountId, {
        name: "fixture",
        url: fixture.endpoint,
        defaultAuthKind: "none",
      });
      const mounted = await harness.servers.attachServer(harness.accountId, harness.agentA, server.id, true);
      // Mounting is enough: a `none` Server is usable with no further step.
      expect(mounted.authorization?.kind).toBe("none");
      expect(mounted.authorization?.status).toBe("active");
      expect(mounted.authorization?.hasCredential).toBe(false);
    } finally {
      await fixture.stop();
    }
  });

  it("allows mounting a Server before it is authorized", async () => {
    const fixture = await McpFixtureServer.start();
    const harness = await seed();
    try {
      const server = await harness.servers.createServer(harness.accountId, {
        name: "fixture",
        url: fixture.endpoint,
        defaultAuthKind: "oauth",
      });
      const mounted = await harness.servers.attachServer(harness.accountId, harness.agentA, server.id, true);
      // No authorization row yet; the mount is still valid and the page shows "awaiting authorization".
      expect(mounted.authorization).toBeNull();
      expect(mounted.enabled).toBe(true);
    } finally {
      await fixture.stop();
    }
  });

  it("rejects deleting a definition that a live Agent still mounts", async () => {
    const fixture = await McpFixtureServer.start();
    const harness = await seed();
    try {
      const server = await harness.servers.createServer(harness.accountId, {
        name: "fixture",
        url: fixture.endpoint,
        defaultAuthKind: "none",
      });
      await harness.servers.attachServer(harness.accountId, harness.agentA, server.id, true);
      await expect(harness.servers.deleteServer(harness.accountId, server.id)).rejects.toMatchObject({
        code: "MCP_SERVER_IN_USE",
      });
    } finally {
      await fixture.stop();
    }
  });

  it("enforces the lowercased header-name token rule at the datastore", async () => {
    const harness = await seed();
    const base = {
      accountId: harness.accountId,
      url: "https://mcp.example.com/mcp",
    };
    // Uppercase is refused: the column is stored lowercase so two spellings cannot both exist.
    await expect(
      harness.database.insert(mcpServers).values({ ...base, name: "a", authHeader: "Authorization" }),
    ).rejects.toThrow();
    // So is a CR/LF, which could otherwise be smuggled into an outbound request.
    await expect(
      harness.database.insert(mcpServers).values({ ...base, name: "b", authHeader: "x-key\nInjected" }),
    ).rejects.toThrow();
    await expect(harness.database.insert(mcpServers).values({ ...base, name: "c", authHeader: "" })).rejects.toThrow();
    await expect(
      harness.database.insert(mcpServers).values({ ...base, name: "d", authHeader: "x-api-key" }),
    ).resolves.toBeDefined();
  });

  it("refuses a snapshot that would push the Account past its stored-tool bound", async () => {
    /*
     * The bound is lowered for this test rather than planting 64 MiB of fixture data: the subject is
     * the comparison and the failure it produces, not the size of the constant.
     */
    // Agent A's planted snapshot is roughly 900 stored bytes; the budget sits just below what
    // Agent B's 40-tool snapshot would add on top of it.
    const harness = await seed({ a: "agent-a", b: "agent-b" }, 2000);
    // The fixture answers tools/list with this page, so Agent B's snapshot is genuinely oversized.
    const fixture = await McpFixtureServer.start({
      toolPages: [{ tools: Array.from({ length: 40 }, (_, index) => ({ name: `b${index}`, description: "d" })) }],
    });
    try {
      const server = await harness.servers.createServer(harness.accountId, {
        name: "fixture",
        url: fixture.endpoint,
        defaultAuthKind: "none",
      });
      await harness.servers.attachServer(harness.accountId, harness.agentA, server.id, true);
      await harness.servers.attachServer(harness.accountId, harness.agentB, server.id, true);

      // Agent B's snapshot is small enough to store.
      const tool = (name: string) => ({ name, description: "d" });
      const [rowA] = await harness.database
        .select()
        .from(mcpServerAuthorizations)
        .where(
          and(eq(mcpServerAuthorizations.mcpServerId, server.id), eq(mcpServerAuthorizations.agentId, harness.agentA)),
        );
      expect(rowA?.kind).toBe("none");

      // Agent A already holds a stored snapshot that consumes most of the (lowered) budget.
      await harness.database
        .update(mcpServerAuthorizations)
        .set({
          tools: Array.from({ length: 20 }, (_, index) => tool(`a${index}`)),
          toolsCount: 20,
          probeState: "succeeded",
        })
        .where(eq(mcpServerAuthorizations.id, rowA?.id as string));

      // Agent B's probe returns more tools than the Account has room left for, so it must fail
      // rather than be stored.
      const probe = await harness.authorization.probe(harness.accountId, harness.agentB, server.id);
      expect(probe.probeState).toBe("failed");
      expect(probe.probeError).toContain("64 MiB");

      const [rowB] = await harness.database
        .select()
        .from(mcpServerAuthorizations)
        .where(
          and(eq(mcpServerAuthorizations.mcpServerId, server.id), eq(mcpServerAuthorizations.agentId, harness.agentB)),
        );
      expect(rowB?.probeState).toBe("failed");
      expect(rowB?.tools).toBeNull();

      // Agent A's snapshot survives: refusing one Agent's write must not disturb another's.
      const [afterA] = await harness.database
        .select()
        .from(mcpServerAuthorizations)
        .where(eq(mcpServerAuthorizations.id, rowA?.id as string));
      expect(afterA?.toolsCount).toBe(20);
    } finally {
      await fixture.stop();
    }
  });

  it("keeps a unique Account-scoped Server name, case-insensitively", async () => {
    const harness = await seed();
    const base = { url: "https://mcp.example.com/mcp", defaultAuthKind: "oauth" } as const;
    await harness.database.insert(mcpServers).values({ ...base, accountId: harness.accountId, name: "linear" });
    await expect(
      harness.database.insert(mcpServers).values({ ...base, accountId: harness.accountId, name: "LINEAR" }),
    ).rejects.toThrow();
  });
});

describe("refresh worker scan", () => {
  it("excludes a soft-deleted Agent from the refresh scan", async () => {
    const fixture = await McpFixtureServer.start();
    const harness = await seed();
    try {
      const server = await harness.servers.createServer(harness.accountId, {
        name: "fixture",
        url: fixture.endpoint,
        defaultAuthKind: "oauth",
      });
      await harness.servers.attachServer(harness.accountId, harness.agentA, server.id, true);
      const started = await harness.flows.start(harness.accountId, harness.agentA, server.id, [], FLOW_SECRET);
      const authorize = await fetch(started.authorizationUrl, { redirect: "manual" });
      const callback = new URL(authorize.headers.get("location") as string);
      await harness.flows.callback(
        {
          code: callback.searchParams.get("code") ?? "",
          state: callback.searchParams.get("state") ?? "",
          iss: callback.searchParams.get("iss") ?? undefined,
        },
        FLOW_SECRET,
      );
      await harness.database
        .update(mcpServerAuthorizations)
        .set({ accessTokenExpiresAt: new Date(0) })
        .where(eq(mcpServerAuthorizations.mcpServerId, server.id));

      // A live Agent is refreshed.
      expect(await harness.refresh.runOnce()).toBe(1);

      await harness.database
        .update(mcpServerAuthorizations)
        .set({ accessTokenExpiresAt: new Date(0) })
        .where(eq(mcpServerAuthorizations.mcpServerId, server.id));
      await harness.agentService.suspendById(harness.accountId, harness.agentA);
      await harness.agentService.deleteById(harness.accountId, harness.agentA);
      // A deleted Agent's credential is no longer renewed: there is nothing left to renew it for.
      expect(await harness.refresh.runOnce()).toBe(0);
    } finally {
      await fixture.stop();
    }
  }, 30_000);
});
