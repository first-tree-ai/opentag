import { createServer, request as httpRequest, type Server } from "node:http";
import {
  createServer as createNetServer,
  type Server as NetServer,
  connect as netConnect,
  type Socket,
} from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { SkillSourceTunnel } from "../services/skills/source/source-tunnel.js";

/**
 * The address-pinning tunnel git dials through.
 *
 * The cases speak raw HTTP over a loopback socket, because the subject is a proxy: what matters is
 * the byte-level exchange — which target it dials, what it refuses, and how it rewrites a request —
 * not the client library that would normally sit on top.
 */

const openServers: NetServer[] = [];
const openTunnels: SkillSourceTunnel[] = [];

afterEach(async () => {
  await Promise.all(openTunnels.splice(0).map((tunnel) => tunnel.close()));
  await Promise.all(
    openServers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

/** A loopback origin that answers every request with one body and records what it received. */
function originServer(body = "origin"): Promise<{ server: Server; port: number; received: () => string }> {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(`${request.method ?? ""} ${request.url ?? ""} connection=${request.headers.connection ?? ""}`);
    response.writeHead(200, { "content-type": "text/plain", "content-length": String(body.length) });
    response.end(body);
  });
  openServers.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        server,
        port: typeof address === "object" && address !== null ? address.port : 0,
        received: () => requests.join("|"),
      });
    });
  });
}

/** Waits for a condition that a socket's own event loop turn will satisfy. */
async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("the condition was not met in time");
}

/**
 * A raw TCP peer that accepts and stays connected, so a CONNECT tunnel remains open.
 *
 * Deliberately `node:net`, not `node:http`: a CONNECT tunnel carries no HTTP request, so an HTTP
 * server would never see the connection as a request and the socket count would be meaningless.
 */
function holdServer(): Promise<{ server: NetServer; port: number; sockets: Set<Socket> }> {
  const sockets = new Set<Socket>();
  const server = createNetServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  openServers.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({ server, port: typeof address === "object" && address !== null ? address.port : 0, sockets });
    });
  });
}

function tunnel(options: { allowLoopback?: boolean; resolveAddresses?: (host: string) => Promise<string[]> } = {}) {
  return SkillSourceTunnel.start({
    allowLoopback: options.allowLoopback === true,
    ...(options.resolveAddresses === undefined ? {} : { resolveAddresses: options.resolveAddresses }),
  }).then((started) => {
    openTunnels.push(started);
    return started;
  });
}

