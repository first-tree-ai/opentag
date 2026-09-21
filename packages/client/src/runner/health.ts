import { createServer, type Socket } from "node:net";

/**
 * Minimal TCP liveness listener for the platform's default startup probe. The declared container
 * port only needs a listening socket, so every accepted connection is ended immediately. The
 * listener never reads, writes, or interprets data, holds no credentials, and exposes no command
 * or HTTP surface: the control channel remains the Runner's outbound authenticated WSS.
 */

export interface RunnerHealthListener {
  /** Actual bound port: `options.port`, or the OS-chosen port when 0 was requested. */
  readonly port: number;
  close(): Promise<void>;
}

export interface RunnerHealthListenerOptions {
  readonly port: number;
  /** Bind address; defaults to all interfaces so platform probes can reach it. */
  readonly host?: string;
  /** Hard cap on simultaneously accepted sockets; Node drops connections beyond it. */
  readonly maxConnections?: number;
  /** Idle socket lifetime before the socket is destroyed. */
  readonly socketTimeoutMs?: number;
  /** Post-start listener errors (for example accept pressure). Nothing secret is ever passed. */
  readonly onError?: (message: string) => void;
}

const DEFAULT_MAX_CONNECTIONS = 128;
const DEFAULT_SOCKET_TIMEOUT_MS = 5_000;

export async function startRunnerHealthListener(options: RunnerHealthListenerOptions): Promise<RunnerHealthListener> {
  const sockets = new Set<Socket>();
  const onError = options.onError ?? (() => undefined);
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.setTimeout(options.socketTimeoutMs ?? DEFAULT_SOCKET_TIMEOUT_MS, () => socket.destroy());
    socket.once("close", () => sockets.delete(socket));
    socket.once("error", () => socket.destroy());
    // Accept and immediately end the connection: the probe proves a listening socket, nothing else.
    socket.end();
  });
  server.maxConnections = options.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
  server.on("error", (error) => onError(error instanceof Error ? error.message : String(error)));
  const port = await new Promise<number>((resolve, reject) => {
    const onListenError = (error: Error) => reject(error);
    server.once("error", onListenError);
    server.listen({ port: options.port, host: options.host ?? "0.0.0.0" }, () => {
      server.off("error", onListenError);
      const address = server.address();
      if (address === null || typeof address !== "object") {
        reject(new Error("Runner health listener bound no address"));
        return;
      }
      resolve(address.port);
    });
  }).catch((error: unknown) => {
    server.close(() => undefined);
    throw error;
  });
  let closed = false;
  return {
    port,
    async close() {
      if (closed) return;
      closed = true;
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}
