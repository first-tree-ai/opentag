import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createProviderCliFetcher,
  defaultProviderCliFetcher,
  ProviderCliInstallError,
  resolveProviderCliArtifactUrl,
} from "../index.js";
import { startFixtureHttpServer } from "./fixtures/provider-cli.js";

/**
 * Focused coverage for the artifact-fetcher channel policy: the reviewed catalog URL
 * and every redirect hop must be HTTPS, with deterministic size and redirect bounds.
 */

interface RecordedCall {
  readonly url: string;
  readonly redirect: string;
}

function fakeTransport(script: (url: string, signal?: AbortSignal | null) => Response | Promise<Response>): {
  fetchImpl: typeof fetch;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, redirect: init?.redirect ?? "" });
    return script(url, init?.signal);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const OPTIONS = { url: "https://releases.example.test/artifact.tar.gz", maxBytes: 1024, timeoutMs: 5_000 };

describe("resolveProviderCliArtifactUrl", () => {
  it("accepts HTTPS URLs and resolves relative redirect targets against them", () => {
    expect(resolveProviderCliArtifactUrl("https://example.test/a.tar.gz")).toBe("https://example.test/a.tar.gz");
    expect(resolveProviderCliArtifactUrl("https://example.test/a.tar.gz", "/cdn/b.tar.gz")).toBe(
      "https://example.test/cdn/b.tar.gz",
    );
    expect(resolveProviderCliArtifactUrl("https://example.test/a.tar.gz", "https://cdn.example.test/b.tar.gz")).toBe(
      "https://cdn.example.test/b.tar.gz",
    );
  });

  it("rejects plaintext and non-HTTP schemes on the request itself", () => {
    for (const url of [
      "http://example.test/a.tar.gz",
      "ftp://example.test/a.tar.gz",
      "file:///tmp/a.tar.gz",
      "not-a-url",
    ]) {
      expect(() => resolveProviderCliArtifactUrl(url)).toThrowError(
        expect.objectContaining({ name: "ProviderCliInstallError", code: "integrity_failed" }) as Error,
      );
    }
  });

  it("rejects every non-HTTPS redirect hop, including downgrades and malformed targets", () => {
    for (const location of ["http://example.test/a.tar.gz", "ftp://example.test/a.tar.gz"]) {
      expect(() => resolveProviderCliArtifactUrl("https://example.test/a.tar.gz", location)).toThrowError(
        expect.objectContaining({ code: "integrity_failed" }) as Error,
      );
    }
  });

  it("lets protocol-relative redirect targets inherit HTTPS", () => {
    expect(resolveProviderCliArtifactUrl("https://example.test/a.tar.gz", "//cdn.example.test/a.tar.gz")).toBe(
      "https://cdn.example.test/a.tar.gz",
    );
  });
});

