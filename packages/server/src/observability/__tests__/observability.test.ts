import { randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";
import {
  agentFeishuSetupAttemptsPath,
  computeTurnResultHash,
  type DirectImMessageDeliveryRequest,
  type EffectiveRuntimeSnapshot,
  FEISHU_REQUIRED_TENANT_SCOPES,
  HTTP_PATHS,
  type SessionReconcileRequest,
} from "@opentag/shared";
import { context as otelContext, trace } from "@opentelemetry/api";
import { AsyncHooksContextManager } from "@opentelemetry/context-async-hooks";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { createApp, ignoreHttpTraceRoute } from "../../app.js";
import { ConnectionRegistry, RuntimeRegistrySendError } from "../../runtime/connection-registry.js";
import { ImDeliveryWorker } from "../../runtime/im-delivery-worker.js";
import { RuntimeDomainOwner } from "../../runtime/runtime-domain-owner.js";
import { ImInboundPersistenceError, ImMessageInbox } from "../../services/im/im-message-inbox.js";
import { OutboundMessageService } from "../../services/im/outbound-message-service.js";
import { FeishuConnectionManager } from "../../services/im-bindings/feishu/connection-manager.js";
import { safeFeishuSetupErrorCode } from "../../services/im-bindings/feishu/errors.js";
import { FeishuSetupService } from "../../services/im-bindings/feishu/setup-service.js";
import { ImBindingServiceError } from "../../services/im-bindings/im-binding-service.js";
import { OPENTAG_ATTR } from "../attributes.js";
import { traceDeliveryClaim } from "../delivery-tracing.js";
import { traceFeishuInbound } from "../feishu-tracing.js";
import { initTelemetry, isTelemetryEnabled, parseHeaderString, shutdownTelemetry } from "../logfire-init.js";
import {
  normalizeTelemetryAttrs,
  setActiveSpanAttributes,
  tracePromise,
  withRootSpan,
  withSpan,
} from "../otel-helpers.js";
import { endRuntimeConnectionSpan, startRuntimeConnectionSpan, withRuntimeFrameSpan } from "../ws-tracing.js";

const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
const contextManager = new AsyncHooksContextManager();

beforeAll(() => {
  contextManager.enable();
  otelContext.setGlobalContextManager(contextManager);
  trace.setGlobalTracerProvider(provider);
});

afterAll(async () => {
  await shutdownTelemetry();
  await provider.shutdown();
  trace.disable();
  otelContext.disable();
  contextManager.disable();
});

beforeEach(() => exporter.reset());

describe("telemetry configuration", () => {
  it("parses bearer headers without exposing them and stays disabled without an endpoint", async () => {
    expect(parseHeaderString("Authorization=Bearer abc==,x-tenant=test")).toEqual({
      Authorization: "Bearer abc==",
      "x-tenant": "test",
    });
    await initTelemetry({ endpoint: "", environment: "test", headers: "secret-header", sampleRate: 1 }, "instance-1");
    expect(isTelemetryEnabled()).toBe(false);
  });

  it("keeps Pino output outside the trace exporter", async () => {
    const app = createApp({ loggerStream: new PassThrough() });
    app.log.error({ err: new Error("plain Pino secret body") }, "expected test error");
    await app.close();
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });
});

describe("span helpers", () => {
  it("keeps child context, creates independent roots, and ends success and failure spans", async () => {
    let childTrace = "";
    let rootTrace = "";
    await withSpan("parent", undefined, async () => {
      const parentTrace = trace.getActiveSpan()?.spanContext().traceId;
      await withSpan("child", undefined, async () => {
        childTrace = trace.getActiveSpan()?.spanContext().traceId ?? "";
      });
      await withRootSpan("independent", undefined, async () => {
        rootTrace = trace.getActiveSpan()?.spanContext().traceId ?? "";
      });
      expect(childTrace).toBe(parentTrace);
      expect(rootTrace).not.toBe(parentTrace);
    });

    const failure = new Error("Authorization=Bearer top-secret");
    await expect(withRootSpan("failure", undefined, () => Promise.reject(failure))).rejects.toBe(failure);
    expect(exporter.getFinishedSpans().map((span) => span.name)).toEqual(["child", "independent", "parent", "failure"]);
    expect(exporter.getFinishedSpans().at(-1)?.status.message).not.toContain("top-secret");
  });

  it("never exports arbitrary exception messages or stacks", async () => {
    const secrets = [
      "private provider response body",
      "PRIVATE_PROVIDER_BODY",
      "unlabelled message body",
      "PRIVATE_MESSAGE_BODY",
      "Alice Sender Name",
      "PRIVATE_SENDER_NAME",
      "private agent prompt",
      "PRIVATE_AGENT_PROMPT",
      "private model output",
      "private tool payload",
      "PRIVATE_TOOL_PAYLOAD",
    ];
    for (const secret of secrets) {
      const failure = new Error(secret);
      Object.assign(failure, { code: `UNTRUSTED_${secret}` });
      failure.stack = `Error: ${secret}\n at private-source`;
      await expect(withRootSpan("plain-secret-failure", undefined, () => Promise.reject(failure))).rejects.toBe(
        failure,
      );
    }
    const capture = JSON.stringify(
      exporter.getFinishedSpans().map((span) => ({ events: span.events, status: span.status })),
    );
    for (const secret of secrets) expect(capture).not.toContain(secret);
    expect(capture).not.toContain("private-source");
    expect(exporter.getFinishedSpans().every((span) => span.status.message === "INTERNAL_ERROR")).toBe(true);
  });

  it("scrubs sensitive attributes before exporter capture", async () => {
    const secrets = [
      "app-secret-value",
      "authorization-value",
      "cookie-value",
      "access-token-value",
      "message-body-value",
      "sender-display-value",
      "agent-prompt-value",
      "tool-output-value",
    ];
    await withRootSpan(
      "security",
      {
        appSecret: secrets[0],
        Authorization: secrets[1],
        cookie: secrets[2],
        accessToken: secrets[3],
        messageContent: secrets[4],
        senderDisplayName: secrets[5],
        prompt: secrets[6],
        toolOutput: secrets[7],
        safe: { token: secrets[3], nested: "retained" },
      },
      async () => setActiveSpanAttributes({ payload: { body: secrets[4] } }),
    );
    const capture = JSON.stringify(
      exporter.getFinishedSpans().map((span) => ({
        attributes: span.attributes,
        events: span.events,
        status: span.status,
      })),
    );
    for (const secret of secrets) expect(capture).not.toContain(secret);
    expect(exporter.getFinishedSpans()[0]?.attributes.safe).toContain("[scrubbed]");
  });

  it("preserves synchronous throws and rejected promises while ending tracePromise spans", async () => {
    const sync = new Error("sync failure");
    expect(() =>
      tracePromise("runtime.delivery", undefined, () => {
        throw sync;
      }),
    ).toThrow(sync);
    const asyncFailure = new Error("async failure");
    await expect(tracePromise("runtime.reconcile", undefined, () => Promise.reject(asyncFailure))).rejects.toBe(
      asyncFailure,
    );
    expect(exporter.getFinishedSpans()).toHaveLength(2);
    expect(exporter.getFinishedSpans().every((span) => span.status.code === 2)).toBe(true);
  });

  it("maps only typed or exact registration errors into Feishu setup diagnostics", () => {
    const raw = Object.assign(new Error("FEISHU_PRIVATE_APP_SECRET"), {
      code: "FEISHU_PRIVATE_PROVIDER_BODY",
    });
    expect(safeFeishuSetupErrorCode(raw)).toBe("FEISHU_SETUP_FAILED");
    expect(safeFeishuSetupErrorCode({ code: "access_denied" })).toBe("FEISHU_SETUP_DENIED");
    expect(safeFeishuSetupErrorCode({ code: "expired_token" })).toBe("FEISHU_SETUP_EXPIRED");
    expect(safeFeishuSetupErrorCode({ code: "abort" })).toBe("FEISHU_SETUP_CANCELED");
    expect(safeFeishuSetupErrorCode({ code: "FEISHU_APP_ALREADY_BOUND" })).toBe("FEISHU_SETUP_FAILED");
    expect(
      safeFeishuSetupErrorCode(
        new ImBindingServiceError("FEISHU_APP_ALREADY_BOUND", 409, "The selected Feishu App is already bound"),
      ),
    ).toBe("FEISHU_APP_ALREADY_BOUND");
  });

  it("normalizes bounded primitive attributes and drops nullish values", () => {
    expect(normalizeTelemetryAttrs({ id: "a", count: 2, ok: true, missing: null })).toEqual({
      id: "a",
      count: 2,
      ok: true,
    });
  });
});

describe("background and WebSocket tracing", () => {
  it("keeps raw Feishu setup failures out of persisted diagnostics, logger codes, and traces", async () => {
    const agentId = randomUUID();
    const rawFailure = Object.assign(new Error("FEISHU_PRIVATE_APP_SECRET"), {
      code: "FEISHU_PRIVATE_PROVIDER_BODY",
    });
    let rejectRegistration: ((error: Error) => void) | undefined;
    const registrationResult = new Promise<never>((_resolve, reject) => {
      rejectRegistration = reject;
    });
    const diagnosticWrites: Array<Record<string, unknown>> = [];
    const loggerCodes: string[] = [];
    const selectRows = [[], [{ displayName: "Agent", receiveMode: "direct_only" }], []];
    const database = {
      select: vi.fn(() => resolvedQuery(selectRows.shift() ?? [])),
      transaction: vi.fn(async (run: (transaction: unknown) => Promise<unknown>) =>
        run({
          insert: vi.fn(() => ({
            values: vi.fn((values: Record<string, unknown>) => ({
              returning: vi.fn().mockResolvedValue([
                {
                  id: randomUUID(),
                  agentId,
                  lastErrorCode: null,
                  updatedAt: new Date(),
                  ...values,
                },
              ]),
            })),
          })),
        }),
      ),
      update: vi.fn(() => ({
        set: vi.fn((values: Record<string, unknown>) => {
          diagnosticWrites.push(values);
          return { where: vi.fn().mockResolvedValue([]) };
        }),
      })),
    };
    const setup = new FeishuSetupService({
      activation: { activateAtomicAttempt: vi.fn() },
      cipher: {
        encrypt: vi.fn().mockReturnValue("encrypted-qr"),
        decrypt: vi.fn().mockReturnValue(JSON.stringify({ qrUrl: "https://example.test/qr" })),
      } as never,
      database: database as never,
      imBindings: {
        assertCanManage: vi.fn(),
        assertCanManageForMutation: vi.fn(),
      } as never,
      instanceId: randomUUID(),
      onDiagnostic: (code) => loggerCodes.push(code),
      registrations: {
        start: vi.fn().mockReturnValue({
          abort: vi.fn(),
          qrReady: Promise.resolve({ url: "https://example.test/qr", expiresAt: new Date(Date.now() + 60_000) }),
          result: registrationResult,
        }),
      },
    });

    await setup.createOrReuse(randomUUID(), agentId, "create");
    rejectRegistration?.(rawFailure);
    await vi.waitFor(() => {
      expect(diagnosticWrites.some((write) => write.lastErrorCode === "FEISHU_SETUP_FAILED")).toBe(true);
    });

    const capture = JSON.stringify({ diagnosticWrites, loggerCodes, spans: exporter.getFinishedSpans() });
    expect(capture).not.toContain(rawFailure.message);
    expect(capture).not.toContain(rawFailure.code);
    expect(loggerCodes).toEqual([]);
  });

  it("replaces an early Feishu QR failure before the HTTP logger observes it", async () => {
    const agentId = randomUUID();
    const rawFailure = Object.assign(new Error("PRIVATE_QR_PROVIDER_BODY_WITH_APP_SECRET"), {
      code: "PRIVATE_QR_PROVIDER_CODE",
    });
    let rejectQr: ((error: Error) => void) | undefined;
    const qrReady = new Promise<never>((_resolve, reject) => {
      rejectQr = reject;
    });
    const selectRows = [[], [{ displayName: "Agent", receiveMode: "direct_only" }], []];
    const startRegistration = vi.fn().mockReturnValue({
      abort: vi.fn(),
      qrReady,
      result: new Promise<never>(() => undefined),
    });
    const setup = new FeishuSetupService({
      activation: { activateAtomicAttempt: vi.fn() },
      cipher: {} as never,
      database: { select: vi.fn(() => resolvedQuery(selectRows.shift() ?? [])) } as never,
      imBindings: {
        assertCanManage: vi.fn(),
        assertCanManageForMutation: vi.fn(),
      } as never,
      instanceId: randomUUID(),
      registrations: {
        start: startRegistration,
      },
    });
    const logChunks: string[] = [];
    const app = createApp({
      authService: runtimeAuthService() as never,
      feishuSetupService: setup,
      imBindingService: {} as never,
      loggerStream: { write: (chunk) => logChunks.push(String(chunk)) },
    });

    const responsePromise = app.inject({
      method: "POST",
      url: agentFeishuSetupAttemptsPath(agentId),
      headers: { authorization: "Bearer access" },
      payload: { intent: "create" },
    });
    await vi.waitFor(() => expect(startRegistration).toHaveBeenCalledOnce());
    rejectQr?.(rawFailure);
    const response = await responsePromise;
    await app.close();

    const logs = logChunks.join("");
    expect(response.statusCode).toBe(500);
    expect(logs).toContain("FEISHU_SETUP_FAILED");
    expect(logs).not.toContain(rawFailure.message);
    expect(logs).not.toContain(rawFailure.code);
  });

  it("drives real inbox and delivery worker entry points without leaking failures", async () => {
    const inboxFailure = Object.assign(new Error("PRIVATE_INBOUND_MESSAGE_BODY"), {
      code: "PRIVATE_INBOUND_SENDER_NAME",
    });
    const inbox = new ImMessageInbox({ transaction: vi.fn().mockRejectedValue(inboxFailure) } as never);
    await expect(
      inbox.ingest(randomUUID(), 1, normalizedInboundEvent(), undefined, { provider: "slack" }),
    ).rejects.toBe(inboxFailure);

    const emptyWorker = new ImDeliveryWorker({
      assembler: {} as never,
      database: { transaction: vi.fn().mockResolvedValue(undefined) } as never,
      domain: {} as never,
      registry: {} as never,
    });
    await emptyWorker.runOnce();
    expect(exporter.getFinishedSpans().filter((span) => span.name.startsWith("im.delivery."))).toHaveLength(0);

    const deliveryFailure = Object.assign(new Error("PRIVATE_DELIVERY_PROVIDER_BODY"), {
      code: "PRIVATE_DELIVERY_TOOL_PAYLOAD",
    });
    const failingWorker = new ImDeliveryWorker({
      assembler: {} as never,
      database: {
        transaction: vi.fn().mockResolvedValue({ id: randomUUID(), kind: "pending", claimToken: "claim" }),
        select: vi.fn(() => {
          throw deliveryFailure;
        }),
      } as never,
      domain: {} as never,
      registry: {} as never,
    });
    await expect(failingWorker.runOnce()).rejects.toBe(deliveryFailure);

    const outboundFailure = Object.assign(new Error("PRIVATE_OUTBOUND_PROVIDER_BODY"), {
      code: "PRIVATE_OUTBOUND_TOOL_OUTPUT",
    });
    const outbound = new OutboundMessageService(
      { transaction: vi.fn().mockRejectedValue(outboundFailure) } as never,
      vi.fn() as never,
    );
    await expect(
      outbound.execute({
        requestId: randomUUID(),
        sessionId: randomUUID(),
        agentId: randomUUID(),
        computerId: randomUUID(),
        computerInstanceId: randomUUID(),
        placementGeneration: 1,
        expectedLatestImMessageId: randomUUID(),
        operation: "send",
        content: {
          version: 1,
          fallbackText: "private outbound message body",
          blocks: [{ type: "text", text: "private outbound message body" }],
          truncated: false,
        },
      }),
    ).rejects.toBe(outboundFailure);

    const outboundProviderCode = "plain provider diagnostic with private sender name";
    const providerRequestId = randomUUID();
    const providerDatabase = {
      transaction: vi
        .fn()
        .mockResolvedValueOnce({
          request: { requestId: providerRequestId, admittedCredentialGeneration: 1 },
          scope: {
            imBinding: { id: randomUUID(), provider: "slack", externalBotId: "bot" },
            session: { channelId: "channel", threadKey: null },
          },
          targetExternalId: undefined,
        })
        .mockResolvedValueOnce({
          admitted: true,
          result: Promise.resolve({ ok: false, category: "unknown", code: outboundProviderCode }),
        })
        .mockResolvedValueOnce(undefined),
    };
    const outboundProviderFailure = new OutboundMessageService(
      providerDatabase as never,
      vi.fn().mockResolvedValue({
        send: vi.fn().mockResolvedValue({ ok: false, category: "unknown", code: outboundProviderCode }),
      }) as never,
    );
    await expect(
      outboundProviderFailure.execute({
        requestId: providerRequestId,
        sessionId: randomUUID(),
        agentId: randomUUID(),
        computerId: randomUUID(),
        computerInstanceId: randomUUID(),
        placementGeneration: 1,
        expectedLatestImMessageId: randomUUID(),
        operation: "send",
        content: {
          version: 1,
          fallbackText: "private provider-bound outbound body",
          blocks: [{ type: "text", text: "private provider-bound outbound body" }],
          truncated: false,
        },
      }),
    ).resolves.toEqual({ state: "unknown", code: "provider_unknown", retryAfterSeconds: undefined });

    const capture = JSON.stringify(
      exporter
        .getFinishedSpans()
        .map((span) => ({ attributes: span.attributes, events: span.events, status: span.status })),
    );
    expect(capture).not.toContain(inboxFailure.message);
    expect(capture).not.toContain(inboxFailure.code);
    expect(capture).not.toContain(deliveryFailure.message);
    expect(capture).not.toContain(deliveryFailure.code);
    expect(capture).not.toContain(outboundFailure.message);
    expect(capture).not.toContain(outboundFailure.code);
    expect(capture).not.toContain("private outbound message body");
    expect(capture).not.toContain(outboundProviderCode);
    expect(capture).not.toContain("private provider-bound outbound body");
    expect(exporter.getFinishedSpans().map((span) => span.name)).toEqual([
      "im.inbound.persist",
      "im.delivery.dispatch",
      "im.outbound.execute",
      "im.outbound.execute",
    ]);
  });

  it("does not emit a span for an empty delivery poll and ends a claimed dispatch span", async () => {
    const dispatch = vi.fn(async () => undefined);
    await traceDeliveryClaim(undefined, dispatch);
    expect(dispatch).not.toHaveBeenCalled();
    expect(exporter.getFinishedSpans()).toHaveLength(0);

    await traceDeliveryClaim({ id: "delivery-1", kind: "pending", claimToken: "claim" }, dispatch);
    expect(exporter.getFinishedSpans()).toHaveLength(1);
    expect(exporter.getFinishedSpans()[0]?.name).toBe("im.delivery.dispatch");
  });

  it("ends a claimed delivery span without replacing a dispatch rejection", async () => {
    const failure = new Error("delivery failure");
    await expect(
      traceDeliveryClaim({ id: "delivery-2", kind: "pending", claimToken: "claim" }, () => Promise.reject(failure)),
    ).rejects.toBe(failure);
    const span = exporter.getFinishedSpans()[0];
    expect(span?.name).toBe("im.delivery.dispatch");
    expect(span?.status.code).toBe(2);
  });

  it("does not create heartbeat frame spans and ends connection and business frame spans", async () => {
    const socket = {} as WebSocket;
    startRuntimeConnectionSpan(socket);
    await withRuntimeFrameSpan(socket, "heartbeat", {}, async () => undefined);
    await withRuntimeFrameSpan(socket, "turn:report", { payload: "must-not-export" }, async () => undefined);
    endRuntimeConnectionSpan(socket, 1000);

    const spans = exporter.getFinishedSpans();
    expect(spans.map((span) => span.name)).toEqual(["runtime.ws.frame turn:report", "runtime.ws.connection"]);
    expect(spans[0]?.attributes.payload).toBe("[scrubbed]");
    expect(spans[1]?.attributes[OPENTAG_ATTR.WS_CLOSE_CODE]).toBe(1000);
  });

  it("ends a failed Runtime frame span and preserves the handler rejection", async () => {
    const socket = {} as WebSocket;
    const failure = new Error("payload=must-not-export");
    startRuntimeConnectionSpan(socket);
    await expect(withRuntimeFrameSpan(socket, "turn:report", {}, () => Promise.reject(failure))).rejects.toBe(failure);
    endRuntimeConnectionSpan(socket, 1011);

    const spans = exporter.getFinishedSpans();
    expect(spans[0]?.status.code).toBe(2);
    expect(JSON.stringify(spans[0]?.events)).not.toContain("must-not-export");
    expect(spans[1]?.attributes[OPENTAG_ATTR.OPERATION_OUTCOME]).toBe("failed");
  });

  it("keeps Feishu callback rejection semantics and exports a safe error root", async () => {
    const failure = new Error("FEISHU_CONNECTION_LEASE_STALE");
    await expect(
      traceFeishuInbound((setFailureCode) => {
        setFailureCode("FEISHU_INBOUND_NORMALIZE_FAILED");
        return Promise.reject(failure);
      }),
    ).rejects.toBe(failure);
    const span = exporter.getFinishedSpans()[0];
    expect(span?.name).toBe("im.inbound.process");
    expect(span?.attributes[OPENTAG_ATTR.ERROR_CODE]).toBe("FEISHU_INBOUND_NORMALIZE_FAILED");
    expect(span?.attributes[OPENTAG_ATTR.OPERATION_OUTCOME]).toBe("failed");
  });

  it("drives the real FeishuConnectionManager callback and correlates setup connect by Agent and binding", async () => {
    const agentId = randomUUID();
    const bindingId = randomUUID();
    const normalizeFailure = Object.assign(new Error("PRIVATE_FEISHU_NORMALIZE_BODY"), {
      code: "PRIVATE_FEISHU_NORMALIZE_SENDER",
    });
    const databaseFailure = Object.assign(new Error("PRIVATE_FEISHU_DATABASE_BODY"), {
      code: "PRIVATE_FEISHU_DATABASE_SENDER",
    });
    const fenceTransaction = {
      update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn().mockResolvedValue([]) })) })),
      select: vi.fn(() =>
        resolvedQuery([
          {
            agent: { computerId: randomUUID() },
            imBinding: {
              connectionFencingEpoch: 1,
              connectionLeaseExpiresAt: new Date(Date.now() + 60_000),
              connectionOwnerInstanceId: "another-instance",
              externalAppId: "app-1",
              externalBotId: "bot-test",
              externalTeamId: null,
              provider: "feishu",
            },
          },
        ]),
      ),
    };
    const inbox = new ImMessageInbox({
      transaction: vi
        .fn()
        .mockImplementationOnce(async (run: (transaction: unknown) => Promise<unknown>) => run(fenceTransaction))
        .mockRejectedValueOnce(databaseFailure),
    } as never);
    let messageHandler: ((message: never) => Promise<void>) | undefined;
    let releaseValidation:
      | ((value: { externalAppId: string; externalTeamId: string; externalBotId: string }) => void)
      | undefined;
    const validation = new Promise<{ externalAppId: string; externalTeamId: string; externalBotId: string }>(
      (resolve) => {
        releaseValidation = resolve;
      },
    );
    const normalizeInbound = vi
      .fn()
      .mockImplementationOnce(() => {
        throw normalizeFailure;
      })
      .mockReturnValue([normalizedInboundEvent()]);
    const database = {
      transaction: vi.fn().mockResolvedValue({
        imBindingId: bindingId,
        epoch: 1,
        material: { appId: "cli-test", generation: 1 },
      }),
      update: vi.fn(() => ({
        set: vi.fn(() => ({ where: vi.fn().mockResolvedValue([]) })),
      })),
    };
    const manager = new FeishuConnectionManager({
      database: database as never,
      inbox,
      instanceId: randomUUID(),
      imBindings: {} as never,
      createAdapter: () =>
        ({
          channel: {
            on: (handlers: { message: (message: never) => Promise<void> }) => {
              messageHandler = handlers.message;
              return () => undefined;
            },
            disconnect: vi.fn().mockResolvedValue(undefined),
          },
          validateBinding: vi.fn(() => validation),
          listGrantedTeamScopes: vi.fn().mockResolvedValue([...FEISHU_REQUIRED_TENANT_SCOPES]),
          normalizeInbound,
        }) as never,
    });
    const activation = manager.activateAtomicAttempt({
      attemptId: randomUUID(),
      ownerInstanceId: randomUUID(),
      agentId,
      appId: "cli-test",
      appSecret: "must-not-export",
      teamBrand: "feishu",
    });
    await vi.waitFor(() => expect(messageHandler).toBeTypeOf("function"));
    if (!messageHandler) throw new Error("Feishu callback was not attached");
    await expect(messageHandler({} as never)).rejects.toMatchObject({ code: "FEISHU_ADMISSION_NOT_READY" });
    releaseValidation?.({ externalAppId: "cli-test", externalTeamId: "team-test", externalBotId: "bot-test" });
    await expect(activation).resolves.toMatchObject({ agentId, appId: "cli-test" });
    await expect(messageHandler({} as never)).rejects.toBe(normalizeFailure);
    await expect(messageHandler({} as never)).rejects.toBeInstanceOf(ImInboundPersistenceError);
    await expect(messageHandler({} as never)).rejects.toBe(databaseFailure);
    await manager.stop();

    const spans = exporter.getFinishedSpans();
    const connect = spans.find((span) => span.name === "feishu.connection.connect");
    expect(connect?.attributes[OPENTAG_ATTR.AGENT_ID]).toBe(agentId);
    expect(connect?.attributes[OPENTAG_ATTR.IM_BINDING_ID]).toBe(bindingId);
    const inbound = spans.filter((span) => span.name === "im.inbound.process");
    expect(inbound.slice(1).every((span) => span.attributes[OPENTAG_ATTR.IM_BINDING_ID] === bindingId)).toBe(true);
    expect(inbound.map((span) => span.attributes[OPENTAG_ATTR.ERROR_CODE])).toEqual(
      expect.arrayContaining([
        "FEISHU_INBOUND_ADMISSION_FAILED",
        "FEISHU_INBOUND_NORMALIZE_FAILED",
        "FEISHU_INBOUND_FENCE_STALE",
        "FEISHU_INBOUND_DATABASE_FAILED",
      ]),
    );
    const persistenceCodes = spans
      .filter((span) => span.name === "im.inbound.persist")
      .map((span) => span.attributes[OPENTAG_ATTR.ERROR_CODE]);
    expect(persistenceCodes).toEqual(expect.arrayContaining(["IM_INBOUND_FENCE_STALE", "IM_INBOUND_DATABASE_FAILED"]));
    const disconnected = spans.find(
      (span) =>
        span.name === "feishu.connection.transition" &&
        span.attributes[OPENTAG_ATTR.OPERATION_OUTCOME] === "disconnected",
    );
    expect(disconnected?.attributes[OPENTAG_ATTR.IM_BINDING_ID]).toBe(bindingId);
    expect(disconnected?.attributes[OPENTAG_ATTR.ERROR_CODE]).toBe("FEISHU_CONNECTION_STOPPED");
    const capture = JSON.stringify(
      spans.map((span) => ({ attributes: span.attributes, events: span.events, status: span.status })),
    );
    expect(capture).not.toContain(normalizeFailure.message);
    expect(capture).not.toContain(normalizeFailure.code);
    expect(capture).not.toContain(databaseFailure.message);
    expect(capture).not.toContain(databaseFailure.code);
    expect(capture).not.toContain("must-not-export");
  });

  it("traces real RuntimeSession failure, overload, and dropped-queue terminal paths", async () => {
    let releaseSlow: (() => void) | undefined;
    let markSlowStarted: (() => void) | undefined;
    const slow = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    const slowStarted = new Promise<void>((resolve) => {
      markSlowStarted = resolve;
    });
    const app = createApp({
      authService: runtimeAuthService() as never,
      computerService: runtimeComputerService() as never,
      runtime: {
        registry: new ConnectionRegistry(),
        business: {
          parse: (value) => runtimeTestFrame(value),
          laneKey: (frame) => String(frame.key),
          handle: async (frame) => {
            if (frame.key === "fail") throw new Error("private runtime tool payload");
            if (frame.key === "fallback-fail") throw new Error("PRIVATE_RUNTIME_HANDLER_BODY");
            if (frame.key === "slow") {
              markSlowStarted?.();
              await slow;
            }
            return { type: "test:result", requestId: frame.requestId, status: "ok" };
          },
          overloadResult: (frame) => ({ type: "test:result", requestId: frame.requestId, status: "busy" }),
          failureResult: (frame) => {
            if (frame.key === "fallback-fail") throw new Error("PRIVATE_RUNTIME_FALLBACK_TOOL_PAYLOAD");
            return { type: "test:result", requestId: frame.requestId, status: "failed" };
          },
          maxConcurrent: 1,
          maxQueuedPerKey: 1,
          maxQueuedTotal: 1,
        },
      },
    });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const socket = new WebSocket(`${address.replace("http", "ws")}${HTTP_PATHS.computerRuntimeWebSocket}`);
    const frames = websocketFrames(socket);
    await websocketOpened(socket);
    socket.send(JSON.stringify({ type: "auth", requestId: randomUUID(), protocolVersion: 1, accessToken: "token" }));
    expect(await frames.next()).toMatchObject({ type: "auth:result", ok: true });
    expect(await frames.next()).toMatchObject({ type: "server:welcome" });
    const registration = {
      type: "computer:register",
      requestId: randomUUID(),
      computerId: randomUUID(),
      instanceId: randomUUID(),
      displayName: "test",
      platform: "linux",
      arch: "x64",
      clientVersion: "0.0.1",
    };
    socket.send(JSON.stringify(registration));
    expect(await frames.next()).toMatchObject({ type: "computer:register:result", ok: true });

    socket.send(JSON.stringify({ type: "test:work", requestId: randomUUID(), key: "fail" }));
    expect(await frames.next()).toMatchObject({ type: "test:result", status: "failed" });

    socket.send(JSON.stringify({ type: "test:work", requestId: randomUUID(), key: "fallback-fail" }));
    await vi.waitFor(() => {
      expect(
        exporter
          .getFinishedSpans()
          .filter(
            (span) =>
              span.name === "runtime.ws.frame test:work" &&
              span.attributes[OPENTAG_ATTR.OPERATION_OUTCOME] === "failed",
          ),
      ).toHaveLength(2);
    });

    socket.send(JSON.stringify({ type: "test:work", requestId: randomUUID(), key: "slow" }));
    await slowStarted;
    socket.send(JSON.stringify({ type: "test:work", requestId: randomUUID(), key: "slow" }));
    const overloadedRequestId = randomUUID();
    socket.send(JSON.stringify({ type: "test:work", requestId: overloadedRequestId, key: "slow" }));
    expect(await frames.next()).toMatchObject({ type: "test:result", requestId: overloadedRequestId, status: "busy" });
    socket.close();
    await new Promise<void>((resolve) => socket.once("close", () => resolve()));
    releaseSlow?.();
    await vi.waitFor(() => {
      const outcomes = exporter
        .getFinishedSpans()
        .filter((span) => span.name === "runtime.ws.frame test:work")
        .map((span) => span.attributes[OPENTAG_ATTR.OPERATION_OUTCOME]);
      expect(outcomes).toEqual(expect.arrayContaining(["failed", "overloaded", "stale_connection"]));
      expect(outcomes).toHaveLength(5);
    });
    await app.close();
    expect(
      JSON.stringify(
        exporter.getFinishedSpans().map((span) => ({
          attributes: span.attributes,
          events: span.events,
          status: span.status,
        })),
      ),
    ).not.toContain("private runtime tool payload");
    expect(JSON.stringify(exporter.getFinishedSpans().map((span) => span.events))).not.toContain(
      "PRIVATE_RUNTIME_FALLBACK_TOOL_PAYLOAD",
    );
  });

  it("traces real RuntimeDomainOwner terminal outcomes and never exports Runtime payloads", async () => {
    const registry = new ConnectionRegistry();
    const computerId = randomUUID();
    const instanceId = randomUUID();
    const userId = randomUUID();
    const frames: unknown[] = [];
    await registry.register(
      {
        computerId,
        instanceId,
        lastHeartbeatAt: 1,
        socket: runtimeDomainSocket(frames),
        userId,
      },
      async () => undefined,
    );
    const custody = {
      beginDeliveryDispatch: vi.fn().mockResolvedValue("dispatched"),
      acceptDelivery: vi.fn().mockResolvedValue("accepted"),
      claimRetainedReports: vi.fn().mockResolvedValue(undefined),
      getDelivery: vi.fn().mockResolvedValue(undefined),
      getDeliveryByTurn: vi.fn().mockResolvedValue(undefined),
      getTurn: vi.fn().mockResolvedValue(undefined),
      recordTurn: vi.fn().mockResolvedValue("recorded"),
    };
    const owner = new RuntimeDomainOwner(registry, custody as never, { requestTimeoutMs: 1_000 });
    const context = { computerId, instanceId, signal: new AbortController().signal, userId };

    const acceptedRequest = runtimeDeliveryRequest();
    const accepted = owner.requestDelivery(computerId, instanceId, acceptedRequest);
    await waitForRuntimeFrame(frames, acceptedRequest.requestId);
    await owner.handle(runtimeDeliveryResult(acceptedRequest, "accepted"), context);
    await expect(accepted).resolves.toMatchObject({ status: "accepted" });

    const rejectedRequest = runtimeDeliveryRequest();
    const rejected = owner.requestDelivery(computerId, instanceId, rejectedRequest);
    await waitForRuntimeFrame(frames, rejectedRequest.requestId);
    await owner.handle(runtimeDeliveryResult(rejectedRequest, "rejected"), context);
    await expect(rejected).resolves.toMatchObject({ status: "rejected" });

    const recoveryRequest = runtimeReconcileRequest(computerId);
    const recovery = owner.requestReconcile(computerId, instanceId, recoveryRequest);
    await owner.handle(
      {
        type: "session:reconcile:result",
        requestId: recoveryRequest.requestId,
        sessionId: recoveryRequest.sessionId,
        placementGeneration: recoveryRequest.placementGeneration,
        status: "recovery_required",
        reason: "unresolved_turn",
        retainedReports: [],
      },
      context,
    );
    await expect(recovery).resolves.toMatchObject({ status: "recovery_required" });

    const reconcileRejectedRequest = runtimeReconcileRequest(computerId);
    const reconcileRejected = owner.requestReconcile(computerId, instanceId, reconcileRejectedRequest);
    await owner.handle(
      {
        type: "session:reconcile:result",
        requestId: reconcileRejectedRequest.requestId,
        sessionId: reconcileRejectedRequest.sessionId,
        placementGeneration: reconcileRejectedRequest.placementGeneration,
        status: "rejected",
        reason: "placement_stale",
      },
      context,
    );
    await expect(reconcileRejected).resolves.toMatchObject({ status: "rejected" });

    const conflictRequest = runtimeReconcileRequest(computerId);
    const pendingConflict = owner
      .requestReconcile(computerId, instanceId, conflictRequest)
      .catch((error: unknown) => error);
    expect(() =>
      owner.requestReconcile(computerId, instanceId, { ...conflictRequest, sessionId: randomUUID() }),
    ).toThrow();
    owner.close();
    await expect(pendingConflict).resolves.toBeInstanceOf(Error);

    const reportBody = {
      deliveryId: acceptedRequest.deliveryId,
      turnId: randomUUID(),
      sessionId: acceptedRequest.sessionId,
      agentId: acceptedRequest.agentId,
      placementGeneration: acceptedRequest.placementGeneration,
      outcome: "completed" as const,
      executionEffects: "completed" as const,
      finalText: "private Runtime model output",
      usage: { inputTokens: 1, outputTokens: 1 },
      traceSummary: { lastSequence: 1, droppedEvents: 0 },
    };
    await owner.handle(
      {
        type: "turn:report",
        requestId: randomUUID(),
        ...reportBody,
        resultHash: computeTurnResultHash(reportBody),
      },
      context,
    );

    const timeoutOwner = new RuntimeDomainOwner(registry, custody as never, { requestTimeoutMs: 2 });
    const timeoutRequest = runtimeReconcileRequest(computerId);
    await expect(timeoutOwner.requestReconcile(computerId, instanceId, timeoutRequest)).rejects.toThrow();
    timeoutOwner.close();

    const failingRegistry = new ConnectionRegistry();
    const failingComputerId = randomUUID();
    const failingInstanceId = randomUUID();
    await failingRegistry.register(
      {
        computerId: failingComputerId,
        instanceId: failingInstanceId,
        lastHeartbeatAt: 1,
        socket: runtimeDomainSocket([], new Error("plain Runtime send payload with private prompt")),
        userId,
      },
      async () => undefined,
    );
    const failingOwner = new RuntimeDomainOwner(failingRegistry, custody as never);
    const sendFailureRequest = runtimeReconcileRequest(failingComputerId);
    await expect(
      failingOwner.requestReconcile(failingComputerId, failingInstanceId, sendFailureRequest),
    ).rejects.toThrow();
    failingOwner.close();

    const typedRegistryFailures = [
      [new RuntimeRegistrySendError("instance_replaced", "PRIVATE_REPLACED_RUNTIME_BODY"), "RUNTIME_INSTANCE_REPLACED"],
      [new RuntimeRegistrySendError("frame_too_large", "PRIVATE_FRAME_RUNTIME_BODY"), "RUNTIME_FRAME_TOO_LARGE"],
    ] as const;
    const typedFailureRequests: Array<{ expectedCode: string; requestId: string }> = [];
    for (const [error, expectedCode] of typedRegistryFailures) {
      const request = runtimeReconcileRequest(randomUUID());
      const typedFailureOwner = new RuntimeDomainOwner(
        { send: vi.fn().mockRejectedValue(error) } as never,
        custody as never,
      );
      typedFailureRequests.push({ expectedCode, requestId: request.requestId });
      await expect(typedFailureOwner.requestReconcile(request.computerId, randomUUID(), request)).rejects.toBe(error);
      typedFailureOwner.close();
    }

    const capacityOwner = new RuntimeDomainOwner(registry, custody as never, {
      maxPendingRequests: 1,
      requestTimeoutMs: 1_000,
    });
    const capacityPendingRequest = runtimeReconcileRequest(computerId);
    const capacityPending = capacityOwner
      .requestReconcile(computerId, instanceId, capacityPendingRequest)
      .catch((error: unknown) => error);
    const capacityRejectedRequest = runtimeReconcileRequest(computerId);
    expect(() => capacityOwner.requestReconcile(computerId, instanceId, capacityRejectedRequest)).toThrow();
    capacityOwner.close();
    await expect(capacityPending).resolves.toBeInstanceOf(Error);

    const spans = exporter.getFinishedSpans();
    expect(
      spans
        .filter((span) => span.name === "runtime.delivery")
        .map((span) => span.attributes[OPENTAG_ATTR.OPERATION_OUTCOME]),
    ).toEqual(expect.arrayContaining(["accepted", "rejected"]));
    expect(
      spans
        .filter((span) => span.name === "runtime.reconcile")
        .map((span) => span.attributes[OPENTAG_ATTR.OPERATION_OUTCOME]),
    ).toEqual(expect.arrayContaining(["recovery_required", "rejected"]));
    expect(spans.find((span) => span.name === "runtime.report")?.attributes[OPENTAG_ATTR.OPERATION_OUTCOME]).toBe(
      "recorded",
    );
    const errorCodesForRequest = (requestId: string) =>
      spans
        .filter((span) => span.attributes[OPENTAG_ATTR.REQUEST_ID] === requestId)
        .map((span) => span.attributes[OPENTAG_ATTR.ERROR_CODE]);
    expect(errorCodesForRequest(conflictRequest.requestId)).toEqual(
      expect.arrayContaining(["RUNTIME_REQUEST_CONFLICT", "RUNTIME_OWNER_STOPPED"]),
    );
    expect(errorCodesForRequest(timeoutRequest.requestId)).toContain("RUNTIME_REQUEST_TIMEOUT");
    expect(errorCodesForRequest(sendFailureRequest.requestId)).toContain("RUNTIME_SEND_UNAVAILABLE");
    for (const request of typedFailureRequests) {
      expect(errorCodesForRequest(request.requestId)).toContain(request.expectedCode);
    }
    expect(errorCodesForRequest(capacityRejectedRequest.requestId)).toContain("RUNTIME_OWNER_CAPACITY");
    expect(errorCodesForRequest(capacityPendingRequest.requestId)).toContain("RUNTIME_OWNER_STOPPED");
    const capture = JSON.stringify(
      spans.map((span) => ({ attributes: span.attributes, events: span.events, status: span.status })),
    );
    expect(capture).not.toContain("private Runtime model output");
    expect(capture).not.toContain("plain Runtime send payload with private prompt");
    expect(capture).not.toContain("PRIVATE_REPLACED_RUNTIME_BODY");
    expect(capture).not.toContain("PRIVATE_FRAME_RUNTIME_BODY");
  });
});

