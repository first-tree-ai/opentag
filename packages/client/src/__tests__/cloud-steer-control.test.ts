import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { createConnection } from "node:net";
import type { RuntimeImSteerRequest } from "@opentag/shared";
import { expect, it } from "vitest";
import {
  CLOUD_STEER_RELAY_SOURCE,
  cloudSteerResult,
  cloudSteerSocketPath,
  openCloudSteerControl,
} from "../runner/cloud-steer-control.js";
import { cloudDeliveryFixture } from "./cloud-turns.fixture.js";

function steerFixture(): RuntimeImSteerRequest {
  const root = cloudDeliveryFixture();
  const { runtime: _, ...request } = root;
  return {
    ...request,
    type: "im:steer",
    deliveryId: randomUUID(),
    imMessageId: randomUUID(),
    rootDeliveryId: root.deliveryId,
    expectedTurnId: randomUUID(),
  };
}

it("authenticates the local control socket and preserves split UTF-8 input", async () => {
  const request = steerFixture();
  request.content.text = "中文输入".repeat(500);
  const token = randomUUID();
  const received: RuntimeImSteerRequest[] = [];
  const control = await openCloudSteerControl({
    deliveryId: request.rootDeliveryId,
    token,
    steer: async (value) => {
      received.push(value);
      return cloudSteerResult(value, "steered");
    },
  });
  const path = cloudSteerSocketPath(request.rootDeliveryId);
  try {
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const exchange = (credential: string) =>
      new Promise<string>((resolve, reject) => {
        const socket = createConnection({ path, allowHalfOpen: true });
        let result = "";
        socket
          .on("error", reject)
          .on("data", (chunk) => {
            result += chunk;
          })
          .on("end", () => {
            socket.destroy();
            resolve(result);
          });
        socket.on("close", () => resolve(result));
        socket.on("connect", () => {
          for (const byte of Buffer.from(JSON.stringify({ token: credential, request })))
            socket.write(Buffer.from([byte]));
          socket.end();
        });
      });
    expect(await exchange(randomUUID())).toBe("");
    expect(received).toHaveLength(0);
    expect(JSON.parse(await exchange(token))).toMatchObject({ status: "steered" });
    expect(received).toEqual([request]);
    const result = await new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, ["-e", CLOUD_STEER_RELAY_SOURCE, path]);
      let output = "";
      child.stdout.on("data", (chunk) => {
        output += chunk;
      });
      child
        .on("error", reject)
        .on("close", (code) => (code === 0 ? resolve(output) : reject(new Error(`relay ${code}`))));
      child.stdin.end(JSON.stringify({ token, request }));
    });
    expect(JSON.parse(result)).toMatchObject({ status: "steered" });
  } finally {
    await control.close();
  }
  await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
});

it("returns a known no-effect result when the worker socket has not opened", async () => {
  const request = steerFixture();
  const result = await new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, [
      "-e",
      CLOUD_STEER_RELAY_SOURCE,
      cloudSteerSocketPath(request.rootDeliveryId),
    ]);
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child
      .on("error", reject)
      .on("close", (code) => (code === 0 ? resolve(output) : reject(new Error(`relay ${code}`))));
    child.stdin.end(JSON.stringify({ token: randomUUID(), request }));
  });
  expect(JSON.parse(result)).toMatchObject({ status: "retry", reason: "turn_starting" });
});