describe("createProviderCliFetcher", () => {
  it("rejects a plaintext catalog URL without issuing any request", async () => {
    const { fetchImpl, calls } = fakeTransport(() => new Response("never"));
    const fetcher = createProviderCliFetcher(fetchImpl);
    await expect(fetcher({ ...OPTIONS, url: "http://releases.example.test/a.tar.gz" })).rejects.toMatchObject({
      name: "ProviderCliInstallError",
      code: "integrity_failed",
    });
    expect(calls).toEqual([]);
  });

  it("rejects an HTTPS-to-plaintext redirect hop after the first request", async () => {
    const { fetchImpl, calls } = fakeTransport(
      () => new Response(null, { status: 302, headers: { location: "http://releases.example.test/a.tar.gz" } }),
    );
    const fetcher = createProviderCliFetcher(fetchImpl);
    await expect(fetcher(OPTIONS)).rejects.toMatchObject({ code: "integrity_failed" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.redirect).toBe("manual");
  });

  it("follows HTTPS redirect hops and returns the final body", async () => {
    const payload = new TextEncoder().encode("artifact-bytes");
    const { fetchImpl, calls } = fakeTransport((url) => {
      if (url === "https://releases.example.test/artifact.tar.gz") {
        return new Response(null, { status: 302, headers: { location: "/cdn/artifact.tar.gz" } });
      }
      return new Response(payload, { status: 200 });
    });
    const fetcher = createProviderCliFetcher(fetchImpl);
    const body = await fetcher(OPTIONS);
    expect(new TextDecoder().decode(body)).toBe("artifact-bytes");
    expect(calls.map((call) => call.url)).toEqual([
      "https://releases.example.test/artifact.tar.gz",
      "https://releases.example.test/cdn/artifact.tar.gz",
    ]);
  });

  it("fails closed on a redirect without a Location header", async () => {
    const { fetchImpl } = fakeTransport(() => new Response(null, { status: 302 }));
    await expect(createProviderCliFetcher(fetchImpl)(OPTIONS)).rejects.toMatchObject({ code: "integrity_failed" });
  });

  it("reports a redirect body cleanup failure instead of hiding it", async () => {
    const body = new ReadableStream({
      cancel() {
        throw new Error("cancel failed");
      },
    });
    const { fetchImpl } = fakeTransport(
      () => new Response(body, { status: 302, headers: { location: "https://releases.example.test/next" } }),
    );
    await expect(createProviderCliFetcher(fetchImpl)(OPTIONS)).rejects.toMatchObject({
      code: "install_incomplete",
      message: "Artifact redirect cleanup failed: cancel failed",
    });
  });

  it("bounds redirect chains", async () => {
    const { fetchImpl, calls } = fakeTransport(
      () => new Response(null, { status: 302, headers: { location: "https://releases.example.test/next" } }),
    );
    await expect(createProviderCliFetcher(fetchImpl)(OPTIONS)).rejects.toMatchObject({ code: "install_incomplete" });
    expect(calls).toHaveLength(9); // initial request plus the eight allowed redirect hops
  });

  it("maps non-OK responses to install_incomplete", async () => {
    const { fetchImpl } = fakeTransport(() => new Response(null, { status: 404 }));
    await expect(createProviderCliFetcher(fetchImpl)(OPTIONS)).rejects.toMatchObject({ code: "install_incomplete" });
  });

  it("enforces the reviewed size bound via content-length and streamed bytes", async () => {
    const oversized = new TextEncoder().encode("x".repeat(2048));
    const viaHeader = fakeTransport(
      () => new Response(oversized, { status: 200, headers: { "content-length": String(oversized.byteLength) } }),
    );
    await expect(createProviderCliFetcher(viaHeader.fetchImpl)(OPTIONS)).rejects.toMatchObject({
      code: "integrity_failed",
    });
    const viaStream = fakeTransport(() => new Response(oversized, { status: 200 }));
    await expect(createProviderCliFetcher(viaStream.fetchImpl)(OPTIONS)).rejects.toMatchObject({
      code: "integrity_failed",
    });
  });

  it("wraps transport failures as install_incomplete", async () => {
    const { fetchImpl } = fakeTransport(() => {
      throw new Error("socket hangup");
    });
    await expect(createProviderCliFetcher(fetchImpl)(OPTIONS)).rejects.toMatchObject({ code: "install_incomplete" });
  });
});

describe("defaultProviderCliFetcher (real transport)", () => {
  it("rejects a loopback plaintext URL before any network I/O", async () => {
    const routes = new Map<string, Uint8Array>();
    const server = await startFixtureHttpServer(routes);
    try {
      await expect(
        defaultProviderCliFetcher({
          url: `${server.baseUrl}/artifact.tar.gz`,
          maxBytes: 1024,
          timeoutMs: 5_000,
        }),
      ).rejects.toMatchObject({ code: "integrity_failed" });
      expect(server.requests).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it("keeps the ProviderCliInstallError contract", () => {
    expect(new ProviderCliInstallError("integrity_failed", "x").name).toBe("ProviderCliInstallError");
  });
});

describe("ProviderCliFetcher cancellation", () => {
  it("rejects with the caller's reason when a body never finishes, and cancels the stream", async () => {
    let cancelled = false;
    const { fetchImpl } = fakeTransport(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(16));
            },
            cancel() {
              cancelled = true;
            },
          }),
          { status: 200 },
        ),
    );
    const controller = new AbortController();
    const reason = new Error("daemon shutting down");
    const download = createProviderCliFetcher(fetchImpl)({ ...OPTIONS, signal: controller.signal });
    setTimeout(() => controller.abort(reason), 20);
    const startedAt = Date.now();
    await expect(download).rejects.toBe(reason);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(cancelled).toBe(true);
  });

  it("does not report cancellation as an install error when the request itself is aborted", async () => {
    const fetchImpl = ((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
          once: true,
        });
      })) as unknown as typeof fetch;
    const controller = new AbortController();
    const reason = new Error("daemon shutting down");
    const download = createProviderCliFetcher(fetchImpl)({ ...OPTIONS, signal: controller.signal });
    controller.abort(reason);
    const error = await download.catch((caught: unknown) => caught);
    expect(error).toBe(reason);
    expect(error).not.toBeInstanceOf(ProviderCliInstallError);
  });
});

