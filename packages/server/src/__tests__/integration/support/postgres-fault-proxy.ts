import { connect, createServer, type Socket } from "node:net";

export type DatabaseProxyConnection = {
  client: Socket;
  upstream: Socket;
  blockClient: boolean;
  blockServer: boolean;
  blockClose: boolean;
  clientEnded: boolean;
};

type HandshakeState = { reading: boolean; buffer: Buffer; ready: () => void };

function forwardServer(connection: DatabaseProxyConnection, state: HandshakeState, bytes: Buffer | string) {
  if (connection.blockServer) return;
  if (!state.reading) {
    connection.client.write(bytes);
    return;
  }
  state.buffer = Buffer.concat([state.buffer, Buffer.from(bytes)]);
  while (state.buffer.length >= 5) {
    const length = 1 + state.buffer.readInt32BE(1);
    if (state.buffer.length < length) return;
    const message = state.buffer.subarray(0, length);
    state.buffer = state.buffer.subarray(length);
    connection.client.write(message);
    if (message[0] === 90) {
      state.reading = false;
      connection.blockClient = connection.blockServer = true;
      state.ready();
      return;
    }
  }
}

/** Existing sessions can lose traffic and EOF while new connections remain healthy. */
export async function startDatabaseFaultProxy(target: string, freezeAfterHandshake = false) {
  const destination = new URL(target);
  let freezeNext = freezeAfterHandshake;
  let refuseNext = false;
  let ready!: () => void;
  const handshake = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const connections = new Set<DatabaseProxyConnection>();
  const server = createServer({ allowHalfOpen: true }, (client) => {
    if (refuseNext) {
      refuseNext = false;
      client.destroy();
      return;
    }
    const upstream = connect({ host: destination.hostname, port: Number(destination.port) });
    const connection: DatabaseProxyConnection = {
      client,
      upstream,
      blockClient: false,
      blockServer: false,
      blockClose: false,
      clientEnded: false,
    };
    const state: HandshakeState = { reading: freezeNext, buffer: Buffer.alloc(0), ready };
    freezeNext = false;
    connections.add(connection);
    client.on("data", (bytes) => {
      if (!connection.blockClient) upstream.write(bytes);
    });
    upstream.on("data", (bytes) => forwardServer(connection, state, bytes));
    upstream.on("end", () => {
      if (!connection.blockServer && !connection.blockClose) client.end();
    });
    upstream.on("close", () => {
      if (!connection.blockServer && !connection.blockClose) client.destroy();
    });
    client.on("end", () => {
      connection.clientEnded = true;
      if (!connection.blockClient && !connection.blockClose) {
        client.end();
        upstream.end();
      }
    });
    client.on("close", () => {
      connections.delete(connection);
      upstream.destroy();
    });
    client.on("error", () => undefined);
    upstream.on("error", () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = new URL(target);
  url.hostname = "127.0.0.1";
  url.port = String((server.address() as { port: number }).port);
  return {
    url: url.toString(),
    handshake,
    connections,
    refuseNextConnection() {
      refuseNext = true;
    },
    freeze() {
      const selected = [...connections];
      for (const connection of selected) connection.blockClient = connection.blockServer = true;
      return selected;
    },
    async close() {
      for (const connection of connections) {
        connection.client.destroy();
        connection.upstream.destroy();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
