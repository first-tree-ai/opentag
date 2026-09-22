import { constants, createServer, type ServerHttp2Stream } from "node:http2";
import { connect, type Socket } from "node:net";
import { CLOUD_CONNECT_PROXY_PORT, CLOUD_SLACK_API_PORT } from "../cloud-runtime/sandbox-entry.js";
import { type NativeSandbox, NativeSandboxError, SANDBOX_NODE, type SandboxExecDuplex } from "./native-sandbox.js";

/** Fixed limits, per execution. Node's HTTP/2 streams supply framing, flow control and resets. */
export const NATIVE_BRIDGE_MAX_STREAMS = 64;
const STARTUP_TIMEOUT_MS = 10_000;
const SHUTDOWN_TIMEOUT_MS = 2_000;

/**
 * Native helper: two Sandbox-local TCP entries multiplexed over sandbox exec stdio. HTTP/2
 * runs only on the pipe; there is no parent network listener. CONNECT authorities are fixed
 * target enums, never addresses. EOF/termination removes both entries with the process.
 */
export const NATIVE_PROVIDER_BRIDGE_SOURCE = `
"use strict";
const http2 = require("node:http2");
const net = require("node:net");
const { Duplex } = require("node:stream");
const ports = process.argv.slice(1).map(Number);
if (ports.length !== 2 || ports.some(p => !Number.isInteger(p) || p < 1 || p > 65535)) process.exit(2);
const clients = new Set();
const servers = [];
let closing = false;
const shutdown = code => {
  if (closing) return;
  closing = true;
  for (const server of servers) server.close();
  for (const client of clients) client.destroy();
  process.exit(code);
};
const session = http2.connect("http://native-provider", {
  createConnection: () => Duplex.from({ readable: process.stdin, writable: process.stdout }),
  maxSessionMemory: 4,
  maxHeaderListPairs: 8,
});
session.on("error", () => shutdown(3));
session.on("close", () => shutdown(0));
process.stdin.on("end", () => shutdown(0));
process.stdin.on("error", () => shutdown(3));
process.stdout.on("error", () => shutdown(3));
process.on("SIGTERM", () => shutdown(0));
process.on("SIGINT", () => shutdown(0));
const listen = (port, target) => new Promise((resolve, reject) => {
  const server = net.createServer({ allowHalfOpen: true }, client => {
    if (closing || clients.size >= 64) { client.destroy(); return; }
    clients.add(client);
    let stream;
    try { stream = session.request({ ":method": "CONNECT", ":authority": target }); }
    catch { clients.delete(client); client.destroy(); return; }
    client.on("error", () => stream.close(http2.constants.NGHTTP2_CANCEL));
    client.on("close", () => { clients.delete(client); stream.close(http2.constants.NGHTTP2_CANCEL); });
    stream.on("error", () => client.destroy());
    stream.on("aborted", () => client.destroy());
    stream.on("response", headers => {
      if (headers[":status"] !== 200) client.destroy();
    });
    // pipe preserves backpressure and sends FIN after queued data. Do not destroy on EOF.
    client.pipe(stream);
    stream.pipe(client);
  });
  servers.push(server);
  server.once("error", reject);
  server.listen(port, "127.0.0.1", () => {
    server.removeListener("error", reject);
    server.on("error", () => shutdown(3));
    resolve();
  });
});
Promise.all([listen(ports[0], "connect"), listen(ports[1], "slack")]).then(() => {
  const ready = session.request({ ":path": "/ready" });
  ready.on("error", () => shutdown(3));
  ready.on("response", headers => { if (headers[":status"] !== 204) shutdown(3); });
  ready.resume();
  ready.end();
}, () => shutdown(2));
`;

export interface NativeProviderBridgeOpenInput {
  readonly sandbox: Pick<NativeSandbox, "openDuplex">;
  readonly targets: { readonly connect: number; readonly slack: number };
  /** Tests may relocate Sandbox entry ports; production uses the published fixed pair. */
  readonly entryPorts?: { readonly connect: number; readonly slack: number };
  readonly startupTimeoutMs?: number;
  readonly signal?: AbortSignal;
}

