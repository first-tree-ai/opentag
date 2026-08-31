import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  ExternalCallPolicy,
  ExternalCallPolicyError,
  limitReadableStream,
} from "../services/im/external-call-policy.js";

describe("ExternalCallPolicy", () => {
  it("aborts a call at the injected deadline", async () => {
    const controller = new AbortController();
    const policy = new ExternalCallPolicy({ defaultTimeoutMs: 10, maxAttempts: 1 });
    const pending = policy.run("deadline", async (signal) => {
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });
    await expect(pending).rejects.toMatchObject({ code: "IM_PROVIDER_CALL_DEADLINE_EXCEEDED" });
    controller.abort();
  });

  it("cuts a stream before forwarding bytes beyond the limit", async () => {
    const source = Readable.from([Buffer.from("1234"), Buffer.from("5678")]);
    const limited = limitReadableStream(source, 5);
    const chunks: Buffer[] = [];
    await expect(
      new Promise<void>((resolve, reject) => {
        limited.on("data", (chunk: Buffer) => chunks.push(chunk));
        limited.once("end", resolve);
        limited.once("error", reject);
      }),
    ).rejects.toMatchObject({ code: "IM_PROVIDER_RESPONSE_TOO_LARGE" });
    expect(Buffer.concat(chunks).toString()).toBe("1234");
  });

  it("rejects disallowed hosts and redirects before transport", async () => {
    const transport = vi.fn();
    const policy = new ExternalCallPolicy({ allowedHosts: ["api.example.test"], transport });
    await expect(policy.fetch("https://evil.example.test/file")).rejects.toMatchObject({
      code: "IM_PROVIDER_HOST_NOT_ALLOWED",
    });
    expect(transport).not.toHaveBeenCalled();

    transport.mockResolvedValue(
      new Response("ok", { status: 302, headers: { location: "https://evil.example.test" } }),
    );
    await expect(policy.fetch("https://api.example.test/file")).rejects.toMatchObject({
      code: "IM_PROVIDER_REDIRECT_REJECTED",
    });

    transport.mockResolvedValue({
      redirected: false,
      status: 200,
      url: "https://evil.example.test/file",
    });
    await expect(policy.fetch("https://api.example.test/file")).rejects.toMatchObject({
      code: "IM_PROVIDER_REDIRECT_REJECTED",
    });

    transport.mockResolvedValue({
      redirected: false,
      status: 200,
      url: "https://API.EXAMPLE.TEST/file",
    });
    await expect(policy.fetch("https://api.example.test/file")).resolves.toMatchObject({ status: 200 });
  });

  it("combines request cancellation with the policy signal", async () => {
    const controller = new AbortController();
    const policy = new ExternalCallPolicy({ maxAttempts: 1 });
    const pending = policy.run(
      "cancelled",
      (signal) =>
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
      { signal: controller.signal },
    );
    controller.abort("test cancellation");
    await expect(pending).rejects.toMatchObject({ code: "IM_PROVIDER_CALL_ABORTED" });
  });

  it("wraps a raw action failure observed after the policy signal aborts", async () => {
    let firstListener = true;
    const signal = {
      aborted: false,
      reason: undefined,
      addEventListener: vi.fn((_: string, listener: (event: unknown) => void) => {
        if (firstListener) {
          firstListener = false;
          listener(new Event("abort"));
        }
      }),
      removeEventListener: vi.fn(),
    } as unknown as AbortSignal;
    const policy = new ExternalCallPolicy({ maxAttempts: 1 });
    await expect(
      policy.run(
        "raw-after-abort",
        async () => {
          throw new Error("raw failure");
        },
        { signal },
      ),
    ).rejects.toMatchObject({
      code: "IM_PROVIDER_CALL_ABORTED",
    });
  });

  it("bounds concurrent calls", async () => {
    let active = 0;
    let peak = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const policy = new ExternalCallPolicy({ maxConcurrency: 2, maxAttempts: 1 });
    const call = () =>
      policy.run("concurrency", async () => {
        active += 1;
        peak = Math.max(peak, active);
        await gate;
        active -= 1;
      });
    const all = Promise.all([call(), call(), call(), call()]);
    await vi.waitFor(() => expect(active).toBe(2));
    expect(peak).toBe(2);
    release();
    await all;
  });

  it("cancels a call queued behind the concurrency limit", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const policy = new ExternalCallPolicy({ maxConcurrency: 1, maxAttempts: 1 });
    const first = policy.run("queued-cancel", async () => gate);
    await vi.waitFor(() => expect(policy.circuitState("queued-cancel")).toBe("closed"));
    const controller = new AbortController();
    const queued = policy.run("queued-cancel", async () => "unexpected", { signal: controller.signal });
    controller.abort("queued cancellation");
    await expect(queued).rejects.toMatchObject({ code: "IM_PROVIDER_CALL_ABORTED" });
    release();
    await first;
  });

  it("rejects an already-cancelled call before queueing it", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const policy = new ExternalCallPolicy({ maxConcurrency: 1, maxAttempts: 1 });
    const first = policy.run("queued-already-cancelled", async () => gate);
    const controller = new AbortController();
    controller.abort("already cancelled");
    await expect(
      policy.run("queued-already-cancelled", async () => "unexpected", { signal: controller.signal }),
    ).rejects.toMatchObject({ code: "IM_PROVIDER_CALL_ABORTED" });
    release();
    await first;
  });

  it("exposes the stream limiter through the policy instance", async () => {
    const policy = new ExternalCallPolicy();
    const limited = policy.stream(Readable.from([Buffer.from("ok")]), 2);
    await expect(
      new Promise<string>((resolve, reject) => {
        let value = "";
        limited.on("data", (chunk: Buffer) => {
          value += chunk.toString();
        });
        limited.once("end", () => resolve(value));
        limited.once("error", reject);
      }),
    ).resolves.toBe("ok");
  });

  it("applies deadlines while a call waits for concurrency capacity", async () => {
    let release!: () => void;
    let entered = false;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const policy = new ExternalCallPolicy({ maxConcurrency: 1, defaultTimeoutMs: 10, maxAttempts: 1 });
    const first = policy.run(
      "busy",
      async () => {
        entered = true;
        return gate;
      },
      { timeoutMs: 1_000 },
    );
    await vi.waitFor(() => expect(entered).toBe(true));
    const queued = policy.run("queued", async () => "unexpected");
    await expect(queued).rejects.toMatchObject({ code: "IM_PROVIDER_CALL_DEADLINE_EXCEEDED" });
    release();
    await first;
  });

  it("backs off and transitions the circuit", async () => {
    let now = 0;
    const sleeps: number[] = [];
    const policy = new ExternalCallPolicy({
      clock: () => new Date(now),
      sleep: async (delay) => {
        sleeps.push(delay);
        now += delay;
      },
      maxAttempts: 2,
      backoffBaseMs: 5,
      circuitFailureThreshold: 2,
      circuitResetMs: 20,
    });
    const failure = () =>
      policy.run("circuit", async () => {
        throw new Error("upstream");
      });
    await expect(failure()).rejects.toThrow("upstream");
    await expect(failure()).rejects.toThrow("upstream");
    await expect(failure()).rejects.toMatchObject({ code: "IM_PROVIDER_CIRCUIT_OPEN" });
    expect(sleeps).toContain(5);
    now += 20;
    await expect(policy.run("circuit", async () => "ok")).resolves.toBe("ok");
    expect(policy.circuitState("circuit")).toBe("closed");
  });

  it("uses the standard local structured error shape", () => {
    const error = new ExternalCallPolicyError("IM_PROVIDER_HOST_NOT_ALLOWED", "host", {
      category: "security",
      retryability: "not_retryable",
      phase: "request",
      requestId: "req-1",
    });
    expect(error).toMatchObject({
      code: "IM_PROVIDER_HOST_NOT_ALLOWED",
      category: "security",
      retryability: "not_retryable",
      phase: "request",
      requestId: "req-1",
    });
  });

  it("exposes provider duration, failure, and circuit metrics without call payloads", async () => {
    const metrics: Array<{ type: string; operation: string; success?: boolean; state?: string }> = [];
    const policy = new ExternalCallPolicy({
      maxAttempts: 1,
      circuitFailureThreshold: 1,
      onMetric: (metric) => metrics.push(metric),
    });
    await expect(policy.run("metrics.operation", async () => "ok")).resolves.toBe("ok");
    await expect(
      policy.run("metrics.operation", async () => {
        throw new Error("no-details");
      }),
    ).rejects.toThrow();
    expect(metrics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "call", operation: "metrics.operation", success: true }),
        expect.objectContaining({ type: "call", operation: "metrics.operation", success: false }),
        expect.objectContaining({ type: "circuit", operation: "metrics.operation", state: "open" }),
      ]),
    );
  });
});
