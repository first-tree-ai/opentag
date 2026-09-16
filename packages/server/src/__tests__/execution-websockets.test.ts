import { HTTP_PATHS, RUNNER_WS_CLOSE, RUNTIME_MAX_FRAME_BYTES } from "@opentag/shared";
import Fastify from "fastify";
import { expect, it } from "vitest";
import WebSocket from "ws";
import { registerExecutionWebSocketRoutes } from "../api/execution-websockets.js";
import { RunnerBootstrapTokenService } from "../services/sandboxes/runner-bootstrap-token.js";
import { RunnerHub } from "../services/sandboxes/runner-hub.js";

function exchange(address: string, path: string, payload: string): Promise<{ code: number; frames: unknown[] }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(address.replace("http:", "ws:") + path);
    const frames: unknown[] = [];
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error("Socket did not close"));
    }, 3_000);
    socket.on("open", () => socket.send(payload));
    socket.on("message", (data) => frames.push(JSON.parse(String(data))));
    socket.on("error", reject);
    socket.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, frames });
    });
  });
}

it("Local Computer and Cloud Runner share one upgrade listener but retain separate protocol bounds", async () => {
  const app = Fastify();
  registerExecutionWebSocketRoutes(app, {
    computerService: {} as never,
    machineAuthService: {} as never,
    sandboxRunnerService: {} as never,
    runnerChannel: {
      tokens: new RunnerBootstrapTokenService("test-only-bootstrap-key-with-32-characters"),
      hub: new RunnerHub(),
    },
  });
  try {
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    expect(app.server.listenerCount("upgrade")).toBe(1);
    const padding = " ".repeat(RUNTIME_MAX_FRAME_BYTES);
    const [local, cloud] = await Promise.all([
      exchange(address, HTTP_PATHS.computerRuntimeWebSocket, `${padding}{}`),
      exchange(address, HTTP_PATHS.sandboxRunnerWebSocket, `${padding}{"type":"auth","token":"invalid"}`),
    ]);
    expect(local.frames).toContainEqual(
      expect.objectContaining({ type: "error", code: "PROTOCOL_ERROR", message: "The runtime frame is too large" }),
    );
    expect(cloud.frames).toContainEqual(expect.objectContaining({ type: "auth:result", ok: false }));
    expect(cloud.code).toBe(RUNNER_WS_CLOSE.authFailed);
  } finally {
    await app.close();
  }
});