describe("HTTP tracing", () => {
  it("excludes static, probe, and Runtime WebSocket routes from HTTP tracing", () => {
    expect(ignoreHttpTraceRoute("/")).toBe(true);
    expect(ignoreHttpTraceRoute("/healthz")).toBe(true);
    expect(ignoreHttpTraceRoute("/readyz")).toBe(true);
    expect(ignoreHttpTraceRoute("/assets/app.js")).toBe(true);
    expect(ignoreHttpTraceRoute("/fonts/inter.woff2")).toBe(true);
    expect(ignoreHttpTraceRoute(HTTP_PATHS.computerRuntimeWebSocket)).toBe(true);
    expect(ignoreHttpTraceRoute("/api/v1/agents")).toBe(false);
  });

  it("creates one route-template root, adds x-trace-id, and excludes query values", async () => {
    const app = createApp();
    app.get("/trace-test/:id", async () => ({ ok: true }));
    const response = await app.inject({ method: "GET", url: "/trace-test/123?token=query-secret" });
    await app.close();

    expect(response.headers["x-trace-id"]).toMatch(/^[0-9a-f]{32}$/);
    const httpSpans = exporter.getFinishedSpans().filter((span) => span.name === "GET /trace-test/:id");
    expect(httpSpans).toHaveLength(1);
    expect(JSON.stringify(httpSpans[0]?.attributes)).not.toContain("query-secret");
  });

  it("does not trace health or readiness probes", async () => {
    const app = createApp();
    await app.inject({ method: "GET", url: "/healthz" });
    await app.inject({ method: "GET", url: "/readyz" });
    await app.close();
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });
});

