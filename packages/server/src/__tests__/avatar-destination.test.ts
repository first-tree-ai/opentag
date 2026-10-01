import type { LookupAddress, LookupAllOptions } from "node:dns";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { createAvatarDispatcher, createAvatarLookup } from "../services/im/avatar-destination.js";

const BLOCKED_CODE = "IM_AVATAR_DESTINATION_BLOCKED";

type LookupCallback = (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void;

function scriptedResolver(addresses: string[]) {
  return vi.fn((_hostname: string, _options: LookupAllOptions, callback: LookupCallback) => {
    callback(
      null,
      addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })),
    );
  });
}

function errorFrom(callback: ReturnType<typeof vi.fn>): unknown {
  return callback.mock.calls[0]?.[0];
}

describe("avatar connection destination policy", () => {
  it.each([
    ["loopback", "127.0.0.1"],
    ["private", "10.0.0.1"],
    ["link-local", "169.254.1.1"],
    ["IPv6 loopback", "::1"],
    ["IPv6 unique-local", "fc00::1"],
    ["IPv4-mapped loopback", "::ffff:127.0.0.1"],
  ])("rejects a %s DNS answer before connecting", (_label, address) => {
    const resolve = scriptedResolver([address]);
    const callback = vi.fn();

    createAvatarLookup(resolve)("avatar.example.test", { all: true }, callback);

    expect(errorFrom(callback)).toMatchObject({ code: BLOCKED_CODE });
    expect(resolve).toHaveBeenCalledWith("avatar.example.test", { all: true, verbatim: true }, expect.any(Function));
  });

  it("rejects localhost names without consulting DNS", () => {
    const resolve = scriptedResolver(["93.184.216.34"]);
    const callback = vi.fn();

    createAvatarLookup(resolve)("cdn.localhost", { all: true }, callback);

    expect(errorFrom(callback)).toMatchObject({ code: BLOCKED_CODE });
    expect(resolve).not.toHaveBeenCalled();
  });

  it("rejects mixed public and private answers in either order", () => {
    for (const addresses of [
      ["93.184.216.34", "10.0.0.1"],
      ["10.0.0.1", "93.184.216.34"],
    ]) {
      const callback = vi.fn();
      createAvatarLookup(scriptedResolver(addresses))("split.example.test", { all: true }, callback);
      expect(errorFrom(callback)).toMatchObject({ code: BLOCKED_CODE });
    }
  });

  it("allows public answers and preserves Node lookup callback shapes", () => {
    const resolve = scriptedResolver(["93.184.216.34", "2001:4860:4860::8888"]);
    const allCallback = vi.fn();
    createAvatarLookup(resolve)("cdn.example.test", { all: true }, allCallback);
    expect(allCallback).toHaveBeenCalledWith(null, [
      { address: "93.184.216.34", family: 4 },
      { address: "2001:4860:4860::8888", family: 6 },
    ]);

    const oneCallback = vi.fn();
    createAvatarLookup(resolve)("cdn.example.test", { all: false }, oneCallback);
    expect(oneCallback).toHaveBeenCalledWith(null, "93.184.216.34", 4);
  });

  it("rejects at connection time without sending an HTTP request", async () => {
    let requests = 0;
    const server = createServer((_request, response) => {
      requests += 1;
      response.end("unexpected");
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const port = (server.address() as AddressInfo).port;
    const dispatcher = createAvatarDispatcher(scriptedResolver(["127.0.0.1"]));
    try {
      await expect(
        fetch(`http://avatar.example.test:${port}/avatar`, { dispatcher } as RequestInit & { dispatcher: unknown }),
      ).rejects.toMatchObject({ cause: { code: BLOCKED_CODE } });
    } finally {
      await dispatcher.close();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
    expect(requests).toBe(0);
  });
});
