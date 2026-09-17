import { connect, createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";

/**
 * In-sandbox loopback forwarder (native worker form of the generated `entry.mjs` forwarders): the
 * worker listens on the fixed loopback ports the proxy environment names and bridges each
 * connection to the per-execution Unix socket mounted from the trusted Runner.
 *
 * LOCAL SEAM: whether a bind-mounted Unix socket is connectable through the native Cloud Run
 * Sandbox supervisor is UNVERIFIED until the GCP acceptance run. The local harness drives the
 * worker with a proxy manifest that points directly at the trusted Runner's loopback TCP ports
 * and skips this forwarder entirely.
 */
export interface SandboxLoopbackForwarder {
  close(): Promise<void>;
}

export async function startSandboxLoopbackForwarder(input: {
  mount: string;
  endpoints: readonly { name: string; port: number }[];
}): Promise<SandboxLoopbackForwarder> {
  const sockets = new Set<Socket>();
  const servers: Server[] = [];
  try {
    for (const endpoint of input.endpoints) {
      const server = createServer((client) => {
        const upstream = connect(join(input.mount, `${endpoint.name}.sock`));
        sockets.add(client);
        sockets.add(upstream);
        const close = () => {
          client.destroy();
          upstream.destroy();
          sockets.delete(client);
          sockets.delete(upstream);
        };
        client.on("error", close);
        upstream.on("error", close);
        client.on("close", close);
        upstream.on("close", close);
        client.pipe(upstream);
        upstream.pipe(client);
      });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(endpoint.port, "127.0.0.1", resolve);
      });
      servers.push(server);
    }
  } catch (error) {
    for (const socket of [...sockets]) socket.destroy();
    await Promise.all(servers.map((server) => new Promise<void>((done) => server.close(() => done()))));
    throw error;
  }
  return {
    close: async () => {
      for (const socket of [...sockets]) socket.destroy();
      sockets.clear();
      await Promise.all(servers.map((server) => new Promise<void>((done) => server.close(() => done()))));
    },
  };
}