/** One execution owns the child, its HTTP/2 session and all adapter connections. No replay. */
export class NativeProviderBridge {
  readonly #duplex: SandboxExecDuplex;
  readonly #targets: NativeProviderBridgeOpenInput["targets"];
  readonly #sockets = new Set<Socket>();
  readonly #abort = new AbortController();
  #resolveReady!: () => void;
  #rejectReady!: (error: Error) => void;
  readonly #ready = new Promise<void>((resolve, reject) => {
    this.#resolveReady = resolve;
    this.#rejectReady = reject;
  });
  #resolveExit!: () => void;
  readonly #exit = new Promise<void>((resolve) => {
    this.#resolveExit = resolve;
  });
  #failure?: Error;
  #readySeen = false;
  #exited = false;
  #closing = false;
  #closePromise?: Promise<void>;
  #unsubscribeAbort?: () => void;

  private constructor(duplex: SandboxExecDuplex, targets: NativeProviderBridgeOpenInput["targets"]) {
    this.#duplex = duplex;
    this.#targets = targets;
    duplex.onExit(() => {
      this.#exited = true;
      this.#resolveExit();
      if (!this.#closing) this.#fail("The native provider bridge exited unexpectedly");
    });
    duplex.onError(() => this.#fail("The native provider bridge pipe failed"));
    // Drain diagnostics without retaining untrusted output or credentials.
    duplex.onStderr(() => undefined);
    const server = createServer({
      maxSessionMemory: 4,
      maxHeaderListPairs: 8,
      settings: { maxConcurrentStreams: NATIVE_BRIDGE_MAX_STREAMS },
    });
    server.on("session", (session) => {
      session.on("error", () => this.#fail("The native provider bridge session failed"));
      session.on("close", () => {
        if (!this.#closing) this.#fail("The native provider bridge session closed unexpectedly");
      });
    });
    server.on("sessionError", () => this.#fail("The native provider bridge protocol failed"));
    server.on("error", () => this.#fail("The native provider bridge failed"));
    server.on("stream", (stream: ServerHttp2Stream, headers) => {
      stream.on("error", () => undefined); // Per-request failures must not crash the Runner.
      if (this.#closing) {
        stream.close(constants.NGHTTP2_CANCEL);
        return;
      }
      if (headers[":method"] === "GET" && headers[":path"] === "/ready" && !this.#readySeen) {
        this.#readySeen = true;
        stream.respond({ ":status": 204 });
        stream.end();
        this.#resolveReady();
        return;
      }
      const target = headers[":authority"];
      if (
        !this.#readySeen ||
        headers[":method"] !== "CONNECT" ||
        (target !== "connect" && target !== "slack") ||
        this.#sockets.size >= NATIVE_BRIDGE_MAX_STREAMS
      ) {
        stream.close(constants.NGHTTP2_REFUSED_STREAM);
        return;
      }
      this.#connect(stream, this.#targets[target]);
    });
    server.emit("connection", duplex.asStream());
  }

  static async open(input: NativeProviderBridgeOpenInput): Promise<NativeProviderBridge> {
    input.signal?.throwIfAborted();
    const ports = input.entryPorts ?? { connect: CLOUD_CONNECT_PROXY_PORT, slack: CLOUD_SLACK_API_PORT };
    for (const port of [input.targets.connect, input.targets.slack, ports.connect, ports.slack]) {
      if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("Invalid native provider bridge port");
    }
    const duplex = input.sandbox.openDuplex(SANDBOX_NODE, [
      "-e",
      NATIVE_PROVIDER_BRIDGE_SOURCE,
      String(ports.connect),
      String(ports.slack),
    ]);
    const bridge = new NativeProviderBridge(duplex, input.targets);
    const abort = () => {
      void bridge.close().catch(() => undefined);
    };
    input.signal?.addEventListener("abort", abort, { once: true });
    bridge.#unsubscribeAbort = () => input.signal?.removeEventListener("abort", abort);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (input.signal?.aborted) abort();
      await Promise.race([
        bridge.#ready,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("The native provider bridge did not become ready")),
            input.startupTimeoutMs ?? STARTUP_TIMEOUT_MS,
          );
        }),
      ]);
      input.signal?.throwIfAborted();
      if (bridge.#failure || bridge.#closing)
        throw bridge.#failure ?? new Error("The native provider bridge closed during startup");
      return bridge;
    } catch (error) {
      await bridge.close();
      throw error;
    } finally {
      clearTimeout(timer);
      if (bridge.#closing) bridge.#unsubscribeAbort?.();
    }
  }

  get failure(): Error | undefined {
    return this.#failure;
  }
  get failureSignal(): AbortSignal {
    return this.#abort.signal;
  }
  get closed(): boolean {
    return this.#closing;
  }
  /** Observed exec process exit. close() also rejects forced supervisor termination. */
  get whenClosed(): Promise<void> {
    return this.#exit;
  }

  #connect(stream: ServerHttp2Stream, port: number): void {
    const socket = connect({ host: "127.0.0.1", port, allowHalfOpen: true });
    this.#sockets.add(socket);
    socket.on("connect", () => {
      if (stream.destroyed || this.#closing) {
        socket.destroy();
        return;
      }
      stream.respond({ ":status": 200 });
      stream.pipe(socket);
      socket.pipe(stream);
    });
    socket.on("error", () => stream.close(constants.NGHTTP2_CONNECT_ERROR));
    socket.on("close", (hadError) => {
      this.#sockets.delete(socket);
      if (hadError) stream.close(constants.NGHTTP2_CONNECT_ERROR);
    });
    stream.on("aborted", () => socket.destroy());
    stream.on("close", () => socket.destroy());
  }

  #fail(message: string): void {
    if (this.#closing || this.#failure) return;
    this.#failure = new NativeSandboxError("exec_failed", message);
    this.#rejectReady(this.#failure);
    this.#abort.abort(this.#failure);
    void this.close().catch(() => undefined); // Returned again to the owner's awaited cleanup.
  }

  close(): Promise<void> {
    this.#closePromise ??= this.#close();
    return this.#closePromise;
  }

  async #close(): Promise<void> {
    this.#closing = true;
    this.#unsubscribeAbort?.();
    this.#rejectReady(new Error("The native provider bridge closed before ready"));
    for (const socket of this.#sockets) socket.destroy();
    this.#sockets.clear();
    // HTTP/2 owns this stream. Closing the transport lets it tear down the session without
    // racing a second GOAWAY write against an already-ending child stdin.
    this.#duplex.asStream().destroy();
    if (await this.#waitForExit()) return;
    this.#duplex.kill("SIGKILL");
    await this.#waitForExit();
    // Killing the host-side exec supervisor alone cannot prove the guest helper stopped.
    // Fail closed even if that supervisor exits; the owner must not reuse this Sandbox.
    throw new NativeSandboxError("delete_failed", "The native provider bridge helper termination was not confirmed");
  }

  async #waitForExit(): Promise<boolean> {
    if (this.#exited) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.#exit.then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), SHUTDOWN_TIMEOUT_MS);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}
