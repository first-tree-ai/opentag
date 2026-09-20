import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agentMcpServers, agents, mcpServerAuthorizations, mcpServers, users } from "../db/schema/index.js";
import { ApplicationCipher } from "../services/crypto.js";
import { MCP_ERROR_CODES } from "../services/mcp/errors.js";
import { McpAuthorizationService } from "../services/mcp/mcp-authorization-service.js";
import { McpCredentialCipher } from "../services/mcp/mcp-credential-cipher.js";
import type { McpProbe, McpProbeResult } from "../services/mcp/mcp-probe.js";
import { McpServerService } from "../services/mcp/mcp-server-service.js";
import { createUnitDatabase, type UnitDatabase } from "./support/unit-database.js";

/**
 * Per-Agent authorization: which row decides an Agent's access, what a probe writes on it, and what
 * a caller can read back.
 *
 * Resolution, the probe writes, and the snapshot budget are all statements against a real database —
 * the budget is a `pg_column_size` sum, and the probe writes are revision-fenced CAS updates — so
 * these run on the shared PGlite instance rather than a stubbed builder. The probe itself is a fake:
 * the probing protocol has its own suite, and what matters here is what the service does with the
 * answer it returns.
 */

let unit: UnitDatabase;
beforeAll(async () => {
  unit = await createUnitDatabase();
}, 60_000);
afterAll(async () => unit?.close());
beforeEach(async () => {
  await unit.reset();
});

const ACCOUNT_SNAPSHOT_BOUND = 4096;

interface Harness {
  authorization: McpAuthorizationService;
  cipher: McpCredentialCipher;
  probe: { probe: ReturnType<typeof vi.fn> };
  servers: McpServerService;
}

function build(options: { now?: () => Date; accountSnapshotMaxBytes?: number } = {}): Harness {
  const cipher = new McpCredentialCipher(new ApplicationCipher(new Uint8Array(32).fill(7)));
  const servers = new McpServerService({ database: unit.database });
  const probe = { probe: vi.fn() };
  const authorization = new McpAuthorizationService({
    database: unit.database,
    cipher,
    probe: probe as unknown as McpProbe,
    servers,
    accountSnapshotMaxBytes: options.accountSnapshotMaxBytes ?? ACCOUNT_SNAPSHOT_BOUND,
    ...options,
  });
  return { authorization, cipher, probe, servers };
}

const DEFINITION = { name: "docs", url: "https://mcp.example.test/api", defaultAuthKind: "oauth" as const };

interface Seeded {
  accountId: string;
  agentId: string;
  mcpServerId: string;
}

async function seed(definition: Partial<typeof mcpServers.$inferInsert> = {}): Promise<Seeded> {
  const accountId = randomUUID();
  await unit.database
    .insert(users)
    .values({ id: accountId, email: `${accountId}@example.test`, displayName: "MCP owner" });
  const agentId = randomUUID();
  await unit.database.insert(agents).values({
    id: agentId,
    createdByUserId: accountId,
    name: `agent-${agentId.slice(0, 8)}`,
    displayName: "MCP Agent",
    runtimeProvider: "codex",
  });
  const [server] = await unit.database
    .insert(mcpServers)
    .values({ accountId, name: `docs-${agentId.slice(0, 8)}`, ...DEFINITION, ...definition })
    .returning();
  await unit.database.insert(agentMcpServers).values({ agentId, mcpServerId: server?.id as string });
  return { accountId, agentId, mcpServerId: server?.id as string };
}

async function readRow(ids: Seeded) {
  const [row] = await unit.database
    .select()
    .from(mcpServerAuthorizations)
    .where(eq(mcpServerAuthorizations.agentId, ids.agentId));
  return row;
}

/** A probe answer that succeeded, with the fields the service persists. */
function probeSuccess(overrides: Partial<McpProbeResult> = {}): McpProbeResult {
  const tools = [{ name: "read", description: null, inputSchema: { type: "object" } }];
  return {
    probeState: "succeeded",
    protocolEra: "modern",
    protocolVersion: "2026-07-28",
    serverInfo: { name: "fixture", version: "1", description: "A fixture" },
    capabilities: { tools: {} },
    instructions: "Be careful.",
    tools,
    toolsCount: tools.length,
    toolsTruncated: false,
    probeError: null,
    eraInvalidated: false,
    ...overrides,
  };
}

