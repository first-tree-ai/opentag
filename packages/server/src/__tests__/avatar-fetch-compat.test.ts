import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";

describe("avatar transport fetch compatibility", () => {
  it("preserves the global dispatcher and native uploads when avatar transport loads", async () => {
    const server = createServer((request, response) => {
      request.resume();
      request.on("end", () => response.end("ok"));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/upload`;
    let transport: { close(): Promise<void> } | undefined;

    try {
      expect(await (await fetch(url)).text()).toBe("ok");
      const nativeFetch = globalThis.fetch;
      const legacyDispatcher = Reflect.get(globalThis, Symbol.for("undici.globalDispatcher.1"));
      const currentDispatcher = Reflect.get(globalThis, Symbol.for("undici.globalDispatcher.2"));
      const { createAvatarTransport } = await import("../services/im/avatar-destination.js");

      expect(globalThis.fetch).toBe(nativeFetch);
      expect(Reflect.get(globalThis, Symbol.for("undici.globalDispatcher.1"))).toBe(legacyDispatcher);
      expect(Reflect.get(globalThis, Symbol.for("undici.globalDispatcher.2"))).toBe(currentDispatcher);

      transport = createAvatarTransport();
      expect(Reflect.get(globalThis, Symbol.for("undici.globalDispatcher.1"))).toBe(legacyDispatcher);
      expect(Reflect.get(globalThis, Symbol.for("undici.globalDispatcher.2"))).toBe(currentDispatcher);

      const body = new TextEncoder().encode("workspace archive");
      const response = await fetch(url, {
        method: "PUT",
        headers: { "content-length": String(body.byteLength) },
        body,
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("ok");
    } finally {
      await transport?.close();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
});
