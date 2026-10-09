import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ExternalCallPolicyError } from "../services/im/external-call-policy.js";
import type { WorkingTarget } from "../services/im/slack-working-store.js";
import { SlackThreadStatusError, SlackWorkingWorker } from "../services/im/slack-working-worker.js";
import { DefaultSlackApiClient } from "../services/im-bindings/slack/default-api-client.js";

function target(): WorkingTarget {
  return {
    id: "target",
    bindingId: randomUUID(),
    installationId: randomUUID(),
    credentialGeneration: 1,
    channelId: "C1",
    threadTs: "1.1",
    revision: 1,
    working: false,
    disabled: false,
    failures: 0,
    nextAttemptAt: new Date(),
    notBeforeAt: new Date(),
    claimId: randomUUID(),
    claimExpiresAt: new Date(Date.now() + 30_000),
  };
}
function fixture(desired = true) {
  const row = target();
  const store = {
    claim: vi.fn<() => Promise<WorkingTarget | undefined>>().mockResolvedValueOnce(row),
    ownsClaim: vi.fn(async () => true),
    desired: vi.fn(async () => desired),
    settle: vi.fn(async () => undefined),
  };
  const api = { setThreadStatus: vi.fn(async () => undefined) };
  const token = vi.fn(async (): Promise<string | undefined> => "unit-secret");
  const warn = vi.fn();
  const worker = new SlackWorkingWorker({ store, api, token, logger: { warn } });
  return { row, store, api, token, warn, worker };
}

describe("Slack working outbox", () => {
  it.each([true, false])("applies the current aggregate state (%s) and records it", async (desired) => {
    const h = fixture(desired);
    await h.worker.runOnce();
    expect(h.api.setThreadStatus).toHaveBeenCalledWith({
      token: "unit-secret",
      channelId: "C1",
      threadTs: "1.1",
      status: desired ? "is working" : "",
    });
    expect(h.store.settle).toHaveBeenCalledWith(h.row, expect.objectContaining({ working: desired }));
  });
  it("disables stale credentials without a provider call", async () => {
    const h = fixture();
    h.token.mockResolvedValue(undefined);
    await h.worker.runOnce();
    expect(h.api.setThreadStatus).not.toHaveBeenCalled();
    expect(h.store.settle).toHaveBeenCalledWith(h.row, expect.objectContaining({ disabled: true }));
  });
  it("honors Retry-After and sanitizes diagnostics", async () => {
    const h = fixture();
    h.api.setThreadStatus.mockRejectedValue(new SlackThreadStatusError("ratelimited", 90_000));
    await h.worker.runOnce();
    expect(h.store.settle).toHaveBeenCalledWith(
      h.row,
      expect.objectContaining({ delayMs: 90_000, failed: true, disabled: false }),
    );
    expect(JSON.stringify(h.warn.mock.calls)).not.toContain("unit-secret");
  });
  it.each(["missing_scope", "invalid_auth", "token_revoked", "not_in_channel"])(
    "does not retry permanent %s errors",
    async (code) => {
      const h = fixture();
      h.api.setThreadStatus.mockRejectedValue(new SlackThreadStatusError(code));
      await h.worker.runOnce();
      expect(h.store.settle).toHaveBeenCalledWith(h.row, expect.objectContaining({ disabled: true }));
    },
  );
  it("bounds transient retries and never logs upstream errors", async () => {
    const h = fixture();
    h.row.failures = 3;
    h.api.setThreadStatus.mockRejectedValue(new Error("unit-secret body"));
    await h.worker.runOnce();
    expect(h.store.settle).toHaveBeenCalledWith(h.row, expect.objectContaining({ disabled: true }));
    expect(JSON.stringify(h.warn.mock.calls)).not.toContain("unit-secret");
  });
  it.each([
    new SlackThreadStatusError("ratelimited", 60_000),
    new ExternalCallPolicyError("IM_PROVIDER_CIRCUIT_OPEN", "circuit open"),
  ])("defers cooldowns without exhausting a healthy target's retry budget (%s)", async (error) => {
    const h = fixture();
    h.row.failures = 3;
    h.api.setThreadStatus.mockRejectedValue(error);
    await h.worker.runOnce();
    expect(h.store.settle).toHaveBeenCalledWith(
      h.row,
      expect.objectContaining({ disabled: false, deferred: true, delayMs: expect.any(Number) }),
    );
  });
  it("coalesces overlapping pumps", async () => {
    const h = fixture();
    await Promise.all([h.worker.runOnce(), h.worker.runOnce()]);
    expect(h.api.setThreadStatus).toHaveBeenCalledOnce();
  });
  it("does not write after its worker claim expires", async () => {
    const h = fixture();
    h.store.ownsClaim.mockResolvedValue(false);
    await h.worker.runOnce();
    expect(h.api.setThreadStatus).not.toHaveBeenCalled();
  });
});