function probeFailure(overrides: Partial<McpProbeResult> = {}): McpProbeResult {
  return {
    probeState: "failed",
    protocolEra: null,
    protocolVersion: null,
    serverInfo: null,
    capabilities: null,
    instructions: null,
    tools: [],
    toolsCount: 0,
    toolsTruncated: false,
    probeError: "MCP_PROBE_FAILED: the Server said no",
    eraInvalidated: false,
    ...overrides,
  };
}

describe("McpAuthorizationService.setBearerOrNone", () => {
  it("writes an anonymous authorization as a real row with no credential", async () => {
    const ids = await seed();
    const { authorization } = build();
    await authorization.setBearerOrNone(ids.accountId, ids.agentId, ids.mcpServerId, { kind: "none" });
    expect(await readRow(ids)).toMatchObject({
      kind: "none",
      status: "active",
      ciphertext: null,
      keyId: null,
      authorizationServer: null,
      probeState: "pending",
      revision: 1,
    });
    // A `none` row resolves as an authorized Agent with no credential, not as an absence.
    const resolved = await authorization.resolveActiveCredential(ids.accountId, ids.agentId, ids.mcpServerId);
    expect(resolved?.credential).toBeUndefined();
    expect(resolved?.authorization.kind).toBe("none");
  });

  it("seals a Bearer key under the null issuer the row ends up with", async () => {
    const ids = await seed();
    const { authorization, cipher } = build();
    await authorization.setBearerOrNone(ids.accountId, ids.agentId, ids.mcpServerId, {
      kind: "bearer",
      bearerKey: "sk-secret",
    });
    const row = await readRow(ids);
    expect(row).toMatchObject({ kind: "bearer", status: "active", authorizationServer: null });
    // Sealed under `authorizationServer: null`, which is the AAD the row's current value produces.
    expect(
      cipher.decryptAuthorizationCredential(
        { mcpServerId: ids.mcpServerId, agentId: ids.agentId, authorizationServer: null },
        { ciphertext: row?.ciphertext as string, keyId: row?.keyId as string },
      ),
    ).toEqual({ accessToken: "sk-secret" });
  });

  it("replaces the previous credential and every flow column in one write", async () => {
    /*
     * Switching kind is an UPSERT, so a stale ciphertext the new AAD cannot open must never survive
     * it — and `state` and `loginSessionHash` are paired by the datastore, so they clear together.
     */
    const ids = await seed();
    const { authorization } = build();
    await authorization.setBearerOrNone(ids.accountId, ids.agentId, ids.mcpServerId, {
      kind: "bearer",
      bearerKey: "sk-first",
    });
    // The refresh-claim columns are OAuth-only by the datastore's own check, and the point of the
    // write under test is that switching kind clears every one of them.
    await unit.database
      .update(mcpServerAuthorizations)
      .set({ kind: "oauth" })
      .where(eq(mcpServerAuthorizations.agentId, ids.agentId));
    await unit.database
      .update(mcpServerAuthorizations)
      .set({
        authorizationServer: "https://auth.example.test",
        clientRegistrationId: null,
        scopes: ["mcp.read"],
        accessTokenExpiresAt: new Date(),
        refreshClaimId: randomUUID(),
        refreshClaimedAt: new Date(),
      })
      .where(eq(mcpServerAuthorizations.agentId, ids.agentId));

    await authorization.setBearerOrNone(ids.accountId, ids.agentId, ids.mcpServerId, { kind: "none" });
    expect(await readRow(ids)).toMatchObject({
      kind: "none",
      status: "active",
      ciphertext: null,
      keyId: null,
      authorizationServer: null,
      clientRegistrationId: null,
      scopes: null,
      accessTokenExpiresAt: null,
      state: null,
      stateExpiresAt: null,
      pkceCiphertext: null,
      loginSessionHash: null,
      refreshClaimId: null,
      refreshClaimedAt: null,
      failureCode: null,
      revision: 2,
    });
  });

  it("refuses a Bearer authorization with no key and writes nothing", async () => {
    const ids = await seed();
    const { authorization } = build();
    for (const bearerKey of [undefined, ""]) {
      await expect(
        authorization.setBearerOrNone(ids.accountId, ids.agentId, ids.mcpServerId, { kind: "bearer", bearerKey }),
      ).rejects.toMatchObject({ code: MCP_ERROR_CODES.CREDENTIAL_INPUT_INVALID });
    }
    expect(await unit.database.select().from(mcpServerAuthorizations)).toEqual([]);
  });

  it("refuses a write for an Agent that does not mount the Server", async () => {
    const ids = await seed();
    const { authorization } = build();
    await unit.database.delete(agentMcpServers).where(eq(agentMcpServers.agentId, ids.agentId));
    await expect(
      authorization.setBearerOrNone(ids.accountId, ids.agentId, ids.mcpServerId, { kind: "none" }),
    ).rejects.toMatchObject({ code: MCP_ERROR_CODES.BINDING_NOT_FOUND });
  });
});

