import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createGitProxySocketServer } from "../runtime/runtime-proxy-git-socket.js";

const connect = (host = "github.com", port = 80, command = 1, type = 3) =>
  Buffer.concat([
    Buffer.from([5, command, 0, type, Buffer.byteLength(host)]),
    Buffer.from(host),
    Buffer.from([port >> 8, port & 255]),
  ]);
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ot-socks-")),
    path = join(root, "g.sock");
  const sockets = new Set<net.Socket>();
  const accepted: Buffer[] = [];
  const server = createGitProxySocketServer(
    (socket, head) => {
      accepted.push(head);
      socket.end();
    },
    (socket) => sockets.add(socket),
  );
  server.listen(path);
  await once(server, "listening");
  return {
    accepted,
    async send(chunks: Buffer[]) {
      const socket = net.connect(path);
      const result: Buffer[] = [];
      socket.on("data", (chunk) => result.push(Buffer.from(chunk)));
      socket.on("error", () => {});
      await once(socket, "connect");
      const closed = new Promise<void>((resolve) => socket.on("close", () => resolve()));
      for (const chunk of chunks) {
        socket.write(chunk);
        await new Promise((resolve) => setImmediate(resolve));
      }
      await closed;
      return Buffer.concat(result);
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    },
  };
}

describe.skipIf(process.platform === "win32")("Git-only SOCKS Unix entry", () => {
  it.each([false, true])(
    "accepts fragmented=%s GitHub CONNECT and preserves pipelined HTTP bytes",
    async (fragmented) => {
      const f = await fixture();
      try {
        const bytes = Buffer.concat([Buffer.from([5, 2, 2, 0]), connect("GitHub.com"), Buffer.from("HTTP")]);
        const reply = await f.send(fragmented ? [...bytes].map((byte) => Buffer.from([byte])) : [bytes]);
        expect(reply).toEqual(Buffer.from([5, 0, 5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
        // Fragmented HTTP can arrive after the handshake; coalesced data must be delivered intact.
        expect(f.accepted).toHaveLength(1);
        if (!fragmented) expect(f.accepted[0]?.toString()).toBe("HTTP");
      } finally {
        await f.close();
      }
    },
  );
  it.each([
    connect("api.github.com"),
    connect("github.com.evil.invalid"),
    connect("127.0.0.1"),
    connect("github.com", 443),
    connect("github.com", 80, 2),
    connect("github.com", 80, 3),
    connect("github.com", 80, 1, 1),
    connect("github.com", 80, 1, 4),
    Buffer.from([4, 1, 0, 3, 0, 1, 187]),
  ])("rejects foreign destinations and unsupported SOCKS operations %j", async (request) => {
    const f = await fixture();
    try {
      expect(await f.send([Buffer.from([5, 1, 0]), request])).toEqual(
        Buffer.from([5, 0, 5, 2, 0, 1, 0, 0, 0, 0, 0, 0]),
      );
      expect(f.accepted).toEqual([]);
    } finally {
      await f.close();
    }
  });
  it.each([Buffer.from([4, 1, 0]), Buffer.from([5, 0]), Buffer.from([5, 1, 2])])(
    "rejects incompatible authentication %j",
    async (greeting) => {
      const f = await fixture();
      try {
        expect(await f.send([greeting])).toEqual(Buffer.from([5, 255]));
        expect(f.accepted).toEqual([]);
      } finally {
        await f.close();
      }
    },
  );
  it("bounds oversized and stalled handshakes", async () => {
    const f = await fixture();
    try {
      await f.send([Buffer.alloc(4097)]);
      await f.send([Buffer.from([5])]);
      expect(f.accepted).toEqual([]);
    } finally {
      await f.close();
    }
  }, 10000);
});
