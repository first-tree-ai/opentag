import { afterEach, describe, expect, it, vi } from "vitest";
import type { DatabaseClient } from "../db/client.js";
import { AVATAR_CACHE_TTL_MS } from "../services/im/avatar-cache.js";
import type { ExternalCallPolicy } from "../services/im/external-call-policy.js";
import { type AuthorizedAgentAvatar, ImResourceService } from "../services/im/im-resource-service.js";

afterEach(() => vi.useRealTimers());

function fixture() {
  const binding = { bindingId: "binding-1", generation: 1, providerUrl: "https://cdn.example.test/avatar.png" };
  const query = {
    from: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn(async () => [binding]),
  };
  const database = { select: vi.fn().mockReturnValue(query) } as unknown as DatabaseClient;
  const fetch = vi.fn(async () => imageResponse());
  const policy = { fetch } as unknown as ExternalCallPolicy;
  return { binding, query, database, fetch, policy, service: new ImResourceService(database, vi.fn(), policy) };
}

function imageResponse(body: ConstructorParameters<typeof Response>[0] = "image") {
  return new Response(body, { headers: { "content-type": "IMAGE/PNG; charset=binary" } });
}

async function bytes(avatar: AuthorizedAgentAvatar): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of avatar.stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

describe("authorized avatar reuse", () => {
  it("authorizes every hit, skips upstream work, and returns independent image streams", async () => {
    const { service, fetch, query } = fixture();
    const first = await service.openAvatar("owner", "agent");
    expect(first.mediaType).toBe("image/png");
    expect(first.sizeBytes).toBe(5);
    const firstBytes = await bytes(first);
    expect(firstBytes.toString()).toBe("image");
    firstBytes.fill(0);
    const second = await service.openAvatar("owner", "agent");
    expect(await bytes(second)).toEqual(Buffer.from("image"));
    expect(second.stream).not.toBe(first.stream);
    expect(query.limit).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("re-fetches at the TTL boundary without extending the TTL on a hit", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { service, fetch } = fixture();
    await bytes(await service.openAvatar("owner", "agent"));
    vi.setSystemTime(Date.now() + AVATAR_CACHE_TTL_MS - 1);
    await bytes(await service.openAvatar("owner", "agent"));
    expect(fetch).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 1);
    await bytes(await service.openAvatar("owner", "agent"));
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each(["bindingId", "generation", "providerUrl"] as const)(
    "does not reuse bytes after the authorized %s changes",
    async (field) => {
      const { binding, service, fetch } = fixture();
      await bytes(await service.openAvatar("owner", "agent"));
      if (field === "generation") binding.generation += 1;
      else binding[field] += "changed";
      fetch.mockResolvedValueOnce(imageResponse("new image"));
      expect(await bytes(await service.openAvatar("owner", "agent"))).toEqual(Buffer.from("new image"));
      expect(fetch).toHaveBeenCalledTimes(2);
    },
  );

  it("scopes bytes to the Account and Agent even for the same binding and URL", async () => {
    const { service, fetch } = fixture();
    for (const [owner, agent] of [
      ["one", "first"],
      ["two", "first"],
      ["one", "second"],
    ] as const) {
      await bytes(await service.openAvatar(owner, agent));
    }
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("does not serve a warm entry when authority is revoked or the database fails", async () => {
    const { service, fetch, query } = fixture();
    await bytes(await service.openAvatar("owner", "agent"));
    query.limit.mockResolvedValueOnce([]);
    await expect(service.openAvatar("owner", "agent")).rejects.toMatchObject({
      code: "IM_BINDING_NOT_FOUND",
      statusCode: 404,
    });
    query.limit.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(service.openAvatar("owner", "agent")).rejects.toThrow("database unavailable");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not serve a warm entry when the avatar URL is cleared", async () => {
    const { service, fetch, binding } = fixture();
    await bytes(await service.openAvatar("owner", "agent"));
    binding.providerUrl = "";
    await expect(service.openAvatar("owner", "agent")).rejects.toMatchObject({ statusCode: 404 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps cache lifetimes local to the service instance", async () => {
    const { service, fetch, database, policy } = fixture();
    await bytes(await service.openAvatar("owner", "agent"));
    const other = new ImResourceService(database, vi.fn(), policy);
    await bytes(await other.openAvatar("owner", "agent"));
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([403, 404, 410, 502])("does not cache an upstream %s failure", async (status) => {
    const { service, fetch } = fixture();
    const cancel = vi.fn();
    fetch.mockResolvedValueOnce(new Response(new ReadableStream({ cancel }), { status }));
    await expect(service.openAvatar("owner", "agent")).rejects.toMatchObject({
      statusCode: status === 502 ? 503 : 404,
    });
    expect(cancel).toHaveBeenCalledOnce();
    expect(await bytes(await service.openAvatar("owner", "agent"))).toEqual(Buffer.from("image"));
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not cache transport failures, missing bodies, or unsupported media", async () => {
    const { service, fetch } = fixture();
    fetch.mockRejectedValueOnce(new Error("request aborted"));
    await expect(service.openAvatar("owner", "agent")).rejects.toMatchObject({ statusCode: 503 });
    fetch.mockResolvedValueOnce(new Response(null));
    await expect(service.openAvatar("owner", "agent")).rejects.toMatchObject({ statusCode: 503 });
    const cancel = vi.fn();
    fetch.mockResolvedValueOnce(
      new Response(new ReadableStream({ cancel }), {
        headers: { "content-type": "text/html" },
      }),
    );
    await expect(service.openAvatar("owner", "agent")).rejects.toMatchObject({ statusCode: 415 });
    expect(cancel).toHaveBeenCalledOnce();
    await bytes(await service.openAvatar("owner", "agent"));
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("does not cache a complete empty image and lets the next request recover", async () => {
    const { service, fetch } = fixture();
    fetch.mockResolvedValueOnce(imageResponse(""));
    const empty = await service.openAvatar("owner", "agent");
    expect(empty.mediaType).toBe("image/png");
    expect(empty.sizeBytes).toBe(0);
    expect(await bytes(empty)).toHaveLength(0);
    expect(await bytes(await service.openAvatar("owner", "agent"))).toEqual(Buffer.from("image"));
    expect(await bytes(await service.openAvatar("owner", "agent"))).toEqual(Buffer.from("image"));
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("cancels an oversized body and never retains its partial bytes", async () => {
    const { service, fetch } = fixture();
    const cancel = vi.fn();
    fetch.mockResolvedValueOnce(
      imageResponse(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.enqueue(new Uint8Array(1024 * 1024));
          },
          cancel,
        }),
      ),
    );
    await expect(service.openAvatar("owner", "agent")).rejects.toMatchObject({
      code: "IM_AVATAR_TOO_LARGE",
      statusCode: 413,
    });
    expect(cancel).toHaveBeenCalledOnce();
    expect(await bytes(await service.openAvatar("owner", "agent"))).toEqual(Buffer.from("image"));
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("accepts a complete body at the existing 5 MiB limit", async () => {
    const { service, fetch } = fixture();
    const body = Buffer.alloc(5 * 1024 * 1024, 4);
    fetch.mockResolvedValueOnce(imageResponse(body));
    expect((await bytes(await service.openAvatar("owner", "agent"))).equals(body)).toBe(true);
    expect((await bytes(await service.openAvatar("owner", "agent"))).equals(body)).toBe(true);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("keeps concurrent cold reads independent until a body completes and survives a peer failure", async () => {
    const { service, fetch } = fixture();
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    fetch.mockResolvedValueOnce(
      imageResponse(
        new ReadableStream<Uint8Array>({
          start(value) {
            controller = value;
            value.enqueue(Buffer.from("partial"));
          },
        }),
      ),
    );
    const pending = service.openAvatar("owner", "agent");
    const failure = expect(pending).rejects.toMatchObject({ statusCode: 503 });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    expect(await bytes(await service.openAvatar("owner", "agent"))).toEqual(Buffer.from("image"));
    expect(fetch).toHaveBeenCalledTimes(2);
    controller?.error(new Error("stream aborted"));
    await failure;
    expect(await bytes(await service.openAvatar("owner", "agent"))).toEqual(Buffer.from("image"));
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("allows a retry after a partial body fails and isolates consumer cancellation", async () => {
    const { service, fetch } = fixture();
    let pulls = 0;
    fetch.mockResolvedValueOnce(
      imageResponse(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (pulls++ === 0) controller.enqueue(Buffer.from("partial"));
            else controller.error(new Error("upstream reset"));
          },
        }),
      ),
    );
    await expect(service.openAvatar("owner", "agent")).rejects.toMatchObject({ statusCode: 503 });
    const completed = await service.openAvatar("owner", "agent");
    completed.stream.destroy();
    const hit = await service.openAvatar("owner", "agent");
    hit.stream.destroy();
    expect(await bytes(await service.openAvatar("owner", "agent"))).toEqual(Buffer.from("image"));
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not let a late old-URL download replace the current binding's cached bytes", async () => {
    const { service, fetch, binding } = fixture();
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    fetch.mockResolvedValueOnce(
      imageResponse(
        new ReadableStream<Uint8Array>({
          start(value) {
            controller = value;
          },
        }),
      ),
    );
    const old = service.openAvatar("owner", "agent");
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    binding.providerUrl = "https://cdn.example.test/new.png";
    fetch.mockResolvedValueOnce(imageResponse("new image"));
    expect(await bytes(await service.openAvatar("owner", "agent"))).toEqual(Buffer.from("new image"));
    controller?.enqueue(Buffer.from("old image"));
    controller?.close();
    expect(await bytes(await old)).toEqual(Buffer.from("old image"));
    expect(await bytes(await service.openAvatar("owner", "agent"))).toEqual(Buffer.from("new image"));
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