describe("Slack native status API", () => {
  it("does not let installation authorization failures trip the shared transport circuit", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(
        async (_url, init) =>
          new Response(
            JSON.stringify(
              new Headers(init?.headers).get("authorization") === "Bearer revoked"
                ? { ok: false, error: "missing_scope" }
                : { ok: true },
            ),
          ),
      );
    const api = new DefaultSlackApiClient(undefined, fetchImpl);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(
        api.setThreadStatus({ token: "revoked", channelId: "C1", threadTs: "1.1", status: "" }),
      ).rejects.toMatchObject({ code: "missing_scope" });
    }
    await api.setThreadStatus({ token: "healthy", channelId: "C2", threadTs: "2.2", status: "is working" });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });
  it("bounds a stalled response body and aborts its transport after headers arrive", async () => {
    vi.useFakeTimers();
    let body: ReadableStreamDefaultController<Uint8Array> | undefined;
    let signal: AbortSignal | null | undefined;
    let outcome = "pending";
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      signal = init?.signal;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            body = controller;
            signal?.addEventListener("abort", () => controller.error(new Error("cancelled")), { once: true });
          },
        }),
      );
    });
    const request = new DefaultSlackApiClient(undefined, fetchImpl)
      .setThreadStatus({ token: "unit-secret", channelId: "C1", threadTs: "1.1", status: "is working" })
      .then(
        () => {
          outcome = "resolved";
        },
        () => {
          outcome = "rejected";
        },
      );
    try {
      await vi.advanceTimersByTimeAsync(3_001);
      expect(outcome).toBe("rejected");
      expect(signal?.aborted).toBe(true);
      expect(fetchImpl).toHaveBeenCalledOnce();
    } finally {
      body?.error(new Error("test cleanup"));
      await request;
      vi.useRealTimers();
    }
  });
  it("bounds an unresponsive request at three seconds", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn<typeof fetch>().mockImplementation(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
          }),
      );
      const api = new DefaultSlackApiClient(undefined, fetchImpl);
      const failed = expect(
        api.setThreadStatus({ token: "unit-secret", channelId: "C1", threadTs: "1.1", status: "" }),
      ).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(3_001);
      await failed;
      expect(fetchImpl).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
  it.each(["is working", ""] as const)("sends a native status (%s) using bot authorization", async (status) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ ok: true })));
    const api = new DefaultSlackApiClient(undefined, fetchImpl);
    await api.setThreadStatus({ token: "unit-secret", channelId: "C1", threadTs: "1.1", status });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe("https://slack.com/api/assistant.threads.setStatus");
    expect(init?.headers).toMatchObject({ authorization: "Bearer unit-secret" });
    expect(JSON.parse(String(init?.body))).toEqual({ channel_id: "C1", thread_ts: "1.1", status });
  });
  it("rejects ok:false even with HTTP 200", async () => {
    const api = new DefaultSlackApiClient(
      undefined,
      vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ ok: false, error: "missing_scope" }))),
    );
    await expect(
      api.setThreadStatus({ token: "unit-secret", channelId: "C1", threadTs: "1.1", status: "" }),
    ).rejects.toMatchObject({ code: "missing_scope" });
  });
  it("preserves a 429 delay without hidden transport retries", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("", { status: 429, headers: { "retry-after": "17" } }));
    const api = new DefaultSlackApiClient(undefined, fetchImpl);
    await expect(
      api.setThreadStatus({ token: "unit-secret", channelId: "C1", threadTs: "1.1", status: "" }),
    ).rejects.toMatchObject({ code: "ratelimited", retryAfterMs: 17_000 });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