describe("McpAuthorizationService.revoke", () => {
  it("drops the credential and the snapshot while keeping the mount and the kind", async () => {
    const ids = await seed();
    const { authorization, probe } = build();
    probe.probe.mockResolvedValue(probeSuccess());
    await authorization.setBearerOrNone(ids.accountId, ids.agentId, ids.mcpServerId, {
      kind: "bearer",
      bearerKey: "sk-secret",
    });
    await authorization.probe(ids.accountId, ids.agentId, ids.mcpServerId);

    await authorization.revoke(ids.accountId, ids.agentId, ids.mcpServerId);
    const row = await readRow(ids);
    expect(row).toMatchObject({
      kind: "bearer",
      status: "revoked",
      ciphertext: null,
      keyId: null,
      accessTokenExpiresAt: null,
      tools: null,
      toolsCount: null,
      toolsTruncated: false,
      probeState: "pending",
      probeError: null,
      failureCode: null,
      revision: 2,
    });
    // The mount survives, so the Agent is simply unauthorized again and needs no re-mount.
    expect(await unit.database.select().from(agentMcpServers)).toHaveLength(1);
    expect(await authorization.resolveActiveCredential(ids.accountId, ids.agentId, ids.mcpServerId)).toBeUndefined();
  });

  it("refuses to revoke for an Agent that does not mount the Server", async () => {
    const ids = await seed();
    const { authorization } = build();
    await expect(authorization.revoke(ids.accountId, ids.agentId, randomUUID())).rejects.toMatchObject({
      code: MCP_ERROR_CODES.BINDING_NOT_FOUND,
    });
  });
});

describe("McpAuthorizationService.resolveActiveCredential", () => {
  it("treats every status other than active as unauthorized", async () => {
    const ids = await seed();
    const { authorization } = build();
    // A `none` row is the only shape every terminal status admits without an envelope.
    await unit.database.insert(mcpServerAuthorizations).values({
      agentId: ids.agentId,
      mcpServerId: ids.mcpServerId,
      kind: "none",
      status: "pending",
    });
    for (const status of ["pending", "expired", "revoked", "error"] as const) {
      await unit.database
        .update(mcpServerAuthorizations)
        .set({ status })
        .where(eq(mcpServerAuthorizations.agentId, ids.agentId));
      expect(await authorization.resolveActiveCredential(ids.accountId, ids.agentId, ids.mcpServerId)).toBeUndefined();
    }
  });

  it("returns nothing for a row with no authorization at all", async () => {
    const ids = await seed();
    const { authorization } = build();
    expect(await authorization.resolveActiveCredential(ids.accountId, ids.agentId, ids.mcpServerId)).toBeUndefined();
  });

  it("decrypts an active OAuth credential together with its binding", async () => {
    const ids = await seed();
    const { authorization, cipher } = build();
    const sealed = cipher.encryptAuthorizationCredential(
      { mcpServerId: ids.mcpServerId, agentId: ids.agentId, authorizationServer: "https://auth.example.test" },
      { accessToken: "at_1", refreshToken: "rt_1" },
    );
    await unit.database.insert(mcpServerAuthorizations).values({
      agentId: ids.agentId,
      mcpServerId: ids.mcpServerId,
      kind: "oauth",
      status: "active",
      authorizationServer: "https://auth.example.test",
      ciphertext: sealed.ciphertext,
      keyId: sealed.keyId,
    });
    const resolved = await authorization.resolveActiveCredential(ids.accountId, ids.agentId, ids.mcpServerId);
    expect(resolved?.credential).toEqual({ accessToken: "at_1", refreshToken: "rt_1" });
    expect(resolved?.binding.agentId).toBe(ids.agentId);
    expect(resolved?.server.id).toBe(ids.mcpServerId);
    expect(resolved?.authorization.status).toBe("active");
  });
});

