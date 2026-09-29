import { createServer, connect as netConnect, type Server, type Socket } from "node:net";
import {
  classifyOutboundDestination,
  classifyOutboundUrl,
  type OutboundAddressPolicy,
  resolveAllAddresses,
} from "../../outbound/address-policy.js";

/**
 * A loopback proxy that pins the address every upstream connection is made to.
 *
 * Git resolves hostnames inside libcurl, and libcurl offers no way to inject a resolved address, so
 * the address rules cannot be bound to a git connection the way the HTTP transport binds them. They
 * can be bound one step out: git is told to use this proxy, and the proxy is what dials — after
 * resolving the target itself and refusing anything but a public address. The peer still sees the
 * hostname (`Host`, and for TLS the handshake is passed through untouched), and a name that resolves
 * privately on the second lookup is refused here, because there is no second lookup.
 *
 * The proxy refuses rather than forwards on any doubt: an unknown method, a target that is not an
 * absolute URL, an address the policy blocks, or a CONNECT to somewhere the policy rejects all end
 * the connection with a 502. Nothing about a deployment's own reachability depends on the client.
 *
 * Plain-HTTP requests are forwarded with `connection: close`. libcurl would otherwise reuse one proxy
 * connection for several origin requests, and a transparent byte pipe cannot rewrite the second
 * request's absolute-form line; closing costs one TCP handshake per request and keeps every request
 * individually authorized.
 */

const HEADER_LIMIT_BYTES = 16 * 1024;
const DEFAULT_PORTS = new Map([
  ["http:", 80],
  ["https:", 443],
]);

export interface SkillSourceTunnelOptions {
  allowLoopback: boolean;
  resolveAddresses?: (hostname: string) => Promise<string[]>;
}

export class SkillSourceTunnel {
  readonly #server: Server;
  readonly #port: number;
  readonly #policy: OutboundAddressPolicy;
  readonly #resolveAddresses: (hostname: string) => Promise<string[]>;
  #closed = false;

  private constructor(
    server: Server,
    port: number,
    options: Required<Pick<SkillSourceTunnelOptions, "allowLoopback">> & SkillSourceTunnelOptions,
  ) {
    this.#server = server;
    this.#port = port;
    this.#policy = { allowLoopback: options.allowLoopback };
    this.#resolveAddresses = options.resolveAddresses ?? resolveAllAddresses;
  }

  static start(options: SkillSourceTunnelOptions): Promise<SkillSourceTunnel> {
    return new Promise((resolve, reject) => {
      const server = createServer();
      server.on("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const port = typeof address === "object" && address !== null ? address.port : 0;
        const tunnel = new SkillSourceTunnel(server, port, { ...options });
        server.on("connection", (socket) => tunnel.#accept(socket));
        resolve(tunnel);
      });
    });
  }

  /** The value to hand git as `http.proxy`. */
  get proxyUrl(): string {
    return `http://127.0.0.1:${this.#port}`;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }

  #accept(socket: Socket): void {
    const chunks: Buffer[] = [];
    let read = 0;
    const onData = (chunk: Buffer) => {
      chunks.push(chunk);
      read += chunk.byteLength;
      const head = Buffer.concat(chunks);
      const end = head.indexOf("\r\n\r\n");
      if (end < 0) {
        if (read > HEADER_LIMIT_BYTES) this.#refuse(socket);
        return;
      }
      socket.off("data", onData);
      void this.#forward(socket, head.subarray(0, end).toString("utf8"), head.subarray(end + 4));
    };
    socket.on("data", onData);
    socket.on("error", () => socket.destroy());
  }

  #refuse(socket: Socket): void {
    socket.end("HTTP/1.1 502 Bad Gateway\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
  }

  /**
   * Resolves and judges the target, then either tunnels bytes to it (CONNECT) or forwards one
   * rewritten request (plain HTTP). Every failure is a 502 with no detail: the proxy's reason is an
   * internal fact, and the client is a git process the caller already reads as "the source failed".
   */
  async #forward(socket: Socket, head: string, remainder: Buffer): Promise<void> {
    const [requestLine, ...headerLines] = head.split("\r\n");
    const parts = (requestLine ?? "").split(" ");
    const method = parts[0] ?? "";
    const target = parts[1] ?? "";
    if (target === "") {
      this.#refuse(socket);
      return;
    }
    try {
      if (method.toUpperCase() === "CONNECT") await this.#tunnel(socket, target, remainder);
      else await this.#forwardRequest(socket, method, target, headerLines, remainder);
    } catch {
      this.#refuse(socket);
    }
  }

  /** Resolves a `host:port` or URL target to an address the policy approves. */
  async #approve(rawUrl: string): Promise<{ address: string; family: number; port: number; hostname: string }> {
    const url = new URL(rawUrl);
    const approved = classifyOutboundUrl(url.toString(), this.#policy);
    if (!approved.ok) throw new Error("blocked");
    const destination = await classifyOutboundDestination(approved.url, this.#resolveAddresses);
    if (!destination.ok) throw new Error("blocked");
    const port = url.port === "" ? (DEFAULT_PORTS.get(url.protocol) ?? 80) : Number(url.port);
    const pin = destination.pin;
    return {
      hostname: url.hostname.replace(/^\[|\]$/g, ""),
      port,
      // A literal carries no pin: the URL already names the address it wants dialed.
      address: pin?.address ?? url.hostname.replace(/^\[|\]$/g, ""),
      family: pin?.family ?? 0,
    };
  }

  async #tunnel(socket: Socket, target: string, remainder: Buffer): Promise<void> {
    const [host, port] = target.split(":");
    const approved = await this.#approve(`https://${host}:${port ?? "443"}`);
    const upstream = netConnect({ host: approved.address, port: approved.port, family: approved.family });
    await connected(upstream);
    socket.write("HTTP/1.1 200 Connection established\r\n\r\n");
    if (remainder.byteLength > 0) upstream.write(remainder);
    pipe(socket, upstream);
  }

  async #forwardRequest(
    socket: Socket,
    method: string,
    target: string,
    headerLines: readonly string[],
    remainder: Buffer,
  ): Promise<void> {
    const approved = await this.#approve(target);
    const url = new URL(target);
    const upstream = netConnect({ host: approved.address, port: approved.port, family: approved.family });
    await connected(upstream);
    // The absolute-form target is rewritten to origin-form, and the connection is closed after the
    // exchange so the next request arrives here again to be judged.
    const headers = headerLines.filter((line) => !/^connection:/i.test(line));
    const rewritten = [`${method} ${url.pathname}${url.search} HTTP/1.1`, ...headers, "connection: close", "", ""].join(
      "\r\n",
    );
    upstream.write(rewritten);
    if (remainder.byteLength > 0) upstream.write(remainder);
    pipe(socket, upstream);
  }
}

function connected(socket: Socket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("error", reject);
  });
}

function pipe(client: Socket, upstream: Socket): void {
  client.pipe(upstream);
  upstream.pipe(client);
  const destroy = () => {
    client.destroy();
    upstream.destroy();
  };
  client.on("error", destroy);
  upstream.on("error", destroy);
  upstream.on("close", destroy);
}
