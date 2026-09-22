import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { connect, createServer, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { NATIVE_PROVIDER_BRIDGE_SOURCE, NativeProviderBridge } from "../runner/native-provider-bridge.js";
import { NativeSandbox } from "../runner/native-sandbox.js";

const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const teardowns: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of teardowns.splice(0).reverse()) await close();
});
async function listen(handler: (socket: Socket) => void) {
  const sockets = new Set<Socket>();
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket);
    socket.on("error", () => undefined);
    socket.on("close", () => sockets.delete(socket));
    handler(socket);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  teardowns.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { server, port: (server.address() as { port: number }).port, sockets };
}
async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
function localSandbox(source?: string) {
  const children: ChildProcessWithoutNullStreams[] = [];
  const sandbox = new NativeSandbox({
    name: "local-native-transport-test",
    workspace: "/unused",
    spawnProcess: (_binary, args) => {
      // Real Node helper and stdio; only the unavailable native supervisor is replaced locally.
      const child = spawn(process.execPath, source ? ["-e", source] : args.slice(4), { stdio: "pipe" });
      children.push(child);
      return child;
    },
  });
  teardowns.push(async () => {
    await Promise.all(
      children.map(async (child) => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        child.kill("SIGKILL");
        await once(child, "close");
      }),
    );
  });
  return { sandbox, children };
}
async function open(
  port: number,
  options: { source?: string; signal?: AbortSignal; ports?: { connect: number; slack: number } } = {},
) {
  const local = localSandbox(options.source);
  const ports = options.ports ?? { connect: await freePort(), slack: await freePort() };
  const bridge = await NativeProviderBridge.open({
    sandbox: local.sandbox,
    targets: { connect: port, slack: port },
    entryPorts: ports,
    signal: options.signal,
    startupTimeoutMs: 1500,
  });
  teardowns.push(() => bridge.close());
  return { ...local, bridge, ports };
}
async function exchange(port: number, input?: Buffer) {
  const socket = connect({ host: "127.0.0.1", port, allowHalfOpen: true });
  const chunks: Buffer[] = [];
  const timeout = setTimeout(() => socket.destroy(new Error("test exchange timed out")), 5000);
  socket.on("data", (chunk) => {
    chunks.push(Buffer.from(chunk));
    socket.pause();
    setTimeout(() => socket.resume(), 2);
  });
  socket.on("end", () => socket.end());
  if (input) socket.end(input);
  try {
    await once(socket, "close");
    return Buffer.concat(chunks);
  } finally {
    clearTimeout(timeout);
    socket.destroy();
  }
}
function exited(child: ChildProcessWithoutNullStreams) {
  return child.exitCode !== null || child.signalCode !== null;
}

// These tests exercise byte integrity, resource ownership and hostile wire data. They do not
// claim that a local child process reproduces Cloud Run's native isolation boundary.
describe("native provider transport over exec stdio", () => {
  it("preserves a large final response and half-close with concurrent slow readers", async () => {
    const payload = randomBytes(2 * 1024 * 1024 + 123);
    const upstream = await listen((socket) => socket.end(payload));
    const { bridge, ports } = await open(upstream.port);
    const responses = await Promise.all([ports.connect, ports.slack, ports.connect].map((port) => exchange(port)));
    expect(responses.map(hash)).toEqual([hash(payload), hash(payload), hash(payload)]);
    expect(bridge.failure).toBeUndefined();
  });

  it("drains a large upload before propagating FIN and receiving its result", async () => {
    const payload = randomBytes(2 * 1024 * 1024 + 37);
    const upstream = await listen((socket) => {
      const parts: Buffer[] = [];
      socket.on("data", (chunk) => {
        parts.push(Buffer.from(chunk));
        socket.pause();
        setTimeout(() => socket.resume(), 2);
      });
      socket.on("end", () => socket.end(hash(Buffer.concat(parts))));
    });
    const { ports } = await open(upstream.port);
    expect((await exchange(ports.connect, payload)).toString()).toBe(hash(payload));
  });

  it("rejects occupied entry ports and reaps the partially started helper", async () => {
    const occupied = await listen((socket) => socket.destroy());
    const local = localSandbox();
    await expect(
      NativeProviderBridge.open({
        sandbox: local.sandbox,
        targets: { connect: occupied.port, slack: occupied.port },
        entryPorts: { connect: occupied.port, slack: await freePort() },
        startupTimeoutMs: 1500,
      }),
    ).rejects.toThrow();
    expect(local.children.every(exited)).toBe(true);
  });

  it("aborts startup promptly and confirms termination", async () => {
    const local = localSandbox("process.stdin.resume();setInterval(()=>{},1000)");
    const abort = new AbortController();
    const attempt = NativeProviderBridge.open({
      sandbox: local.sandbox,
      targets: { connect: 1, slack: 2 },
      signal: abort.signal,
      startupTimeoutMs: 30_000,
    });
    abort.abort(new Error("execution cancelled"));
    await expect(attempt).rejects.toThrow();
    expect(local.children.every(exited)).toBe(true);
  });

  it("closes active connections before the same entry ports are reused", async () => {
    const upstream = await listen((socket) => socket.resume());
    const abort = new AbortController();
    const first = await open(upstream.port, { signal: abort.signal });
    const socket = connect(first.ports.connect, "127.0.0.1");
    socket.on("error", () => undefined);
    await once(socket, "connect");
    socket.write("in progress");
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    abort.abort();
    await first.bridge.close();
    await closed;
    expect(first.children.every(exited)).toBe(true);
    const second = await open(upstream.port, { ports: first.ports });
    expect(second.bridge.failure).toBeUndefined();
  });

  it.each(Array.from({ length: 10 }, (_, index) => index))(
    "contains abrupt helper death without a shutdown race (%i)",
    async () => {
      const upstream = await listen((socket) => socket.resume());
      const { bridge, children } = await open(upstream.port);
      const failed = once(bridge.failureSignal, "abort");
      children[0]?.kill("SIGKILL");
      await failed;
      await bridge.close();
      expect(bridge.failure).toBeInstanceOf(Error);
      expect(children.every(exited)).toBe(true);
    },
  );

  it("refuses a forged parent target instead of opening an arbitrary connection", async () => {
    let accepted = 0;
    const upstream = await listen((socket) => {
      accepted += 1;
      socket.end("must not arrive");
    });
    const ports = { connect: await freePort(), slack: await freePort() };
    const source =
      `process.argv = ["node", "${ports.connect}", "${ports.slack}"];\n` +
      NATIVE_PROVIDER_BRIDGE_SOURCE.replace(
        'listen(ports[0], "connect")',
        `listen(ports[0], "127.0.0.1:${upstream.port}")`,
      );
    const { bridge } = await open(upstream.port, { ports, source });
    const socket = connect(ports.connect, "127.0.0.1");
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    socket.on("error", () => undefined);
    socket.end("forged target");
    await closed;
    expect(accepted).toBe(0);
    expect(bridge.failure).toBeUndefined();
  });

  it("contains malformed HTTP/2 input without throwing from a data event", async () => {
    const local = localSandbox(
      "process.stdout.write(Buffer.alloc(128,255));process.stdin.resume();setInterval(()=>{},1000)",
    );
    await expect(
      NativeProviderBridge.open({ sandbox: local.sandbox, targets: { connect: 1, slack: 2 }, startupTimeoutMs: 250 }),
    ).rejects.toThrow();
    expect(local.children.every(exited)).toBe(true);
  });
});