describe("McpAuthorizationService header construction", () => {
  it("always uses Authorization: Bearer for OAuth, whatever the definition names", async () => {
    /*
     * The specification fixes the OAuth header name and forbids the token in the query string, so the
     * effective `auth_header` is not consulted for this kind. The Agent's extra-header override is.
     */
    const ids = await seed();
    const { authorization, cipher } = build();
    await unit.database
      .update(mcpServers)
      .set({ authHeader: "x-api-key", authScheme: "Token", extraHeaders: { "x-team": "shared" } })
      .where(eq(mcpServers.id, ids.mcpServerId));
    await unit.database
      .update(agentMcpServers)
      .set({ authSchemeOverride: "Token", extraHeadersOverride: { "x-team": "agent" } })
      .where(eq(agentMcpServers.agentId, ids.agentId));
    const sealed = cipher.encryptAuthorizationCredential(
      { mcpServerId: ids.mcpServerId, agentId: ids.agentId, authorizationServer: null },
      { accessToken: "at_1" },
    );
    await unit.database.insert(mcpServerAuthorizations).values({
      agentId: ids.agentId,
      mcpServerId: ids.mcpServerId,
      kind: "oauth",
      status: "active",
      ciphertext: sealed.ciphertext,
      keyId: sealed.keyId,
    });
    expect(await authorization.buildHeaders(ids.accountId, ids.agentId, ids.mcpServerId)).toEqual({
      authorization: "Bearer at_1",
      "x-team": "agent",
    });
  });

  it("honours the Agent's own header name and empty scheme for a Bearer key", async () => {
    const ids = await seed();
    const { authorization } = build();
    await authorization.setBearerOrNone(ids.accountId, ids.agentId, ids.mcpServerId, {
      kind: "bearer",
      bearerKey: "sk-secret",
    });
    // Titled after the behaviour: an override of one field never inherits a stale value of another.
    await unit.database
      .update(agentMcpServers)
      .set({ authHeaderOverride: "x-api-key", authSchemeOverride: "" })
      .where(eq(agentMcpServers.agentId, ids.agentId));
    expect(await authorization.buildHeaders(ids.accountId, ids.agentId, ids.mcpServerId)).toEqual({
      "x-api-key": "sk-secret",
    });
  });

  it("sends a Bearer key with the definition's scheme by default", async () => {
    const ids = await seed();
    const { authorization } = build();
    await authorization.setBearerOrNone(ids.accountId, ids.agentId, ids.mcpServerId, {
      kind: "bearer",
      bearerKey: "sk-secret",
    });
    expect(await authorization.buildHeaders(ids.accountId, ids.agentId, ids.mcpServerId)).toEqual({
      authorization: "Bearer sk-secret",
    });
  });

  it("builds no credential header at all for an anonymous authorization", async () => {
    const ids = await seed();
    const { authorization } = build();
    await authorization.setBearerOrNone(ids.accountId, ids.agentId, ids.mcpServerId, { kind: "none" });
    expect(await authorization.buildHeaders(ids.accountId, ids.agentId, ids.mcpServerId)).toEqual({});
  });

  it("refuses to build headers for an Agent with nothing active", async () => {
    const ids = await seed();
    const { authorization } = build();
    await expect(authorization.buildHeaders(ids.accountId, ids.agentId, ids.mcpServerId)).rejects.toMatchObject({
      code: MCP_ERROR_CODES.AUTHORIZATION_REQUIRED,
    });
  });

  it("builds headers from an already-resolved row without a second read", async () => {
    const ids = await seed();
    const { authorization } = build();
    await authorization.setBearerOrNone(ids.accountId, ids.agentId, ids.mcpServerId, {
      kind: "bearer",
      bearerKey: "sk-secret",
    });
    const resolved = await authorization.resolveActiveCredential(ids.accountId, ids.agentId, ids.mcpServerId);
    expect(authorization.buildHeadersFor(resolved as never)).toEqual({ authorization: "Bearer sk-secret" });
  });
});