function normalizedInboundEvent() {
  return {
    providerEventId: "event-1",
    externalAppId: "app-1",
    externalTeamId: "team-1",
    conversation: { externalId: "channel-1", kind: "channel" as const },
    message: {
      externalId: "message-1",
      operation: "created" as const,
      revisionKey: "1",
      author: { externalId: "user-1", displayName: "Alice Sender", kind: "human" as const },
      occurredAt: new Date("2026-08-20T00:00:00.000Z"),
      content: {
        version: 1 as const,
        fallbackText: "plain inbound message body",
        blocks: [{ type: "text" as const, text: "plain inbound message body" }],
        truncated: false,
      },
      resources: [],
    },
    mentions: [],
  };
}

interface ResolvedQuery<T> extends Promise<T[]> {
  for(): Promise<T[]>;
  from(): ResolvedQuery<T>;
  innerJoin(): ResolvedQuery<T>;
  limit(): ResolvedQuery<T>;
  where(): ResolvedQuery<T>;
}

function resolvedQuery<T>(rows: T[]): ResolvedQuery<T> {
  const result = Promise.resolve(rows);
  let query: ResolvedQuery<T>;
  query = Object.assign(result, {
    for: () => result,
    from: () => query,
    innerJoin: () => query,
    limit: () => query,
    where: () => query,
  });
  return query;
}

