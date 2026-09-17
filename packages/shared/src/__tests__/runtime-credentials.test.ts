import { describe, expect, it } from "vitest";
import {
  decodeProviderProxyDataFrame,
  encodeProviderProxyDataFrame,
  FEISHU_TENANT_TOKEN_LOCAL_SENTINEL,
  PROVIDER_PROXY_CHUNK_MAX_BYTES,
  PROVIDER_PROXY_INITIAL_CREDIT_BYTES,
  PROVIDER_PROXY_MAX_STREAMS_PER_EXECUTION,
  RUNTIME_CLI_METADATA_MAX_REPOSITORIES,
  RUNTIME_CREDENTIAL_CAPABILITY_REFRESH_AFTER_MS,
  RUNTIME_CREDENTIAL_CAPABILITY_TTL_MS,
  RUNTIME_CREDENTIAL_PROVIDERS,
  RUNTIME_PROVIDER_ORIGIN_HEADER,
  RUNTIME_PROVIDER_PROXY_PATH,
  RUNTIME_PROXY_TICKET_TTL_MS,
  RuntimeCredentialAcquireRequestSchema,
  RuntimeCredentialClientFrameSchema,
  RuntimeCredentialResultSchema,
  RuntimeCredentialRevokedFrameSchema,
  RuntimeCredentialServerFrameSchema,
  RuntimeExecutionClosedResultSchema,
  RuntimeExecutionCloseRequestSchema,
  RuntimeExecutionOpenRequestSchema,
  RuntimeExecutionOpenResultSchema,
  RuntimeExecutionProviderSchema,
  RuntimeExecutionSourceSchema,
  RuntimeGitHubCliMetadataSchema,
  RuntimeProviderCliMetadataSchema,
  RuntimeProviderProxyAuthFrameSchema,
  RuntimeProviderProxyClientFrameSchema,
  RuntimeProviderProxyCreditFrameSchema,
  RuntimeProviderProxyOpenFrameSchema,
  RuntimeProviderProxyServerFrameSchema,
  RuntimeProxyTicketRequestSchema,
  RuntimeProxyTicketResultSchema,
} from "../runtime-credentials.js";
import { RUNTIME_CAPABILITY, RUNTIME_SERVER_CAPABILITY_OFFERS } from "../runtime-protocol.js";

const requestId = "3b7f6a52-9d4f-4b3f-9a6f-9a4b6b62f001";
const executionId = "5f7b6a52-9d4f-4b3f-9a6f-9a4b6b62f002";
const runId = "6c8c7b63-ae50-4c40-ab70-0b5c7c73g003".replace("g", "a");
const ticket = "t".repeat(64);
const capability = "c".repeat(64);

