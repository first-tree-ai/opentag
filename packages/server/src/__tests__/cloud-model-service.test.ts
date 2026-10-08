import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CloudBilling } from "../cloud-billing.js";
import { users } from "../db/schema/index.js";
import { CloudAgentRuntimeTester } from "../services/agents/cloud-agent-runtime-tester.js";
import { CloudCallStore } from "../services/cloud-call-store.js";
import { CloudModelService, CloudUsageObserver, parseCloudUsage } from "../services/cloud-model-service.js";
import { CloudUsageService } from "../services/cloud-usage.js";
import { createStaticCloudModelCatalog } from "../services/sandboxes/cloud-model-catalog.js";
import { createUnitDatabase } from "./support/unit-database.js";

const config = {
  enabled: true as const,
  gatewayId: "litellm",
  upstreamBaseUrl: "https://gateway.example/v1",
  masterKey: "platform-key",
  tokenTtlSeconds: 60,
  maxStreamsPerToken: 2,
  requestTimeoutMs: 1000,
  maxRequestBytes: 65536,
  maxResponseBytes: 65536,
};
const context = { accountId: randomUUID(), agentId: randomUUID(), sessionId: null, source: "execution" as const };
const body = { model: "model-a", messages: [{ role: "user", content: "hello" }] };
const rates = { inputMicrosPerMillion: 1, cachedInputMicrosPerMillion: 1, outputMicrosPerMillion: 1 };
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture(billed = false) {
  const unit = await createUnitDatabase();
  cleanups.push(() => unit.close());
  await unit.database.insert(users).values({ id: context.accountId, email: "cloud@example.com", displayName: "Cloud" });
  const calls = new CloudCallStore({ query: (statement, parameters) => unit.engine.query(statement, parameters) });
  const billing = {
    beginCall: vi.fn<CloudBilling["beginCall"]>((context, model) => calls.create(context, model, rates)),
    observeCall: vi.fn<CloudBilling["observeCall"]>((id, value) => calls.observe(id, value)),
    finishCall: vi.fn<CloudBilling["finishCall"]>(async (id) => {
      const call = await calls.get(id);
      await calls.db.query("UPDATE billing.attempts SET state=$2,resolution=$3 WHERE id=$1", [
        id,
        call.usage_complete ? "finalized" : "pending_usage",
        call.usage_complete ? "charged" : null,
      ]);
    }),
  };
  const fetchImpl = vi.fn<typeof fetch>();
  const service = new CloudModelService(config, {
    calls,
    fetchImpl,
    ...(billed ? { billing: billing as unknown as CloudBilling } : {}),
  });
  cleanups.push(() => service.close());
  return { unit, calls, billing, fetchImpl, service };
}
describe("single cloud gateway lifecycle", () => {
  it("normalizes cache counts as a subset and ignores separate reasoning-token details", () => {
    expect(
      parseCloudUsage({
        id: "r",
        usage: {
          prompt_tokens: 1000,
          completion_tokens: 200,
          prompt_tokens_details: { cached_tokens: 600 },
          completion_tokens_details: { reasoning_tokens: 100 },
        },
      }),
    ).toEqual({ responseId: "r", inputTokens: 1000, cachedInputTokens: 600, outputTokens: 200, complete: true });
    expect(parseCloudUsage({ id: "r", usage: { prompt_tokens: -1, completion_tokens: 1 } })).toEqual({
      responseId: "r",
      outputTokens: 1,
      complete: false,
    });
  });
  it("preserves usable counts when cache metadata is malformed and leaves cache unknown", () => {
    expect(
      parseCloudUsage({
        usage: { prompt_tokens: 4, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 9 } },
      }),
    ).toEqual({ inputTokens: 4, outputTokens: 2, complete: true });
    expect(
      parseCloudUsage({
        usage: { prompt_tokens: 4, completion_tokens: 2, prompt_tokens_details: { cached_tokens: "0" } },
      }),
    ).toEqual({ inputTokens: 4, outputTokens: 2, complete: true });
  });
  it("observes fragmented SSE once and never counts output chunks as tokens", async () => {
    const observed = vi.fn().mockResolvedValue(undefined);
    const observer = new CloudUsageObserver(true, observed, 1024);
    const text =
      'data: {"id":"r","choices":[{"delta":{"content":"hello"}}]}\n\ndata: {"id":"r","usage":{"prompt_tokens":4,"completion_tokens":2}}\n\ndata: [DONE]\n';
    const bytes = new TextEncoder().encode(text);
    for (let i = 0; i < bytes.length; i += 7) await observer.push(bytes.slice(i, i + 7));
    await observer.finish();
    expect(observed.mock.calls.map(([value]) => value)).toEqual([
      { responseId: "r", complete: false },
      { responseId: "r", inputTokens: 4, outputTokens: 2, complete: true },
    ]);
  });
  it.each([false, true])("uses the same configured gateway with billing enabled=%s", async (billed) => {
    const { service, fetchImpl, calls, billing } = await fixture(billed);
    const responseBody = {
      id: "response",
      usage: { prompt_tokens: 1000, completion_tokens: 200, prompt_tokens_details: { cached_tokens: 600 } },
      choices: [],
    };
    fetchImpl.mockResolvedValue(Response.json(responseBody, { headers: { "x-litellm-call-id": "gateway-call" } }));
    const response = await service.request(body, new AbortController().signal, config, context);
    expect(await response.json()).toEqual(responseBody);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://gateway.example/v1/chat/completions",
      expect.objectContaining({ headers: expect.objectContaining({ authorization: "Bearer platform-key" }) }),
    );
    const [row] = (await calls.db.query("SELECT * FROM billing.attempts")).rows as Array<{ id: string }>;
    if (!row) throw new Error("Missing record");
    expect(await calls.get(row.id)).toMatchObject({
      account: context.accountId,
      agent_id: context.agentId,
      provider_call_id: "gateway-call",
      response_id: "response",
      input_tokens: 1000,
      cached_input_tokens: 600,
      output_tokens: 200,
      state: "finalized",
    });
    expect(billing.beginCall).toHaveBeenCalledTimes(billed ? 1 : 0);
  });
  it("forces final streaming usage even when a caller disables it", async () => {
    const { service, fetchImpl } = await fixture();
    fetchImpl.mockResolvedValue(
      new Response('data: {"id":"r","usage":{"prompt_tokens":3,"completion_tokens":2}}\n\ndata: [DONE]\n', {
        headers: { "content-type": "text/event-stream" },
      }),
    );
    const response = await service.request(
      { ...body, stream: true, stream_options: { include_usage: false } },
      new AbortController().signal,
      config,
      context,
    );
    await response.text();
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toMatchObject({
      stream_options: { include_usage: true },
    });
  });
  it("does not send a gateway request when admission fails", async () => {
    const { service, billing, fetchImpl } = await fixture(true);
    billing.beginCall.mockRejectedValue(Object.assign(new Error("empty"), { statusCode: 402 }));
    await expect(service.request(body, new AbortController().signal, config, context)).rejects.toMatchObject({
      statusCode: 402,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(service.active.size).toBe(0);
  });
  it("requires trusted attribution before sending a metered call", async () => {
    const { service, fetchImpl } = await fixture();
    await expect(service.request(body, new AbortController().signal, config)).rejects.toThrow("trusted attribution");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("marks uncertain network failures for settlement instead of assuming zero usage", async () => {
    const { service, billing } = await fixture(true);
    const { fetchImpl } = service;
    vi.mocked(fetchImpl).mockRejectedValue(new Error("network"));
    await expect(service.request(body, new AbortController().signal, config, context)).rejects.toThrow();
    expect(billing.finishCall).toHaveBeenCalledWith(expect.any(String), "finished");
  });
  it("settles after timeout and releases an unread stream", async () => {
    const { service, billing, fetchImpl } = await fixture(true);
    fetchImpl.mockResolvedValue(
      new Response(
        new ReadableStream({
          start: (controller) => controller.enqueue(new TextEncoder().encode('data: {"id":"r"}\n\n')),
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
    );
    const response = await service.request(
      { ...body, stream: true },
      new AbortController().signal,
      { ...config, requestTimeoutMs: 20 },
      context,
    );
    await expect(response.text()).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(billing.finishCall).toHaveBeenCalledWith(expect.any(String), "finished");
    expect(service.active.size).toBe(0);
  });
  it("records cloud probes through the same gateway service with agent attribution", async () => {
    const { service, fetchImpl, calls } = await fixture();
    fetchImpl.mockResolvedValue(
      Response.json({
        id: "r",
        choices: [{ message: { role: "assistant", content: "ok" } }],
        usage: { prompt_tokens: 5, completion_tokens: 1 },
      }),
    );
    const tester = new CloudAgentRuntimeTester({
      config,
      catalog: createStaticCloudModelCatalog(["model-a"]),
      modelService: service,
    });
    expect(
      await tester.test({
        accountId: context.accountId,
        agentId: context.agentId,
        computerId: randomUUID(),
        model: "model-a",
      }),
    ).toEqual({ status: "passed" });
    tester.close();
    expect((await calls.db.query("SELECT source,agent_id FROM billing.attempts")).rows).toEqual([
      { source: "connectivity_probe", agent_id: context.agentId },
    ]);
  });
  it("recovers usage by matching gateway identity without treating an absent log as free", async () => {
    const { service, fetchImpl } = await fixture();
    fetchImpl
      .mockResolvedValueOnce(Response.json([]))
      .mockResolvedValueOnce(
        Response.json([{ request_id: "response", model_group: "model-a", prompt_tokens: 10, completion_tokens: 2 }]),
      );
    expect(await service.lookup("call", "response", "model-a")).toMatchObject({
      inputTokens: 10,
      outputTokens: 2,
      complete: true,
    });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("https://gateway.example/spend/logs?request_id=call");
    fetchImpl.mockResolvedValue(Response.json([]));
    expect(await service.lookup("call", null, "model-a")).toBeUndefined();
  });
  it("refuses ambiguous or unrelated spend-log rows", async () => {
    const { service, fetchImpl } = await fixture();
    fetchImpl.mockResolvedValue(Response.json([{ request_id: "other", prompt_tokens: 1, completion_tokens: 1 }]));
    expect(await service.lookup("call", null, "model-a")).toBeUndefined();
    fetchImpl.mockResolvedValue(
      Response.json([{ request_id: "call", model_group: "other", prompt_tokens: 1, completion_tokens: 1 }]),
    );
    expect(await service.lookup("call", null, "model-a")).toBeUndefined();
    fetchImpl.mockResolvedValue(
      Response.json([
        { request_id: "call", prompt_tokens: 1, completion_tokens: 1 },
        { request_id: "call", prompt_tokens: 2, completion_tokens: 2 },
      ]),
    );
    expect(await service.lookup("call", null, "model-a")).toBeUndefined();
  });
  it("marks abandoned calls pending before readiness without waiting for gateway recovery", async () => {
    const { service, calls, fetchImpl } = await fixture(true);
    const id = await calls.create(context, { gateway: "litellm", model: "model-a" }, rates);
    await calls.observe(id, { providerCallId: "call", complete: false });
    fetchImpl.mockImplementation(
      async (_input, init) =>
        new Promise((_resolve, reject) => {
          if (init?.signal?.aborted) reject(new Error("cancelled"));
          else init?.signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
        }),
    );
    await service.initialize();
    expect((await calls.get(id)).state).toBe("pending_usage");
    expect(service.job).toBeDefined();
    await service.close();
  });
  it("preserves pending records across restart and recovers into the existing record", async () => {
    const { service, calls, fetchImpl } = await fixture(true);
    const id = await calls.create(context, { gateway: "litellm", model: "model-a" }, rates);
    await calls.observe(id, { providerCallId: "call", complete: false });
    fetchImpl.mockResolvedValue(
      Response.json([{ request_id: "response", litellm_call_id: "call", prompt_tokens: 10, completion_tokens: 2 }]),
    );
    await service.initialize();
    await service.job;
    expect((await calls.get(id)).state).toBe("finalized");
    expect((await calls.db.query("SELECT * FROM billing.attempts")).rows).toHaveLength(1);
  });
  it("reads account and agent usage from the same records, with missing counts marked partial", async () => {
    const { calls } = await fixture();
    const id = await calls.create(context, { gateway: "litellm", model: "model-a" }, null);
    await calls.observe(id, { inputTokens: 10, outputTokens: 2, complete: true });
    await calls.finishUnbilled(id);
    await calls.create({ ...context, agentId: randomUUID() }, { gateway: "litellm", model: "model-a" }, null);
    const usage = new CloudUsageService(calls.db);
    expect(await usage.read(context.accountId, 7)).toMatchObject({ requests: 2, measuredRequests: 1, tokens: 12 });
    expect(await usage.readDetail(context.accountId, 7, context.agentId)).toMatchObject({
      requests: 1,
      measuredRequests: 1,
    });
    expect(await usage.read(randomUUID(), 7)).toMatchObject({ requests: 0, tokens: 0 });
  });
});