function runtimeAuthService() {
  return {
    getAuthenticatedUser: vi.fn().mockResolvedValue({
      me: {
        user: { id: randomUUID(), email: "admin@example.com", displayName: "Admin" },
        memberships: [],
      },
      tokenExpiresAt: new Date(Date.now() + 60_000),
    }),
  };
}

function runtimeComputerService() {
  return {
    register: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(true),
    heartbeat: vi.fn().mockResolvedValue(true),
  };
}

function runtimeSnapshot(agentId: string): EffectiveRuntimeSnapshot {
  return {
    revision: {
      agent: { sequence: 1, id: "agent-revision-1" },
      session: { sequence: 1, id: "session-revision-1" },
    },
    agentId,
    provider: "codex",
    instructions: {
      platform: "private platform prompt",
      agent: "private agent prompt",
      session: "private session prompt",
    },
    allowedTools: [],
    execution: { approvalPolicy: "never", networkAccess: false },
    workspace: { workspaceId: "workspace-1", mode: "empty_on_create", sharing: "agent" },
  };
}

function runtimeReconcileRequest(computerId: string): SessionReconcileRequest {
  const agentId = randomUUID();
  return {
    type: "session:reconcile",
    requestId: randomUUID(),
    computerId,
    sessionId: randomUUID(),
    agentId,
    placementGeneration: 1,
    desired: "ready",
    runtime: runtimeSnapshot(agentId),
  };
}