describe("runtime credential control frames", () => {
  it("fixes the contract constants", () => {
    expect(RUNTIME_PROVIDER_PROXY_PATH).toBe("/api/v1/runtime/provider-proxy");
    expect(RUNTIME_CREDENTIAL_CAPABILITY_TTL_MS).toBe(60_000);
    expect(RUNTIME_CREDENTIAL_CAPABILITY_REFRESH_AFTER_MS).toBe(30_000);
    expect(RUNTIME_PROXY_TICKET_TTL_MS).toBe(15_000);
    expect(PROVIDER_PROXY_MAX_STREAMS_PER_EXECUTION).toBe(8);
    expect(PROVIDER_PROXY_INITIAL_CREDIT_BYTES).toBe(1_048_576);
    expect(PROVIDER_PROXY_CHUNK_MAX_BYTES).toBe(65_536);
    expect(RUNTIME_CREDENTIAL_PROVIDERS).toEqual(["github", "slack", "feishu"]);
    expect(RUNTIME_PROVIDER_ORIGIN_HEADER).toBe("x-opentag-provider-origin");
    expect(FEISHU_TENANT_TOKEN_LOCAL_SENTINEL).not.toMatch(/^[A-Za-z0-9_-]{43}$/);
    // Additive negotiation: both new offers are v1-only and the legacy raw-grant offer is intact.
    expect(RUNTIME_SERVER_CAPABILITY_OFFERS[RUNTIME_CAPABILITY.runtimeCredential]).toEqual({ min: 1, max: 1 });
    expect(RUNTIME_SERVER_CAPABILITY_OFFERS[RUNTIME_CAPABILITY.providerProxy]).toEqual({ min: 1, max: 1 });
    expect(RUNTIME_SERVER_CAPABILITY_OFFERS[RUNTIME_CAPABILITY.imCredentialGrant]).toEqual({ min: 1, max: 2 });
  });

  it("bounds provider-discriminated non-secret CLI metadata", () => {
    expect(
      RuntimeProviderCliMetadataSchema.parse({
        provider: "feishu",
        appId: "cli_a",
        teamBrand: "lark",
        outboxContext: { provider: "feishu", sessionKind: "channel", chatId: "oc_1" },
      }),
    ).toMatchObject({ provider: "feishu", teamBrand: "lark" });
    expect(
      RuntimeProviderCliMetadataSchema.parse({
        provider: "slack",
        teamId: "T1",
        botUserId: "U1",
        outboxContext: { provider: "slack", sessionKind: "thread", channelId: "C1", threadTs: "1.2" },
      }),
    ).toMatchObject({ provider: "slack" });
    const repositories = Array.from({ length: RUNTIME_CLI_METADATA_MAX_REPOSITORIES }, (_, index) => ({
      repositoryId: String(index + 1),
      fullName: `acme/repo-${index + 1}`,
      role: "code" as const,
      access: "read" as const,
    }));
    expect(
      RuntimeGitHubCliMetadataSchema.parse({ provider: "github", connectionId: "c1", repositories }),
    ).toMatchObject({ provider: "github" });
    expect(() =>
      RuntimeGitHubCliMetadataSchema.parse({
        provider: "github",
        connectionId: "c1",
        repositories: [...repositories, repositories[0]],
      }),
    ).toThrow();
    expect(() =>
      RuntimeProviderCliMetadataSchema.parse({ provider: "slack", teamId: "T1", botUserId: "U1", appId: "cli_a" }),
    ).toThrow();
    expect(() =>
      RuntimeProviderCliMetadataSchema.parse({
        provider: "feishu",
        appId: "cli_a",
        teamBrand: "feishu",
        outboxContext: { provider: "slack", sessionKind: "channel", channelId: "C1" },
      }),
    ).toThrow();
    expect(() =>
      RuntimeProviderCliMetadataSchema.parse({ provider: "feishu", appId: "cli_a", teamBrand: "lark", token: "x" }),
    ).toThrow();
  });

  it("round-trips the optional GitHub branch/publish/work-branch scope without stripping it", () => {
    const sessionId = "5f7b6a52-9d4f-4b3f-9a6f-9a4b6b62f002";
    const scoped = {
      repositoryId: "1",
      fullName: "acme/repo",
      role: "context_tree" as const,
      access: "write" as const,
      branch: "refs/heads/master",
      publish: "pull_request" as const,
      workBranchPrefix: `refs/heads/opentag/${sessionId}/context_tree/`,
    };
    const metadata = RuntimeGitHubCliMetadataSchema.parse({
      provider: "github",
      connectionId: "c1",
      repositories: [scoped],
    });
    expect(metadata.repositories[0]).toEqual(scoped);
    // Existing callers that never sent scope fields keep the compact metadata.
    expect(
      RuntimeGitHubCliMetadataSchema.parse({
        provider: "github",
        connectionId: "c1",
        repositories: [{ repositoryId: "1", fullName: "acme/repo", role: "code", access: "read" }],
      }).repositories[0],
    ).toEqual({ repositoryId: "1", fullName: "acme/repo", role: "code", access: "read" });
    // The full wire results must carry the same exact scope, not a stripped copy.
    expect(
      RuntimeExecutionOpenResultSchema.safeParse({
        type: "runtime:execution:result",
        requestId,
        status: "succeeded",
        executionId,
        expiresAt: "2026-09-17T00:00:00Z",
        providers: [{ provider: "github", bindingId: "c1", cli: metadata }],
      }).success,
    ).toBe(true);
    expect(
      RuntimeCredentialResultSchema.safeParse({
        type: "runtime:credential:result",
        requestId,
        status: "succeeded",
        executionId,
        grantId: executionId,
        provider: "github",
        bindingId: "c1",
        opaqueToken: capability,
        expiresAt: "2026-09-16T00:01:00Z",
        refreshAfter: "2026-09-16T00:00:30Z",
        scopeHash: "a".repeat(64),
        authorizationRevision: "github:uat-1",
        credentialGeneration: "9",
        cli: metadata,
      }).success,
    ).toBe(true);
    expect(() =>
      RuntimeGitHubCliMetadataSchema.parse({
        provider: "github",
        connectionId: "c1",
        repositories: [{ ...scoped, workBranchPrefix: "refs/heads/opentag/not-a-uuid/code/" }],
      }),
    ).toThrow();
    expect(() =>
      RuntimeGitHubCliMetadataSchema.parse({
        provider: "github",
        connectionId: "c1",
        repositories: [{ repositoryId: "1", fullName: "acme/repo", role: "code", access: "read", token: "x" }],
      }),
    ).toThrow();
  });

  it("accepts a delivery-sourced execution open", () => {
    const frame = RuntimeExecutionOpenRequestSchema.parse({
      type: "runtime:execution:open",
      requestId,
      sessionId: "session-1",
      agentId: "agent-1",
      placementGeneration: 3,
      runId,
      source: { kind: "delivery", deliveryId: "delivery-1", turnId: "turn-1" },
      sandbox: { sandboxId: executionId, resourceUid: "uid-1", environmentGeneration: 2 },
    });
    expect(frame.source.kind).toBe("delivery");
    expect(frame.sandbox?.environmentGeneration).toBe(2);
  });

  it("rejects unknown fields and malformed sources", () => {
    expect(() =>
      RuntimeExecutionOpenRequestSchema.parse({
        type: "runtime:execution:open",
        requestId,
        sessionId: "s",
        agentId: "a",
        placementGeneration: 1,
        runId,
        source: { kind: "delivery", deliveryId: "d", turnId: "t" },
        computerId: "spoof",
      }),
    ).toThrow();
    expect(() => RuntimeExecutionSourceSchema.parse({ kind: "turn", turnId: "t" })).toThrow();
    expect(() =>
      RuntimeExecutionSourceSchema.parse({ kind: "delivery", deliveryId: "d", turnId: "t", agentTrace: "x" }),
    ).toThrow();
  });

  it("round-trips acquire/renew/result/close/ticket frames through the unions", () => {
    const acquire = RuntimeCredentialClientFrameSchema.parse({
      type: "runtime:credential:acquire",
      requestId,
      executionId,
      provider: "slack",
      bindingId: "binding-1",
    });
    expect(RuntimeCredentialAcquireRequestSchema.parse(acquire).provider).toBe("slack");
    expect(
      RuntimeCredentialClientFrameSchema.parse({
        type: "runtime:credential:renew",
        requestId,
        executionId,
        grantId: executionId,
      }).type,
    ).toBe("runtime:credential:renew");
    const result = RuntimeCredentialServerFrameSchema.parse({
      type: "runtime:credential:result",
      requestId,
      status: "succeeded",
      executionId,
      grantId: executionId,
      provider: "feishu",
      bindingId: "binding-2",
      opaqueToken: capability,
      expiresAt: "2026-09-16T00:01:00Z",
      refreshAfter: "2026-09-16T00:00:30Z",
      scopeHash: "a".repeat(64),
      authorizationRevision: "im:4",
      credentialGeneration: "4",
      cli: { provider: "feishu", appId: "cli_a", teamBrand: "feishu" },
    });
    expect(RuntimeCredentialResultSchema.parse(result).status).toBe("succeeded");
    expect(
      RuntimeCredentialServerFrameSchema.parse({
        type: "runtime:credential:result",
        requestId,
        status: "rejected",
        code: "credential_stale",
      }),
    ).toMatchObject({ code: "credential_stale" });
    const close = RuntimeExecutionCloseRequestSchema.parse({
      type: "runtime:execution:close",
      requestId,
      executionId,
    });
    expect(close.executionId).toBe(executionId);
    expect(
      RuntimeExecutionClosedResultSchema.parse({
        type: "runtime:execution:closed",
        requestId,
        executionId,
        status: "rejected",
        code: "execution_unknown",
      }),
    ).toMatchObject({ status: "rejected" });
    expect(() =>
      RuntimeExecutionClosedResultSchema.parse({
        type: "runtime:execution:closed",
        requestId,
        executionId,
        status: "rejected",
      }),
    ).toThrow();
    const ticketRequest = RuntimeProxyTicketRequestSchema.parse({
      type: "runtime:proxy:ticket",
      requestId,
      executionId,
    });
    expect(ticketRequest.type).toBe("runtime:proxy:ticket");
    const ticketResult = RuntimeProxyTicketResultSchema.parse({
      type: "runtime:proxy:ticket:result",
      requestId,
      status: "succeeded",
      executionId,
      ticket,
      expiresAt: "2026-09-16T00:00:15Z",
      path: "/api/v1/runtime/provider-proxy",
    });
    expect(ticketResult.status).toBe("succeeded");
    expect(() =>
      RuntimeProxyTicketResultSchema.parse({
        type: "runtime:proxy:ticket:result",
        requestId,
        status: "succeeded",
        executionId,
        ticket,
        expiresAt: "2026-09-16T00:00:15Z",
        path: "/api/v1/other",
      }),
    ).toThrow();
  });

  it("parses the open result providers and the revoked push", () => {
    const result = RuntimeExecutionOpenResultSchema.parse({
      type: "runtime:execution:result",
      requestId,
      status: "succeeded",
      executionId,
      expiresAt: "2026-09-17T00:00:00Z",
      providers: [
        { provider: "slack", bindingId: "b1", cli: { provider: "slack", teamId: "T1", botUserId: "U1" } },
        {
          provider: "github",
          bindingId: "c1",
          cli: {
            provider: "github",
            connectionId: "c1",
            repositories: [{ repositoryId: "1", fullName: "acme/repo", role: "code", access: "read" }],
          },
        },
      ],
    });
    expect(result.status).toBe("succeeded");
    expect(
      RuntimeExecutionProviderSchema.parse(result.status === "succeeded" ? result.providers[1] : undefined),
    ).toMatchObject({ provider: "github" });
    expect(
      RuntimeCredentialRevokedFrameSchema.parse({
        type: "runtime:credential:revoked",
        executionId,
        code: "connection_replaced",
      }).code,
    ).toBe("connection_replaced");
    expect(() =>
      RuntimeExecutionOpenResultSchema.parse({
        type: "runtime:execution:result",
        requestId,
        status: "rejected",
        code: "turn_forged",
      }),
    ).toThrow();
  });
});

