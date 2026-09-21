import { once } from "node:events";
import { PROVIDER_PROXY_CHUNK_MAX_BYTES, RUNTIME_PROVIDER_PROXY_PATH } from "@opentag/shared";
import { expect, it } from "vitest";
import WebSocket from "ws";
import { createApp } from "../app.js";
import type { RuntimeProviderProxyTransport } from "../runtime-credentials/data-transport.js";
import type { UserAuthService } from "../services/auth/index.js";
import type { ComputerService, MachineAuthService } from "../services/computers/index.js";

it("mounts the production proxy endpoint with enough WebSocket capacity for a full binary chunk", async () => {
  const app = createApp({
    loggerLevel: "silent",
    authService: {} as UserAuthService,
    computerService: {} as ComputerService,
    machineAuthService: {} as MachineAuthService,
    runtimeProviderProxy: {
      transport: {
        attach(socket: WebSocket) {
          socket.on("message", (data, binary) =>
            socket.send(JSON.stringify({ length: Buffer.byteLength(data as Buffer), binary })),
          );
        },
      } as RuntimeProviderProxyTransport,
    },
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("Missing server address");
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}${RUNTIME_PROVIDER_PROXY_PATH}`);
  try {
    await once(socket, "open");
    const received = once(socket, "message");
    socket.send(Buffer.alloc(PROVIDER_PROXY_CHUNK_MAX_BYTES + 4));
    const [response] = await received;
    expect(JSON.parse(response.toString())).toEqual({ length: PROVIDER_PROXY_CHUNK_MAX_BYTES + 4, binary: true });
  } finally {
    socket.terminate();
    await app.close();
  }
});