describe("artifact download recovery", () => {
  it("restarts from the reviewed URL instead of reusing a failed redirect target", async () => {
    const { fetchImpl, calls } = fakeTransport((url) => {
      if (url === OPTIONS.url) return new Response(null, { status: 302, headers: { location: "/cdn" } });
      return calls.length === 2 ? new Response(null, { status: 504 }) : new Response("ok");
    });
    const outcome = createProviderCliFetcher(fetchImpl)({ ...OPTIONS, timeoutMs: 120_000 });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(new TextDecoder().decode(await outcome)).toBe("ok");
    expect(calls.map((call) => call.url)).toEqual([
      OPTIONS.url,
      "https://releases.example.test/cdn",
      OPTIONS.url,
      "https://releases.example.test/cdn",
    ]);
  });

  it("aborts a request waiting for headers at the shared deadline", async () => {
    const fetchImpl = vi.fn(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        }),
    ) as typeof fetch;
    const outcome = createProviderCliFetcher(fetchImpl)(OPTIONS).catch((error) => error);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await outcome).toMatchObject({ code: "install_incomplete", message: expect.stringContaining("timed out") });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it.each([408, 429, 500, 502, 503, 504])(
    "recovers HTTP %s after backoff and cancels the failed body",
    async (status) => {
      const cancel = vi.fn();
      const { fetchImpl, calls } = fakeTransport(() =>
        calls.length === 1 ? new Response(new ReadableStream({ cancel }), { status }) : new Response("verified later"),
      );
      const download = createProviderCliFetcher(fetchImpl)({ ...OPTIONS, timeoutMs: 120_000 });
      await vi.advanceTimersByTimeAsync(4_999);
      expect(calls).toHaveLength(1);
      expect(cancel).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      expect(new TextDecoder().decode(await download)).toBe("verified later");
      expect(calls).toHaveLength(2);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("exhausts four attempts at 0, 5, 15 and 35 seconds", async () => {
    const times: number[] = [];
    const { fetchImpl, calls } = fakeTransport(() => {
      times.push(Date.now());
      return new Response(null, { status: 504 });
    });
    const started = Date.now();
    const outcome = createProviderCliFetcher(fetchImpl)({ ...OPTIONS, timeoutMs: 120_000 }).catch((error) => error);
    await vi.advanceTimersByTimeAsync(35_000);
    expect(await outcome).toMatchObject({ code: "install_incomplete", message: expect.stringContaining("HTTP 504") });
    expect(calls).toHaveLength(4);
    expect(times.map((time) => time - started)).toEqual([0, 5_000, 15_000, 35_000]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([400, 401, 403, 404, 501])("does not retry permanent HTTP %s", async (status) => {
    const cancel = vi.fn();
    const { fetchImpl, calls } = fakeTransport(() => new Response(new ReadableStream({ cancel }), { status }));
    await expect(createProviderCliFetcher(fetchImpl)(OPTIONS)).rejects.toMatchObject({ code: "install_incomplete" });
    expect(calls).toHaveLength(1);
    expect(cancel).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "UND_ERR_SOCKET"])(
    "recovers transient transport %s",
    async (code) => {
      const { fetchImpl, calls } = fakeTransport(() => {
        if (calls.length === 1)
          throw new TypeError("fetch failed", { cause: Object.assign(new Error(code), { code }) });
        return new Response("ok");
      });
      const download = createProviderCliFetcher(fetchImpl)({ ...OPTIONS, timeoutMs: 120_000 });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(new TextDecoder().decode(await download)).toBe("ok");
      expect(calls).toHaveLength(2);
    },
  );

  it.each(["CERT_HAS_EXPIRED", "ENOTFOUND", "UNKNOWN"])("does not retry transport %s", async (code) => {
    const { fetchImpl, calls } = fakeTransport(() => {
      throw Object.assign(new Error(code), { code });
    });
    await expect(createProviderCliFetcher(fetchImpl)(OPTIONS)).rejects.toMatchObject({ code: "install_incomplete" });
    expect(calls).toHaveLength(1);
  });

  it("cancels retry waits immediately with the caller's exact reason", async () => {
    const { fetchImpl, calls } = fakeTransport(() => new Response(null, { status: 504 }));
    const controller = new AbortController();
    const reason = new Error("shutdown");
    const outcome = createProviderCliFetcher(fetchImpl)({ ...OPTIONS, signal: controller.signal }).catch(
      (error) => error,
    );
    await vi.advanceTimersByTimeAsync(0);
    controller.abort(reason);
    expect(await outcome).toBe(reason);
    await vi.advanceTimersByTimeAsync(35_000);
    expect(calls).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not start a retry at or after the overall deadline", async () => {
    const { fetchImpl, calls } = fakeTransport(() => new Response(null, { status: 504 }));
    const outcome = createProviderCliFetcher(fetchImpl)(OPTIONS).catch((error) => error);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await outcome).toMatchObject({ code: "install_incomplete", message: expect.stringContaining("timed out") });
    expect(calls).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("shares one deadline across attempts, redirects and a stalled body", async () => {
    const signals: Array<AbortSignal | null | undefined> = [];
    const cancel = vi.fn();
    const { fetchImpl, calls } = fakeTransport(async (_url, signal) => {
      signals.push(signal);
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      if (calls.length === 1) return new Response(null, { status: 504 });
      if (calls.length === 2) return new Response(null, { status: 302, headers: { location: "/cdn" } });
      return new Response(new ReadableStream({ cancel }));
    });
    const outcome = createProviderCliFetcher(fetchImpl)({ ...OPTIONS, timeoutMs: 12_000 }).catch((error) => error);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(await outcome).toMatchObject({ code: "install_incomplete", message: expect.stringContaining("timed out") });
    expect(calls).toHaveLength(3);
    expect(new Set(signals).size).toBe(1);
    expect(cancel).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps size violations terminal and cancels the response", async () => {
    const cancel = vi.fn();
    const { fetchImpl, calls } = fakeTransport(
      () =>
        new Response(new ReadableStream({ cancel }), {
          headers: { "content-length": "2048" },
        }),
    );
    await expect(createProviderCliFetcher(fetchImpl)(OPTIONS)).rejects.toMatchObject({ code: "integrity_failed" });
    expect(calls).toHaveLength(1);
    expect(cancel).toHaveBeenCalledOnce();
  });
});
