import { createHash, timingSafeEqual } from "node:crypto";
import { chmod, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import {
  RUNTIME_MAX_FRAME_BYTES,
  type RuntimeImSteerRequest,
  RuntimeImSteerRequestSchema,
  type RuntimeImSteerResult,
} from "@opentag/shared";
import { z } from "zod";

const ControlPacketSchema = z.object({ token: z.string().uuid(), request: RuntimeImSteerRequestSchema }).strict();

export function cloudSteerSocketPath(deliveryId: string): string {
  return `/tmp/opentag-steer-${createHash("sha256").update(deliveryId).digest("hex").slice(0, 32)}.sock`;
}

export function cloudSteerResult(
  request: RuntimeImSteerRequest,
  status: RuntimeImSteerResult["status"],
  reason?: string,
): RuntimeImSteerResult {
  return {
    type: "im:steer:result",
    requestId: request.requestId,
    deliveryId: request.deliveryId,
    sessionId: request.sessionId,
    placementGeneration: request.placementGeneration,
    rootDeliveryId: request.rootDeliveryId,
    expectedTurnId: request.expectedTurnId,
    status,
    ...(reason ? { reason } : {}),
  } as RuntimeImSteerResult;
}

export async function openCloudSteerControl(input: {
  deliveryId: string;
  token: string;
  steer(request: RuntimeImSteerRequest): Promise<RuntimeImSteerResult>;
}): Promise<{ close(): Promise<void> }> {
  const path = cloudSteerSocketPath(input.deliveryId);
  await rm(path, { force: true });
  const sockets = new Set<Socket>();
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    if (sockets.size >= 4) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    socket.setTimeout(5_000, () => socket.destroy());
    const chunks: Buffer[] = [];
    let bytes = 0;
    socket.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > RUNTIME_MAX_FRAME_BYTES + 1024) socket.destroy();
      else chunks.push(chunk);
    });
    socket.once("end", () => {
      void handleControlSocket(socket, Buffer.concat(chunks), input);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
  try {
    await chmod(path, 0o600);
  } catch (error) {
    server.close();
    await rm(path, { force: true });
    throw error;
  }
  return {
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      await rm(path, { force: true });
    },
  };
}

/** Runs only inside the Sandbox; never exposes a host listener or a new credential endpoint. */
export const CLOUD_STEER_RELAY_SOURCE = `
const net = require("node:net");
const chunks = []; let bytes = 0;
process.stdin.on("data", chunk => { bytes += chunk.length; if (bytes > 66560) process.exit(2); chunks.push(chunk); });
process.stdin.on("end", () => {
  const body = Buffer.concat(chunks).toString("utf8");
  let packet;
  try { packet = JSON.parse(body); } catch { process.exit(2); }
  let connected = false, output = "", size = 0;
  const socket = net.createConnection({ path: process.argv[1], allowHalfOpen: true });
  socket.setTimeout(2000, () => { socket.destroy(); process.exit(3); });
  socket.on("connect", () => { connected = true; socket.end(body); });
  socket.on("data", chunk => { size += chunk.length; if (size > 2048) process.exit(2); output += chunk; });
  socket.on("end", () => { process.stdout.write(output); socket.destroy(); });
  socket.on("error", error => {
    if (!connected && ["ENOENT", "ECONNREFUSED"].includes(error.code)) {
      const { requestId, deliveryId, sessionId, placementGeneration, rootDeliveryId, expectedTurnId } = packet.request;
      process.stdout.write(JSON.stringify({ type: "im:steer:result", requestId, deliveryId, sessionId, placementGeneration, rootDeliveryId, expectedTurnId, status: "retry", reason: "turn_starting" }));
    } else process.exitCode = 3;
  });
});
`;

async function handleControlSocket(
  socket: Socket,
  bytes: Buffer,
  input: Parameters<typeof openCloudSteerControl>[0],
): Promise<void> {
  try {
    const value = ControlPacketSchema.parse(JSON.parse(bytes.toString("utf8")));
    const actual = Buffer.from(value.token),
      expected = Buffer.from(input.token);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return;
    if (Buffer.byteLength(JSON.stringify(value.request)) > RUNTIME_MAX_FRAME_BYTES) return;
    const result = await input.steer(value.request);
    if (!socket.destroyed) socket.end(JSON.stringify(result));
  } catch {
    socket.destroy();
  } finally {
    if (!socket.writableEnded) socket.destroy();
  }
}