describe("McpAuthorizationService.probe", () => {
  it("persists the whole snapshot on the row and reports the outcome", async () => {
    const ids = await seed();
    const { authorization, probe } = build();
    await authorization.setBearerOrNone(ids.accountId, ids.agentId, ids.mcpServerId, { kind: "none" });
    probe.probe.mockResolvedValue(probeSuccess());
    const outcome = await authorization.probe(ids.accountId, ids.agentId, ids.mcpServerId);

    expect(outcome).toEqual({
      probeState: "succeeded",
      probeError: null,
      toolsCount: 1,
      toolsTruncated: false,
      protocolEra: "modern",
      protocolVersion: "2026-07-28",
    });
    // The probe was handed the effective URL and the Agent's own headers, and no cached era.
    expect(probe.probe).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: ids.accountId,
        url: DEFINITION.url,
        authHeaders: {},
        cachedEra: null,
        cachedVersion: null,
      }),
    );
    const row = await readRow(ids);
    expect(row).toMatchObject({
      probeState: "succeeded",
      probeError: null,
      protocolEra: "modern",
      protocolVersion: "2026-07-28",
      instructions: "Be careful.",
      toolsCount: 1,
      toolsTruncated: false,
    });
    expect(row?.serverInfo).toEqual({ name: "fixture", version: "1", description: "A fixture" });
    expect(row?.capabilities).toEqual({ tools: {} });
    expect(row?.probedAt).toBeInstanceOf(Date);
  });

  it("stores nothing for a Server that answers without capabilities or instructions", async () => {
    const ids = await seed();
    const { authorization, probe } = build();
    await authorization.setBearerOrNone(ids.accountId, ids.agentId, ids.mcpServerId, { kind: "none" });
    probe.probe.mockResolvedValue(
      probeSuccess({ serverInfo: null, capabilities: null, instructions: null, toolsTruncated: true }),
    );
    await authorization.probe(ids.accountId, ids.agentId, ids.mcpServerId);
    const row = await readRow(ids);
    // `null` on the row, not the missing sentinel: the reader is told there is nothing there.
    expect(row?.serverInfo).toBeNull();
    expect(row?.capabilities).toBeNull();
    expect(row?.instructions).toBeNull();
    expect(row?.toolsTruncated).toBe(true);
  });

  it("records a probe result's own composed failure without re-deriving a generic code", async () => {
    /*
     * The probe composes its `probeError` from the specific cause; re-deriving a code from the result
     * would flatten `MCP_URL_BLOCKED` and `MCP_PROTOCOL_UNSUPPORTED` into `MCP_PROBE_FAILED`.
     */
    const ids = await seed();
    const { authorization, probe } = build();
    await authorization.setBearerOrNone(ids.accountId, ids.agentId, ids.mcpServerId, { kind: "none" });
    probe.probe.mockResolvedValue(probeFailure({ probeError: "MCP_URL_BLOCKED: refused", eraInvalidated: true }));
    const outcome = await authorization.probe(ids.accountId, ids.agentId, ids.mcpServerId);
    expect(outcome).toMatchObject({
      probeState: "failed",
      probeError: "MCP_URL_BLOCKED: refused",
      toolsCount: null,
      protocolEra: null,
      protocolVersion: null,
    });
    const row = await readRow(ids);
    expect(row).toMatchObject({
      probeState: "failed",
      probeError: "MCP_URL_BLOCKED: refused",
      // Only a protocol-class failure drops the cached era.
      protocolEra: null,
      protocolVersion: null,
    });
  });

  it("leaves the cached era alone when the failure is not a protocol-class one", async () => {
    const ids = await seed();
    const { authorization, probe } = build();
    await authorization.setBearerOrNone(ids.accountId, ids.agentId, ids.mcpServerId, { kind: "none" });
    probe.probe.mockResolvedValue(probeSuccess());
    await authorization.probe(ids.accountId, ids.agentId, ids.mcpServerId);
    probe.probe.mockResolvedValue(probeFailure({ eraInvalidated: false }));
    await authorization.probe(ids.accountId, ids.agentId, ids.mcpServerId);
    const row = await readRow(ids);
    // A timeout or a 5xx says nothing about the origin's protocol, so a correct cache survives it.
    expect(row).toMatchObject({ probeState: "failed", protocolEra: "modern", protocolVersion: "2026-07-28" });
  });

  it("keeps the last good snapshot readable after a failed probe", async () => {
    const ids = await seed();
    const { authorization, probe } = build();
    await authorization.setBearerOrNone(ids.accountId, ids.agentId, ids.mcpServerId, { kind: "none" });
    probe.probe.mockResolvedValue(probeSuccess());
    await authorization.probe(ids.accountId, ids.agentId, ids.mcpServerId);
    const good = await readRow(ids);
    probe.probe.mockResolvedValue(probeFailure());
    await authorization.probe(ids.accountId, ids.agentId, ids.mcpServerId);
    const failed = await readRow(ids);
    expect(failed?.tools).toEqual(good?.tools);
    expect(failed?.toolsCount).toBe(good?.toolsCount);
    expect(failed?.instructions).toBe(good?.instructions);
  });

  it("turns a thrown error into a bounded failure with its own code", async () => {
    const ids = await seed();
    const { authorization, probe } = build();
    await authorization.setBearerOrNone(ids.accountId, ids.agentId, ids.mcpServerId, { kind: "none" });
    const { McpServiceError } = await import("../services/mcp/errors.js");
    probe.probe.mockRejectedValue(new McpServiceError(MCP_ERROR_CODES.PROTOCOL_UNSUPPORTED, "no shared protocol"));
    const outcome = await authorization.probe(ids.accountId, ids.agentId, ids.mcpServerId);
    expect(outcome.probeError).toBe(`${MCP_ERROR_CODES.PROTOCOL_UNSUPPORTED}: no shared protocol`);
    expect((await readRow(ids))?.probeError).toBe(outcome.probeError);
  });

  it("reports a generic probe failure for a thrown non-service error", async () => {
    const ids = await seed();
    const { authorization, probe } = build();
    await authorization.setBearerOrNone(ids.accountId, ids.agentId, ids.mcpServerId, { kind: "none" });
    probe.probe.mockRejectedValue(new Error("kaboom"));
    const outcome = await authorization.probe(ids.accountId, ids.agentId, ids.mcpServerId);
    expect(outcome.probeError).toBe(`${MCP_ERROR_CODES.PROBE_FAILED}: kaboom`);
  });

  it("bounds the summary and falls back when the error carries no message", async () => {
    const ids = await seed();
    const { authorization, probe } = build();
    await authorization.setBearerOrNone(ids.accountId, ids.agentId, ids.mcpServerId, { kind: "none" });
    probe.probe.mockRejectedValue(new Error("x".repeat(500)));
    const long = await authorization.probe(ids.accountId, ids.agentId, ids.mcpServerId);
    // `${code}: ` plus a 200-character summary whose three dots replaced the tail.
    expect(long.probeError).toBe(`${MCP_ERROR_CODES.PROBE_FAILED}: ${"x".repeat(197)}...`);

    probe.probe.mockRejectedValue(new Error(""));
    const empty = await authorization.probe(ids.accountId, ids.agentId, ids.mcpServerId);
    expect(empty.probeError).toBe(`${MCP_ERROR_CODES.PROBE_FAILED}: The MCP Server could not be probed`);
  });

  it("refuses to probe an Agent with nothing active", async () => {
    const ids = await seed();
    const { authorization, probe } = build();
    await expect(authorization.probe(ids.accountId, ids.agentId, ids.mcpServerId)).rejects.toMatchObject({
      code: MCP_ERROR_CODES.AUTHORIZATION_REQUIRED,
    });
    expect(probe.probe).not.toHaveBeenCalled();
  });

  it("drops a result that lost the race against a re-authorization", async () => {
    /*
     * The probe takes an upstream round trip, so a revoke or a kind change can land during it. The
     * write is fenced on the revision it read, and a dropped result is correct and silent.
     */
    const ids = await seed();
    const { authorization, probe } = build();
    await authorization.setBearerOrNone(ids.accountId, ids.agentId, ids.mcpServerId, {
      kind: "bearer",
      bearerKey: "sk-A",
    });
    probe.probe.mockImplementation(async () => {
      await authorization.setBearerOrNone(ids.accountId, ids.agentId, ids.mcpServerId, {
        kind: "bearer",
        bearerKey: "sk-B",
      });
      return probeSuccess();
    });
    await authorization.probe(ids.accountId, ids.agentId, ids.mcpServerId);
    const row = await readRow(ids);
    // Key B's row kept its own pending probe: key A's slower answer was never written over it.
    expect(row).toMatchObject({ probeState: "pending", toolsCount: null, revision: 2 });
  });

  it("refuses to store a snapshot that would take the Account past its bound", async () => {
    const ids = await seed();
    // A bound smaller than one tool's JSON, so any snapshot at all exceeds it.
    const { authorization, probe } = build({ accountSnapshotMaxBytes: 8 });
    await authorization.setBearerOrNone(ids.accountId, ids.agentId, ids.mcpServerId, { kind: "none" });
    probe.probe.mockResolvedValue(probeSuccess());
    const outcome = await authorization.probe(ids.accountId, ids.agentId, ids.mcpServerId);
    // The reported outcome matches what was stored rather than what the Server answered.
    expect(outcome).toMatchObject({ probeState: "failed", toolsCount: null });
    expect(outcome.probeError).toContain(MCP_ERROR_CODES.PROBE_FAILED);
    expect(outcome.probeError).toContain("64 MiB");
    const row = await readRow(ids);
    expect(row).toMatchObject({ probeState: "failed", tools: null, toolsCount: null });
  });

  it("measures the Account's total without double-counting this row's current snapshot", async () => {
    /*
     * The probe replaces this row's contribution rather than adding to it, so a row already holding a
     * large snapshot must not be charged for it twice.
     */
    const ids = await seed();
    const { authorization, probe } = build({ accountSnapshotMaxBytes: 20_000 });
    await authorization.setBearerOrNone(ids.accountId, ids.agentId, ids.mcpServerId, { kind: "none" });
    const bulky = probeSuccess({
      tools: [{ name: "read", description: "d".repeat(2000), inputSchema: { type: "object" } }],
    });
    probe.probe.mockResolvedValue(bulky);
    expect((await authorization.probe(ids.accountId, ids.agentId, ids.mcpServerId)).probeState).toBe("succeeded");
    // Re-probing the same row with the same snapshot is not an increase, so it still fits.
    expect((await authorization.probe(ids.accountId, ids.agentId, ids.mcpServerId)).probeState).toBe("succeeded");
  });
});