describe("provider proxy data frames", () => {
  it("accepts auth/open/credit frames and rejects malformed variants", () => {
    expect(RuntimeProviderProxyAuthFrameSchema.parse({ type: "auth", ticket }).ticket).toBe(ticket);
    expect(() => RuntimeProviderProxyAuthFrameSchema.parse({ type: "auth", ticket, executionId })).toThrow();
    const open = RuntimeProviderProxyClientFrameSchema.parse({
      type: "open",
      streamId: 1,
      capability,
      provider: "slack",
      bindingId: "b1",
      method: "POST",
      path: "/api/chat.postMessage",
      headers: { "content-type": "application/json" },
    });
    expect(RuntimeProviderProxyOpenFrameSchema.parse(open).method).toBe("POST");
    expect(() =>
      RuntimeProviderProxyClientFrameSchema.parse({
        type: "open",
        streamId: 0,
        capability,
        provider: "slack",
        bindingId: "b1",
        method: "POST",
        path: "/api/x",
        headers: {},
      }),
    ).toThrow();
    expect(() =>
      RuntimeProviderProxyClientFrameSchema.parse({
        type: "open",
        streamId: 1,
        capability,
        provider: "slack",
        bindingId: "b1",
        method: "OPTIONS",
        path: "/api/x",
        headers: {},
      }),
    ).toThrow();
    expect(RuntimeProviderProxyCreditFrameSchema.parse({ type: "credit", streamId: 7, bytes: 65_536 }).bytes).toBe(
      65_536,
    );
    expect(() => RuntimeProviderProxyCreditFrameSchema.parse({ type: "credit", streamId: 7, bytes: 0 })).toThrow();
    expect(
      RuntimeProviderProxyServerFrameSchema.parse({
        type: "response",
        streamId: 2,
        status: 200,
        headers: { "content-type": "application/json" },
      }).type,
    ).toBe("response");
    expect(
      RuntimeProviderProxyServerFrameSchema.parse({ type: "error", streamId: 2, code: "credential_stale" }),
    ).toMatchObject({ code: "credential_stale" });
  });

  it("round-trips binary frames and rejects malformed buffers", () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    const encoded = encodeProviderProxyDataFrame(513, payload);
    expect(encoded.byteLength).toBe(9);
    const decoded = decodeProviderProxyDataFrame(encoded);
    expect(decoded?.streamId).toBe(513);
    expect(decoded ? [...decoded.payload] : undefined).toEqual([1, 2, 3, 4, 5]);
    expect(decodeProviderProxyDataFrame(new Uint8Array([0, 0, 0, 1]))).toBeUndefined();
    expect(decodeProviderProxyDataFrame(new Uint8Array(4 + 65_537))).toBeUndefined();
    expect(() => encodeProviderProxyDataFrame(0, payload)).toThrow();
    expect(() => encodeProviderProxyDataFrame(1, new Uint8Array(0))).toThrow();
    expect(() => encodeProviderProxyDataFrame(1, new Uint8Array(PROVIDER_PROXY_CHUNK_MAX_BYTES + 1))).toThrow();
  });
});
