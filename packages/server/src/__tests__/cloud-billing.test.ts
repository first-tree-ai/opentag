import {
  CLOUD_BILLING_CHECKOUT_PATH,
  CLOUD_BILLING_PATH,
  CLOUD_MODEL_CHAT_COMPLETIONS_PATH,
  CLOUD_USAGE_PATH,
} from "@opentag/shared";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerCloudModelProxyRoutes } from "../api/cloud-model-proxy.js";
import { createApp } from "../app.js";
import { BootstrapReadiness } from "../bootstrap-readiness.js";
import type { CloudBilling } from "../cloud-billing.js";
import { resolveCloudBillingConfig } from "../cloud-billing-config.js";
import type { UserAuthService } from "../services/auth/index.js";
import { loadCloudBilling } from "../services/cloud-billing-module.js";
import { CloudCallStore } from "../services/cloud-call-store.js";
import { CloudModelService } from "../services/cloud-model-service.js";
import { createStaticCloudModelCatalog } from "../services/sandboxes/cloud-model-catalog.js";
import { CloudModelGrantService } from "../services/sandboxes/cloud-model-grants.js";

const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const SESSION = "22222222-2222-4222-8222-222222222222";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
function moduleFixture() {
  return {
    readiness: vi.fn<CloudBilling["readiness"]>().mockResolvedValue({ status: "ready", revision: "a".repeat(40) }),
    summary: vi.fn<CloudBilling["summary"]>().mockResolvedValue({
      enabled: true,
      currency: "USD",
      availableMicros: 1000000,
      blocked: false,
      minimumTopUpCents: 1000,
      maximumTopUpCents: 100000,
    }),
    checkout: vi.fn<CloudBilling["checkout"]>().mockResolvedValue({ url: "https://checkout.stripe.com/c/pay/test" }),
    pricedModels: vi.fn<CloudBilling["pricedModels"]>().mockReturnValue(["model-a"]),
    beginCall: vi.fn<CloudBilling["beginCall"]>().mockResolvedValue("call"),
    finishCall: vi.fn<CloudBilling["finishCall"]>().mockResolvedValue(),
    writeOffCall: vi.fn<CloudBilling["writeOffCall"]>().mockResolvedValue(),
    webhook: vi.fn<CloudBilling["webhook"]>().mockResolvedValue(),
    stop: vi.fn(),
    close: vi.fn<CloudBilling["close"]>().mockResolvedValue(),
  };
}
function accountApp(billing?: CloudBilling) {
  const readiness = new BootstrapReadiness();
  for (const stage of ["configuration", "migration", "application", "listen"] as const) readiness.complete(stage);
  const auth = {
    getAuthenticatedUser: vi.fn().mockResolvedValue({ me: { user: { id: ACCOUNT } } }),
  } as unknown as UserAuthService;
  const app = createApp({ readiness, authService: auth, ...(billing ? { cloudBilling: billing } : {}) });
  cleanups.push(() => app.close());
  return app;
}
const headers = { authorization: "Bearer access" };
describe("in-process cloud billing", () => {
  it("does not load the private package in public builds, and refuses missing or invalid enabled modules", async () => {
    expect(resolveCloudBillingConfig({})).toEqual({ enabled: false });
    const options = {
      databaseUrl: "postgres://fixture",
      publicUrl: "https://app.example",
      environment: { OPENTAG_CLOUD_MODEL_ENABLED: "true" },
    };
    const load = vi.fn().mockRejectedValue(new Error("private credentials"));
    expect(await loadCloudBilling(false, options, load)).toBeUndefined();
    expect(load).not.toHaveBeenCalled();
    await expect(loadCloudBilling(true, options, load)).rejects.toThrow("Cloud billing initialization failed");
    load.mockResolvedValue({ createCloudBilling: vi.fn().mockResolvedValue(undefined) });
    await expect(loadCloudBilling(true, options, load)).rejects.toThrow("Cloud billing initialization failed");
    const billing = moduleFixture();
    load.mockResolvedValue({ createCloudBilling: vi.fn().mockResolvedValue(billing) });
    expect(await loadCloudBilling(true, options, load)).toBe(billing);
    expect(load).toHaveBeenLastCalledWith("@opentag/cloud-billing");
    expect(resolveCloudBillingConfig({ OPENTAG_CLOUD_BILLING_ENABLED: "true" })).toEqual({ enabled: true });
    await expect(loadCloudBilling(true, { ...options, environment: {} }, load)).rejects.toThrow(
      "Cloud billing requires cloud models",
    );
  });
  it("checks module readiness while ordinary application readiness stays independent", async () => {
    const billing = moduleFixture();
    const app = accountApp(billing);
    expect((await app.inject({ url: "/cloud-readyz" })).json()).toEqual({
      status: "ready",
      billing: { status: "ready", revision: "a".repeat(40) },
    });
    billing.readiness.mockRejectedValue(new Error("database unavailable"));
    expect((await app.inject({ url: "/cloud-readyz" })).statusCode).toBe(503);
    expect((await app.inject({ url: "/readyz" })).statusCode).toBe(200);
    expect((await accountApp().inject({ url: "/cloud-readyz" })).statusCode).toBe(503);
  });
  it("authenticates reads even when billing is disabled", async () => {
    const app = accountApp();
    expect((await app.inject({ url: CLOUD_BILLING_PATH })).statusCode).toBe(401);
    expect((await app.inject({ url: CLOUD_BILLING_PATH, headers })).json()).toEqual({ enabled: false });
  });
  it("derives Account ownership from authentication for balance, usage and checkout", async () => {
    const billing = moduleFixture();
    const app = accountApp(billing);
    expect((await app.inject({ url: CLOUD_BILLING_PATH, headers })).statusCode).toBe(200);
    expect(billing.summary).toHaveBeenCalledWith(ACCOUNT);
    expect((await app.inject({ url: `${CLOUD_USAGE_PATH}?windowDays=7`, headers })).statusCode).toBe(200);
    expect(billing.beginCall).not.toHaveBeenCalled();
    const input = { amountCents: 1234, idempotencyKey: SESSION };
    expect(
      (
        await app.inject({
          method: "POST",
          url: CLOUD_BILLING_CHECKOUT_PATH,
          headers,
          payload: { ...input, accountId: SESSION },
        })
      ).statusCode,
    ).toBe(400);
    expect(billing.checkout).not.toHaveBeenCalled();
    const result = await app.inject({ method: "POST", url: CLOUD_BILLING_CHECKOUT_PATH, headers, payload: input });
    expect(result.statusCode).toBe(200);
    expect(billing.checkout).toHaveBeenCalledWith(ACCOUNT, input);
    expect(result.headers["cache-control"]).toBe("no-store");
    expect((await app.inject({ url: `${CLOUD_USAGE_PATH}?accountId=${SESSION}`, headers })).statusCode).toBe(400);
  });
  it("sanitizes private provider failures and preserves payment review refusal", async () => {
    const billing = moduleFixture();
    const app = accountApp(billing);
    billing.summary.mockRejectedValue(new Error("fixture-secret"));
    const unavailable = await app.inject({ url: CLOUD_BILLING_PATH, headers });
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.body).not.toContain("fixture-secret");
    billing.checkout.mockRejectedValue(Object.assign(new Error("fixture-secret"), { statusCode: 403 }));
    const blocked = await app.inject({
      method: "POST",
      url: CLOUD_BILLING_CHECKOUT_PATH,
      headers,
      payload: { amountCents: 1234, idempotencyKey: SESSION },
    });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.body).not.toContain("fixture-secret");
  });
  it.each([999, 100001, 1234.5])("rejects invalid top-up %s before invoking billing", async (amountCents) => {
    const billing = moduleFixture();
    const app = accountApp(billing);
    expect(
      (
        await app.inject({
          method: "POST",
          url: CLOUD_BILLING_CHECKOUT_PATH,
          headers,
          payload: { amountCents, idempotencyKey: SESSION },
        })
      ).statusCode,
    ).toBe(400);
    expect(billing.checkout).not.toHaveBeenCalled();
  });
  it("preserves exact signed webhook bytes and keeps ordinary JSON routes working", async () => {
    const billing = moduleFixture();
    const app = accountApp(billing);
    const payload = '{ "id": "evt_fixture", "nested": { "b": 2, "a": 1 } }';
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/stripe/webhook",
          headers: { "content-type": "application/json", "stripe-signature": "signed" },
          payload,
        })
      ).statusCode,
    ).toBe(200);
    expect(billing.webhook).toHaveBeenCalledWith(Buffer.from(payload), "signed");
    billing.webhook.mockRejectedValue(Object.assign(new Error("signature secret"), { statusCode: 400 }));
    const invalid = await app.inject({
      method: "POST",
      url: "/stripe/webhook",
      headers: { "content-type": "application/json" },
      payload,
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.body).not.toContain("signature secret");
    expect(
      (
        await app.inject({
          method: "POST",
          url: CLOUD_BILLING_CHECKOUT_PATH,
          headers,
          payload: { amountCents: 1000, idempotencyKey: SESSION },
        })
      ).statusCode,
    ).toBe(200);
    await app.close();
    expect(billing.stop).toHaveBeenCalled();
    expect(billing.close).toHaveBeenCalledTimes(1);
  });
  it("invokes billing only after verifying a cloud execution grant, with no master-key fallback", async () => {
    const billing = moduleFixture();
    const app = Fastify();
    const grants = new CloudModelGrantService("test-jwt-secret-at-least-32-characters", {
      catalog: createStaticCloudModelCatalog(["model-a"]),
      maxStreamsPerToken: 1,
      sweepIntervalMs: 0,
      ttlSeconds: 60,
    });
    const fallback = vi.fn<typeof fetch>();
    registerCloudModelProxyRoutes(app, {
      config: {
        enabled: true,
        upstreamBaseUrl: "https://unused.example",
        masterKey: "unused",
        tokenTtlSeconds: 60,
        maxStreamsPerToken: 1,
        requestTimeoutMs: 1000,
        maxRequestBytes: 65536,
        maxResponseBytes: 1048576,
      },
      grants,
      modelService: new CloudModelService(
        {
          enabled: true,
          upstreamBaseUrl: "https://gateway.example/v1",
          masterKey: "key",
          tokenTtlSeconds: 60,
          maxStreamsPerToken: 1,
          requestTimeoutMs: 1000,
          maxRequestBytes: 65536,
          maxResponseBytes: 1048576,
        },
        { billing, fetchImpl: fallback, calls: new CloudCallStore({ query: vi.fn(async () => ({ rows: [] })) }) },
      ),
      contextForExecution: async () => ({
        accountId: ACCOUNT,
        agentId: ACCOUNT,
        sessionId: SESSION,
        source: "execution",
      }),
    });
    cleanups.push(async () => {
      await app.close();
      grants.close();
    });
    const issued = await grants.issue({
      sandboxId: ACCOUNT,
      sessionId: SESSION,
      executionId: "turn",
      model: "model-a",
    });
    if (!issued) throw new Error("Missing grant");
    const payload = { model: "model-a", messages: [{ role: "user", content: "hello" }] };
    expect((await app.inject({ method: "POST", url: CLOUD_MODEL_CHAT_COMPLETIONS_PATH, payload })).statusCode).toBe(
      401,
    );
    expect(billing.beginCall).not.toHaveBeenCalled();
    billing.beginCall.mockRejectedValue(Object.assign(new Error("No credit"), { statusCode: 402 }));
    expect(
      (
        await app.inject({
          method: "POST",
          url: CLOUD_MODEL_CHAT_COMPLETIONS_PATH,
          headers: { authorization: `Bearer ${issued.token}` },
          payload,
        })
      ).statusCode,
    ).toBe(402);
    expect(billing.beginCall).toHaveBeenCalledWith(
      { accountId: ACCOUNT, agentId: ACCOUNT, sessionId: SESSION, source: "execution" },
      { gateway: "llm-router", model: "model-a" },
    );
    expect(fallback).not.toHaveBeenCalled();
  });
});