function runtimeDeliveryRequest(): DirectImMessageDeliveryRequest {
  const agentId = randomUUID();
  return {
    type: "im:deliver",
    requestId: randomUUID(),
    deliveryId: randomUUID(),
    imMessageId: randomUUID(),
    sessionId: randomUUID(),
    agentId,
    placementGeneration: 1,
    attention: "direct",
    content: { kind: "text", text: "private inbound message and tool payload" },
    runtime: runtimeSnapshot(agentId),
  };
}

function runtimeDeliveryResult(request: DirectImMessageDeliveryRequest, status: "accepted" | "rejected") {
  return {
    type: "im:deliver:result" as const,
    requestId: request.requestId,
    deliveryId: request.deliveryId,
    sessionId: request.sessionId,
    placementGeneration: request.placementGeneration,
    status,
    ...(status === "accepted" ? { turnId: randomUUID() } : { reason: "target_mismatch" as const }),
  };
}

async function waitForRuntimeFrame(frames: unknown[], requestId: string): Promise<void> {
  await vi.waitFor(() => {
    expect(frames).toEqual(expect.arrayContaining([expect.objectContaining({ requestId })]));
  });
}

function runtimeDomainSocket(frames: unknown[], failure?: Error): WebSocket {
  return {
    readyState: WebSocket.OPEN,
    close: vi.fn(),
    terminate: vi.fn(),
    send: vi.fn((serialized: string, callback: (error?: Error) => void) => {
      frames.push(JSON.parse(serialized));
      callback(failure);
    }),
  } as unknown as WebSocket;
}

function runtimeTestFrame(value: unknown): (Record<string, unknown> & { type: string }) | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const frame = value as Record<string, unknown>;
  return frame.type === "test:work" && typeof frame.requestId === "string" && typeof frame.key === "string"
    ? (frame as Record<string, unknown> & { type: string })
    : undefined;
}

function websocketOpened(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) return Promise.resolve();
  return new Promise((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
}

function websocketFrames(socket: WebSocket) {
  const queued: Record<string, unknown>[] = [];
  const waiters: Array<(frame: Record<string, unknown>) => void> = [];
  socket.on("message", (data) => {
    const frame = JSON.parse(data.toString()) as Record<string, unknown>;
    const waiter = waiters.shift();
    if (waiter) waiter(frame);
    else queued.push(frame);
  });
  return {
    next: () => {
      const frame = queued.shift();
      return frame ? Promise.resolve(frame) : new Promise<Record<string, unknown>>((resolve) => waiters.push(resolve));
    },
  };
}
