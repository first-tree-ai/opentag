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
});
