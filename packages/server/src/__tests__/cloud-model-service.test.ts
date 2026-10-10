import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudBilling } from "../cloud-billing.js";
import { users } from "../db/schema/index.js";
import { CloudAgentRuntimeTester } from "../services/agents/cloud-agent-runtime-tester.js";
import { CloudCallStore } from "../services/cloud-call-store.js";
import { CloudModelService } from "../services/cloud-model-service.js";
import { CloudUsageService } from "../services/cloud-usage.js";
import { createStaticCloudModelCatalog } from "../services/sandboxes/cloud-model-catalog.js";
import { createUnitDatabase, type UnitDatabase } from "./support/unit-database.js";

const config = {
  enabled: true as const,
  gatewayId: "llm-router",
  upstreamBaseUrl: "https://gateway.example/v1",
  masterKey: "tenant-key",
  tokenTtlSeconds: 60,
  maxStreamsPerToken: 2,
  requestTimeoutMs: 1000,
  maxRequestBytes: 65536,
  maxResponseBytes: 65536,
};
const context = { accountId: randomUUID(), agentId: randomUUID(), sessionId: null, source: "execution" as const };
const body = { model: "model-a", messages: [{ role: "user", content: "hello" }] };
const rates = {
  inputMicrosPerMillion: 1,
  cachedInputMicrosPerMillion: 1,
  cacheWriteInputMicrosPerMillion: 1,
  outputMicrosPerMillion: 1,
};
const usage = { inputTokens: 1000, cachedInputTokens: 600, cacheWriteInputTokens: 100, outputTokens: 200 };
let unit: UnitDatabase;
const services: CloudModelService[] = [];
beforeAll(async () => {
  unit = await createUnitDatabase();
});
beforeEach(async () => {
  await unit.reset();
  await unit.database.insert(users).values({ id: context.accountId, email: "cloud@example.com", displayName: "Cloud" });
});
afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
});
afterAll(async () => {
  await unit.close();
});
function fixture(billed = false) {
  const calls = new CloudCallStore({ query: (statement, parameters) => unit.engine.query(statement, parameters) });
  const billing = {
    beginCall: vi.fn<CloudBilling["beginCall"]>((context, model) => calls.create(context, model, rates)),
    finishCall: vi.fn<CloudBilling["finishCall"]>((id, result) =>
      calls.finalize(id, result, {
        resolution: result.status === "complete" ? "charged" : "no_charge",
        pricedMicros: 0,
        debitedMicros: 0,
      }),
    ),
  };
  let key = "";
  const requestId = randomUUID();
  const status = vi.fn((): unknown => ({
    status: "complete",
    requestId,
    idempotencyKey: key,
    model: body.model,
    usage,
  }));
  const completion = vi.fn(() => Response.json({ choices: [], usage: { prompt_tokens: 999999 } }));
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    if (String(input).includes("/requests/usage")) {
      key = new URL(String(input)).searchParams.get("idempotency_key") ?? "";
      const result = status();
      return result instanceof Response ? result : Response.json(result);
    }
    key = new Headers(init?.headers).get("idempotency-key") ?? "";
    return completion();
  });
  const service = new CloudModelService(config, {
    calls,
    fetchImpl,
    onError: vi.fn(),
    ...(billed ? { billing: billing as unknown as CloudBilling } : {}),
  });
  services.push(service);
  const row = async () => {
    const [record] = (await calls.db.query("SELECT id FROM billing.attempts")).rows as Array<{ id: string }>;
    if (!record) throw new Error("Missing cloud record");
    return calls.get(record.id);
  };
  const run = async () => (await service.request(body, new AbortController().signal, config, context)).text();
  const pending = () =>
    status.mockImplementation(() => ({ status: "pending", requestId, idempotencyKey: key, model: body.model }));
  return { calls, billing, fetchImpl, service, status, completion, row, run, pending };
}
describe("router-authoritative cloud usage", () => {
  it.each([false, true])("records final router counts with customer billing enabled=%s", async (billed) => {
    const f = fixture(billed);
    await f.run();
    const call = await f.row();
    expect(call).toMatchObject({
      account: context.accountId,
      agent_id: context.agentId,
      state: "finalized",
      input_tokens: 1000,
      cached_input_tokens: 600,
      cache_write_input_tokens: 100,
      output_tokens: 200,
    });
    expect(f.fetchImpl).toHaveBeenCalledTimes(2);
    expect(f.fetchImpl.mock.calls[0]).toEqual([
      "https://gateway.example/v1/chat/completions",
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: "Bearer tenant-key", "idempotency-key": call.id }),
      }),
    ]);
    expect(f.fetchImpl.mock.calls[1]?.[0]).toBe(`https://gateway.example/v1/requests/usage?idempotency_key=${call.id}`);
    expect(f.billing.finishCall).toHaveBeenCalledTimes(billed ? 1 : 0);
  });
  it("forwards SSE without parsing or rewriting its usage options", async () => {
    const f = fixture();
    const text = 'data: {"choices":[{"delta":{"content":"hello"}}]}\n\ndata: [DONE]\n';
    f.completion.mockImplementation(() => new Response(text, { headers: { "content-type": "text/event-stream" } }));
    const response = await f.service.request(
      { ...body, stream: true, stream_options: { include_usage: false } },
      new AbortController().signal,
      config,
      context,
    );
    expect(await response.text()).toBe(text);
    expect(JSON.parse(String(f.fetchImpl.mock.calls[0]?.[1]?.body))).toMatchObject({
      stream_options: { include_usage: false },
    });
    expect(await f.row()).toMatchObject({ state: "finalized", input_tokens: 1000 });
  });
  it("finishes confirmed pre-dispatch rejections without a usage lookup", async () => {
    const f = fixture(true);
    f.completion.mockImplementation(() =>
      Response.json(
        { error: { code: "insufficient_balance" } },
        { status: 402, headers: { "X-Router-Dispatch": "not_dispatched" } },
      ),
    );
    await f.run();
    expect(f.status).not.toHaveBeenCalled();
    expect(await f.row()).toMatchObject({ state: "finalized", input_tokens: null, priced_micros: 0 });
    expect(f.billing.finishCall).toHaveBeenCalledWith(expect.any(String), { status: "no_charge" });
  });
  it("does not interpret an HTTP error or missing router record as free usage", async () => {
    const f = fixture(true);
    f.completion.mockImplementation(() => Response.json({ error: {} }, { status: 409 }));
    f.status.mockReturnValue(Response.json({ error: { code: "request_not_found" } }, { status: 404 }));
    await f.run();
    expect(await f.row()).toMatchObject({ state: "pending_usage", input_tokens: null });
    expect(f.billing.finishCall).not.toHaveBeenCalled();
  });
  it.each([
    { status: "pending" },
    { status: "complete", usage: { ...usage, cachedInputTokens: 1001 } },
    { status: "complete", usage: { ...usage, cacheWriteInputTokens: -1 } },
    { status: "complete", usage: { ...usage, outputTokens: "200" } },
    { status: "complete", usage },
  ])("keeps incomplete, malformed, or unrelated results pending: %j", async (result) => {
    const f = fixture(true);
    f.status.mockImplementation(() => ({
      requestId: randomUUID(),
      idempotencyKey: new Headers(f.fetchImpl.mock.calls[0]?.[1]?.headers).get("idempotency-key"),
      model: body.model,
      ...result,
      ...(result.status === "complete" && result.usage === usage ? { idempotencyKey: "unrelated" } : {}),
    }));
    await f.run();
    expect((await f.row()).state).toBe("pending_usage");
    expect(f.billing.finishCall).not.toHaveBeenCalled();
  });
  it("checks the model identity even for no-charge results", async () => {
    const f = fixture(true);
    f.status.mockImplementation(() => ({
      status: "no_charge",
      requestId: randomUUID(),
      idempotencyKey: new Headers(f.fetchImpl.mock.calls[0]?.[1]?.headers).get("idempotency-key"),
      model: "different",
    }));
    await f.run();
    expect((await f.row()).state).toBe("pending_usage");
  });
  it("recovers pending usage without redispatching or settling twice", async () => {
    const f = fixture(true);
    const complete = f.status.getMockImplementation();
    if (!complete) throw new Error("Missing router fixture");
    f.status.mockImplementation(() => {
      const { requestId, idempotencyKey, model } = complete() as {
        requestId: string;
        idempotencyKey: string;
        model: string;
      };
      return { requestId, idempotencyKey, model, status: "pending" };
    });
    await f.run();
    expect((await f.row()).state).toBe("pending_usage");
    f.status.mockImplementation(complete);
    await f.service.reconcile();
    await f.service.reconcile();
    expect((await f.row()).state).toBe("finalized");
    expect(f.completion).toHaveBeenCalledTimes(1);
    expect(f.billing.finishCall).toHaveBeenCalledTimes(1);
  });
  it("settles a cancelled stream on the next five-second recovery tick without holding cancellation", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const f = fixture(true);
    try {
      await f.service.initialize();
      await f.service.job;
      const complete = f.status.getMockImplementation();
      f.pending();
      f.completion.mockImplementation(
        () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode("data: hello\n\n"));
              },
            }),
          ),
      );
      const controller = new AbortController();
      const response = await f.service.request({ ...body, stream: true }, controller.signal, config, context);
      const reader = response.body?.getReader();
      await reader?.read();
      const active = [...f.service.active.values()];
      controller.abort();
      await Promise.all(active);
      expect((await f.row()).state).toBe("pending_usage");
      await vi.advanceTimersByTimeAsync(5_000);
      await f.service.job;
      const call = await f.row();
      expect(call.reconcile_failures).toBe(0);
      if (!complete) throw new Error("Missing router fixture");
      f.status.mockImplementation(complete);
      // PostgreSQL uses its own clock; make the persisted retry due for the next simulated tick.
      await f.calls.db.query("UPDATE billing.attempts SET reconcile_after=now() WHERE id=$1", [call.id]);
      await vi.advanceTimersByTimeAsync(5_000);
      await f.service.job;
      expect((await f.row()).state).toBe("finalized");
      await expect(f.service.begin(context, body.model)).resolves.toEqual(expect.any(String));
      expect(f.completion).toHaveBeenCalledTimes(1);
      expect(f.billing.finishCall).toHaveBeenCalledTimes(1);
    } finally {
      await f.service.close();
      vi.useRealTimers();
    }
  });
  it("retries recent pending calls quickly, then resumes exponential backoff", async () => {
    const f = fixture();
    f.pending();
    await f.run();
    const call = await f.row();
    const delay = async () =>
      (
        await f.calls.db.query(
          "SELECT extract(epoch FROM reconcile_after-now())::float AS seconds FROM billing.attempts WHERE id=$1",
          [call.id],
        )
      ).rows[0] as { seconds: number };
    await f.calls.defer(call.id);
    expect((await delay()).seconds).toBeGreaterThan(4);
    expect((await delay()).seconds).toBeLessThanOrEqual(5);
    expect((await f.row()).reconcile_failures).toBe(0);
    await f.calls.db.query("UPDATE billing.attempts SET finished_at=now()-interval '151 seconds' WHERE id=$1", [
      call.id,
    ]);
    await f.calls.defer(call.id);
    expect((await delay()).seconds).toBeGreaterThan(29);
    expect((await f.row()).reconcile_failures).toBe(1);
    await f.calls.defer(call.id);
    expect((await delay()).seconds).toBeGreaterThan(59);
  });
  it("reports a persistently pending router result once with operator lookup identifiers", async () => {
    const f = fixture(true);
    f.pending();
    await f.run();
    const call = await f.row();
    await f.calls.db.query("UPDATE billing.attempts SET finished_at=now()-interval '151 seconds' WHERE id=$1", [
      call.id,
    ]);
    await f.service.reconcile();
    expect(f.service.options.onError).toHaveBeenCalledWith("cloud_usage_unresolved", {
      callId: call.id,
      accountId: context.accountId,
      pendingSeconds: expect.any(Number),
    });
    await f.calls.db.query("UPDATE billing.attempts SET reconcile_after=now() WHERE id=$1", [call.id]);
    await f.service.reconcile();
    expect(f.service.options.onError).toHaveBeenCalledTimes(1);
    expect(f.billing.finishCall).not.toHaveBeenCalled();
  });
  it("retries a failed local settlement using the same complete router result", async () => {
    const f = fixture(true);
    f.billing.finishCall.mockRejectedValueOnce(new Error("database unavailable"));
    await f.run();
    expect((await f.row()).state).toBe("pending_usage");
    await f.service.reconcile();
    expect((await f.row()).state).toBe("finalized");
    expect(f.completion).toHaveBeenCalledTimes(1);
  });
  it("does not dispatch when credit admission fails or attribution is missing", async () => {
    const f = fixture(true);
    f.billing.beginCall.mockRejectedValue(Object.assign(new Error("empty"), { statusCode: 402 }));
    await expect(f.run()).rejects.toMatchObject({ statusCode: 402 });
    // @ts-expect-error An untyped caller must not bypass trusted attribution.
    await expect(f.service.request(body, new AbortController().signal, config)).rejects.toThrow("trusted attribution");
    expect(f.fetchImpl).not.toHaveBeenCalled();
    expect(f.service.active.size).toBe(0);
  });
  it("keeps a network failure pending when status reads also fail", async () => {
    const f = fixture(true);
    f.fetchImpl.mockRejectedValue(new Error("network"));
    await expect(f.run()).rejects.toThrow("network");
    expect((await f.row()).state).toBe("pending_usage");
    expect(f.billing.finishCall).not.toHaveBeenCalled();
  });
  it.each([false, true])("recovers abandoned calls on startup, billing=%s", async (billed) => {
    const f = fixture(billed);
    const id = await f.calls.create(context, { gateway: config.gatewayId, model: body.model }, billed ? rates : null);
    await f.service.initialize();
    await f.service.job;
    expect(await f.calls.get(id)).toMatchObject({ state: "finalized", input_tokens: 1000 });
    expect(f.completion).not.toHaveBeenCalled();
  });
  it("does not wait for gateway recovery before startup readiness", async () => {
    const f = fixture(true);
    const id = await f.calls.create(context, { gateway: config.gatewayId, model: body.model }, rates);
    f.fetchImpl.mockImplementation(
      async (_input, init) =>
        new Promise((_resolve, reject) => {
          if (init?.signal?.aborted) reject(new Error("cancelled"));
          else init?.signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
        }),
    );
    await f.service.initialize();
    expect((await f.calls.get(id)).state).toBe("pending_usage");
    expect(f.service.job).toBeDefined();
    await f.service.close();
  });
  it("attributes cloud probes through the same usage path", async () => {
    const f = fixture();
    f.completion.mockImplementation(() =>
      Response.json({ choices: [{ message: { role: "assistant", content: "ok" } }] }),
    );
    const tester = new CloudAgentRuntimeTester({
      catalog: createStaticCloudModelCatalog(["model-a"]),
      modelService: f.service,
    });
    expect(await tester.test({ ...context, computerId: randomUUID(), model: body.model })).toEqual({
      status: "passed",
    });
    tester.close();
    expect(await f.row()).toMatchObject({ source: "connectivity_probe", input_tokens: 1000 });
  });
  it("reads consistent account and agent totals from final records, including unbilled cloud calls", async () => {
    const f = fixture();
    const now = new Date("2026-10-08T12:00:00Z");
    for (const [createdAt, inputTokens, outputTokens] of [
      ["2026-10-06T23:59:00Z", 10, 2],
      ["2026-10-08T00:01:00Z", 20, 3],
    ] as const) {
      const id = await f.calls.create(context, { gateway: config.gatewayId, model: body.model }, null);
      await f.calls.finalize(
        id,
        { status: "complete", usage: { inputTokens, outputTokens, cachedInputTokens: 1, cacheWriteInputTokens: 0 } },
        { resolution: "unbilled", pricedMicros: 0, debitedMicros: 0 },
      );
      await f.calls.db.query("UPDATE billing.attempts SET created_at=$2 WHERE id=$1", [id, createdAt]);
    }
    const partial = await f.calls.create(
      { ...context, agentId: randomUUID() },
      { gateway: config.gatewayId, model: body.model },
      null,
    );
    await f.calls.markPending(partial);
    await f.calls.db.query("UPDATE billing.attempts SET created_at=$2 WHERE id=$1", [partial, now.toISOString()]);
    const query = vi.spyOn(f.calls.db, "query");
    const usageService = new CloudUsageService(f.calls.db);
    const detail = await usageService.readDetail(context.accountId, 7, undefined, now);
    expect(query).toHaveBeenCalledTimes(1);
    expect(detail).toMatchObject({
      requests: 3,
      measuredRequests: 2,
      inputTokens: 30,
      outputTokens: 5,
      cachedInputTokens: 2,
    });
    expect(detail.points.find(({ date }) => date === "2026-10-07")).toMatchObject({ tokens: 0 });
    expect(detail.points.reduce((total, point) => total + point.tokens, 0)).toBe(
      detail.inputTokens + detail.outputTokens,
    );
    expect(await usageService.readDetail(context.accountId, 7, context.agentId, now)).toMatchObject({
      requests: 2,
      measuredRequests: 2,
    });
    expect(await usageService.read(randomUUID(), 7)).toMatchObject({ requests: 0, tokens: 0 });
  });
});
