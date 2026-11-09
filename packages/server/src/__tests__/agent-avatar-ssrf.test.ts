import { describe, expect, it, vi } from "vitest";
import type { DatabaseClient } from "../db/client.js";
import {
  type ExternalCallOptions,
  ExternalCallPolicy,
  type ExternalCallTransport,
} from "../services/im/external-call-policy.js";
import { ImResourceService } from "../services/im/im-resource-service.js";

function avatarDatabase(providerUrl: string): DatabaseClient {
  const query = {
    from: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue([{ providerUrl }]),
  };
  return { select: vi.fn().mockReturnValue(query) } as unknown as DatabaseClient;
}

describe("Agent avatar SSRF and upstream diagnostics", () => {
  it("passes a connection-filtering transport to avatar policy and wraps sanitized diagnostics in cause", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error("blocked destination"));
    const database = avatarDatabase("https://avatar.example.test/image.png?X-Amz-Signature=secret-token");
    const service = new ImResourceService(database, vi.fn(), { fetch } as unknown as ExternalCallPolicy);

    await expect(service.openAvatar("owner", "agent-1")).rejects.toMatchObject({
      code: "IM_BINDING_TEMPORARILY_UNAVAILABLE",
      statusCode: 503,
    });
    const failure = await service.openAvatar("owner", "agent-1").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    const cause = (failure as Error).cause as Error;
    expect(cause).toBeInstanceOf(Error);
    expect(cause.message).toBe(
      "Avatar upstream (avatar.example.test) request failed for agent agent-1: blocked destination",
    );
    expect(cause.message).not.toContain("secret-token");
    expect(cause.message).not.toContain("/image.png");
    expect(cause.cause).toMatchObject({ message: "blocked destination" });
    expect(fetch).toHaveBeenCalledWith(
      "https://avatar.example.test/image.png?X-Amz-Signature=secret-token",
      { headers: { accept: "image/*" } },
      expect.objectContaining({ allowAnyHttpsHost: true, maxAttempts: 1, transport: expect.any(Function) }),
    );
    const [url, init, options] = fetch.mock.calls[0] as [string, RequestInit, { transport?: unknown }];
    expect(url).toBe("https://avatar.example.test/image.png?X-Amz-Signature=secret-token");
    expect(init.headers).toEqual({ accept: "image/*" });
    expect(init).not.toHaveProperty("credentials");
    expect(init).not.toHaveProperty("authorization");
    expect(options.transport).toEqual(expect.any(Function));
  });

  it("maps upstream 403, 404, and 410 to 404 without tripping the circuit breaker", async () => {
    const basePolicy = new ExternalCallPolicy({ circuitFailureThreshold: 2 });
    const transport = vi.fn<ExternalCallTransport>();
    const policy = {
      fetch: (input: string | URL, init?: RequestInit, options?: ExternalCallOptions) =>
        basePolicy.fetch(input, init, { ...options, transport }),
    } as unknown as ExternalCallPolicy;
    const database = avatarDatabase("https://a.slack-edge.com/avatars/expired.png?sig=secret-query");
    const service = new ImResourceService(database, vi.fn(), policy);

    for (const status of [404, 403, 410]) {
      transport.mockResolvedValueOnce(new Response("not available", { status }));
      const failure = await service.openAvatar("owner", "agent-missing").catch((error: unknown) => error);
      expect(failure).toMatchObject({
        code: "IM_BINDING_NOT_FOUND",
        statusCode: 404,
        category: "deterministic",
      });
      const cause = (failure as Error).cause as Error;
      expect(cause.message).toBe(`Avatar upstream (a.slack-edge.com) answered ${status} for agent agent-missing`);
      expect(cause.message).not.toContain("secret-query");
    }

    expect(basePolicy.circuitState("im-avatar:agent-missing")).toBe("closed");
  });

  it("keeps a rejected upstream 502 status and timeout as the sanitized cause of the 503", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 502 }));
    const database = avatarDatabase("https://avatar.example.test/image.png?X-Amz-Signature=secret-sig");
    const service = new ImResourceService(database, vi.fn(), { fetch } as unknown as ExternalCallPolicy);

    const failure = await service.openAvatar("owner", "agent-502").catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "IM_BINDING_TEMPORARILY_UNAVAILABLE", statusCode: 503 });
    const cause = (failure as Error).cause as Error;
    expect(cause.message).toBe("Avatar upstream (avatar.example.test) answered 502 for agent agent-502");
    expect(cause.message).not.toContain("secret-sig");

    const timeoutPolicy = new ExternalCallPolicy({ defaultTimeoutMs: 10, maxAttempts: 1 });
    const slowTransport: ExternalCallTransport = (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    const policyWithSlowTransport = {
      fetch: (input: string | URL, init?: RequestInit, options?: ExternalCallOptions) =>
        timeoutPolicy.fetch(input, init, { ...options, timeoutMs: 10, transport: slowTransport }),
    } as unknown as ExternalCallPolicy;
    const timeoutService = new ImResourceService(database, vi.fn(), policyWithSlowTransport);

    const timeoutFailure = await timeoutService.openAvatar("owner", "agent-timeout").catch((error: unknown) => error);
    expect(timeoutFailure).toMatchObject({ code: "IM_BINDING_TEMPORARILY_UNAVAILABLE", statusCode: 503 });
    const timeoutCause = (timeoutFailure as Error).cause as Error;
    expect(timeoutCause.message).toContain(
      "Avatar upstream (avatar.example.test) request failed for agent agent-timeout",
    );
    expect(timeoutCause.message).toContain("IM_PROVIDER_CALL_DEADLINE_EXCEEDED");
    expect(timeoutCause.message).not.toContain("secret-sig");
    expect(timeoutCause.cause).toMatchObject({ code: "IM_PROVIDER_CALL_DEADLINE_EXCEEDED" });
  });

  it("preserves the cause and sanitized upstreamHost when reading the avatar stream fails", async () => {
    const streamError = new Error("upstream stream reset");
    const brokenBody = new ReadableStream<Uint8Array>({
      pull() {
        return Promise.reject(streamError);
      },
    });
    const fetch = vi.fn().mockResolvedValue(
      new Response(brokenBody, {
        status: 200,
        headers: { "content-type": "image/png" },
      }),
    );
    const database = avatarDatabase("https://cdn.example.test/avatar.png?token=secret");
    const service = new ImResourceService(database, vi.fn(), { fetch } as unknown as ExternalCallPolicy);

    const failure = await service.openAvatar("owner", "agent-stream").catch((error: unknown) => error);
    expect(failure).toMatchObject({
      code: "IM_BINDING_TEMPORARILY_UNAVAILABLE",
      statusCode: 503,
      category: "transient",
    });
    const cause = (failure as Error).cause as Error;
    expect(cause.message).toBe(
      "Avatar upstream (cdn.example.test) request failed for agent agent-stream: upstream stream reset",
    );
    expect(cause.message).not.toContain("token=secret");
    expect(cause.cause).toBe(streamError);
  });
});
