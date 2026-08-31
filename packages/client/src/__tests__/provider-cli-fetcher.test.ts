import { describe, expect, it } from "vitest";
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

function fakeTransport(script: (url: string) => Response): { fetchImpl: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, redirect: init?.redirect ?? "" });
    return script(url);
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
    const { fetchImpl } = fakeTransport(() => new Response(null, { status: 500 }));
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