/** Writes one request and reads the whole response, over a socket the test owns. */
function exchange(port: number, request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = netConnect(port, "127.0.0.1");
    const chunks: Buffer[] = [];
    socket.on("connect", () => socket.write(request));
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("error", reject);
    socket.on("close", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

describe("SkillSourceTunnel", () => {
  it("forwards a plain-HTTP request to the origin and closes the connection", async () => {
    const origin = await originServer("forwarded");
    const started = await tunnel({ allowLoopback: true });
    const response = await exchange(
      Number(new URL(started.proxyUrl).port),
      `GET http://127.0.0.1:${origin.port}/repository.git HTTP/1.1\r\nhost: 127.0.0.1:${origin.port}\r\n\r\n`,
    );
    expect(response).toContain("200 OK");
    expect(response).toContain("forwarded");
    // The absolute-form line was rewritten to origin-form, and the upstream request asks the origin
    // to close so that libcurl opens a fresh connection — and a fresh authorization — per request.
    expect(origin.received()).toBe("GET /repository.git connection=close");
  });

  it("tunnels a CONNECT and passes bytes through untouched", async () => {
    const origin = await originServer("tunneled");
    const started = await tunnel({ allowLoopback: true });
    const port = Number(new URL(started.proxyUrl).port);
    const response = await new Promise<string>((resolve, reject) => {
      const socket = netConnect(port, "127.0.0.1");
      const chunks: Buffer[] = [];
      let established = false;
      socket.on("connect", () => {
        socket.write(`CONNECT 127.0.0.1:${origin.port} HTTP/1.1\r\nhost: 127.0.0.1:${origin.port}\r\n\r\n`);
      });
      socket.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
        if (!established && Buffer.concat(chunks).includes("\r\n\r\n")) {
          established = true;
          // The origin's own protocol begins only after the proxy's 200.
          socket.write("GET / HTTP/1.1\r\nhost: 127.0.0.1\r\nconnection: close\r\n\r\n");
        }
      });
      socket.on("error", reject);
      socket.on("close", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
    expect(response).toContain("200 Connection established");
    expect(response).toContain("tunneled");
  });

  it("refuses a target the address policy blocks", async () => {
    const started = await tunnel({
      allowLoopback: false,
      resolveAddresses: async () => ["10.0.0.5"],
    });
    const response = await exchange(
      Number(new URL(started.proxyUrl).port),
      "CONNECT example.test:443 HTTP/1.1\r\nhost: example.test:443\r\n\r\n",
    );
    expect(response).toContain("502 Bad Gateway");
  });

  it("refuses a loopback target unless the deployment opted in", async () => {
    const origin = await originServer();
    const started = await tunnel({ allowLoopback: false });
    const response = await exchange(
      Number(new URL(started.proxyUrl).port),
      `GET http://127.0.0.1:${origin.port}/x HTTP/1.1\r\nhost: 127.0.0.1:${origin.port}\r\n\r\n`,
    );
    expect(response).toContain("502 Bad Gateway");
  });

  it("refuses a request whose target is not an absolute URL", async () => {
    const started = await tunnel({ allowLoopback: true });
    const response = await exchange(
      Number(new URL(started.proxyUrl).port),
      "GET /x HTTP/1.1\r\nhost: example.test\r\n\r\n",
    );
    expect(response).toContain("502 Bad Gateway");
  });

  it("dials the address the policy approved rather than the name", async () => {
    /*
     * The name is one the resolver maps to a private address; the policy refuses it, so nothing is
     * dialed. This is the property the tunnel exists for: there is no second resolution between the
     * judgement and the connection.
     */
    const origin = await originServer();
    let dialed = false;
    const started = await tunnel({
      allowLoopback: false,
      resolveAddresses: async () => ["127.0.0.1"],
    });
    const response = await exchange(
      Number(new URL(started.proxyUrl).port),
      `GET http://localtest.me:${origin.port}/x HTTP/1.1\r\nhost: localtest.me:${origin.port}\r\n\r\n`,
    );
    dialed = response.includes("origin");
    expect(response).toContain("502 Bad Gateway");
    expect(dialed).toBe(false);
  });

  it("answers a client that never finishes its request head", async () => {
    const started = await tunnel({ allowLoopback: true });
    const port = Number(new URL(started.proxyUrl).port);
    const response = await new Promise<string>((resolve, reject) => {
      const socket = netConnect(port, "127.0.0.1");
      const chunks: Buffer[] = [];
      socket.on("connect", () => socket.write(`GET http://example.test/${"a".repeat(20 * 1024)}`));
      socket.on("data", (chunk: Buffer) => chunks.push(chunk));
      socket.on("error", reject);
      socket.on("close", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
    expect(response).toContain("502 Bad Gateway");
  });

  it("destroys the upstream socket when the client goes away", async () => {
    // A CONNECT tunnel is long-lived, so the upstream stays open while the client is alive — which is
    // what makes "the client's close reaches the upstream" observable. The peer's own side is the
    // evidence: a killed git process must not leave it connected.
    const peer = await holdServer();
    const started = await tunnel({ allowLoopback: true });
    const proxyPort = Number(new URL(started.proxyUrl).port);

    const client = netConnect(proxyPort, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
      client.on("connect", () => {
        client.write(`CONNECT 127.0.0.1:${peer.port} HTTP/1.1\r\nhost: 127.0.0.1:${peer.port}\r\n\r\n`);
      });
      client.once("data", () => resolve());
      client.once("error", reject);
    });
    await waitFor(() => peer.sockets.size === 1);
    expect(peer.sockets.size).toBe(1);

    client.destroy();
    // Both sides have to settle: the peer sees the upstream close, and the tunnel drops its own
    // bookkeeping of the client. The two happen on separate event-loop turns.
    await waitFor(() => peer.sockets.size === 0 && started.openSockets === 0);
    expect(peer.sockets.size).toBe(0);
    expect(started.openSockets).toBe(0);
  });

  it("cancels a connect that never completes, on time and on close", async () => {
    /*
     * A blackholed destination is the case a connect deadline exists for: the client's own deadline
     * (git's process timeout) kills the client, and without a deadline the pending connect would sit
     * there with nothing left to cancel it. TEST-NET-1 is public per the address policy so it is not
     * refused up front, and it does not answer.
     */
    const started = await tunnel({ allowLoopback: true, resolveAddresses: async () => ["192.0.2.1"] });
    const proxyPort = Number(new URL(started.proxyUrl).port);
    const client = netConnect(proxyPort, "127.0.0.1");
    const answer = await new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      client.on("connect", () => {
        client.write("CONNECT blackhole.test:443 HTTP/1.1\r\nhost: blackhole.test:443\r\n\r\n");
      });
      client.on("data", (chunk: Buffer) => chunks.push(chunk));
      client.on("error", reject);
      client.on("close", () => resolve(Buffer.concat(chunks).toString("utf8")));
      // The connect deadline refuses on its own, well inside this window.
      setTimeout(() => reject(new Error("the tunnel neither refused nor closed")), 12_000).unref();
    });
    // The deadline refused the attempt rather than leaving it pending.
    expect(answer).toContain("502 Bad Gateway");
    // The refused attempt left no upstream behind; the client socket goes when the client does.
    client.destroy();
    await waitFor(() => started.openSockets === 0);
    expect(started.openSockets).toBe(0);
  }, 20_000);

  it("releases every socket when it is closed", async () => {
    const origin = await originServer("origin");
    const started = await tunnel({ allowLoopback: true });
    const proxyPort = Number(new URL(started.proxyUrl).port);
    const client = netConnect(proxyPort, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
      client.on("connect", () => {
        client.write(`GET http://127.0.0.1:${origin.port}/x HTTP/1.1\r\nhost: 127.0.0.1:${origin.port}\r\n\r\n`);
      });
      client.once("data", () => resolve());
      client.once("error", reject);
    });

    await started.close();
    expect(started.openSockets).toBe(0);
    client.destroy();
  });

  it("is reachable as a plain http proxy URL", async () => {
    const started = await tunnel({ allowLoopback: true });
    expect(started.proxyUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    // Sanity: the proxy URL is usable as a request target host, which is all git needs from it.
    const port = Number(new URL(started.proxyUrl).port);
    await new Promise<void>((resolve, reject) => {
      const request = httpRequest({ host: "127.0.0.1", port, path: "/", method: "GET" }, (response) => {
        response.resume();
        response.on("end", () => resolve());
      });
      request.on("error", () => reject(new Error("the proxy did not answer")));
      request.end();
    });
  });
});