describe("McpAuthorizationService.readProbeOutcome", () => {
  it("reports pending for a pair with no authorization row at all", async () => {
    const ids = await seed();
    const { authorization } = build();
    expect(await authorization.readProbeOutcome(ids.accountId, ids.agentId, ids.mcpServerId)).toEqual({
      probeState: "pending",
      probeError: null,
      toolsCount: null,
      toolsTruncated: false,
      protocolEra: null,
      protocolVersion: null,
    });
  });

  it("reports exactly what the row holds", async () => {
    const ids = await seed();
    const { authorization, probe } = build();
    await authorization.setBearerOrNone(ids.accountId, ids.agentId, ids.mcpServerId, { kind: "none" });
    const outcome = await authorization.readProbeOutcome(ids.accountId, ids.agentId, ids.mcpServerId);
    // `probeState: "pending"` is the honest answer for a row that has not been probed yet, and the
    // poll depends on it, so it must not be reported as something else.
    expect(outcome).toMatchObject({ probeState: "pending", toolsCount: null });
    probe.probe.mockResolvedValue(probeSuccess({ toolsTruncated: true }));
    await authorization.probe(ids.accountId, ids.agentId, ids.mcpServerId);
    expect(await authorization.readProbeOutcome(ids.accountId, ids.agentId, ids.mcpServerId)).toEqual({
      probeState: "succeeded",
      probeError: null,
      toolsCount: 1,
      toolsTruncated: true,
      protocolEra: "modern",
      protocolVersion: "2026-07-28",
    });
  });
});
