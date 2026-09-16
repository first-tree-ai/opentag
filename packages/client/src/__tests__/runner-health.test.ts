import { connect } from "node:net";
import { describe, expect, it } from "vitest";
import { startRunnerHealthListener } from "../runner/health.js";

/** Real loopback TCP probe: resolves when the peer closes, rejecting on transport failure. */
function connectOnce(port: number): Promise<{ closed: boolean; bytes: number }> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port });
    let bytes = 0;
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("health connection timed out"));
    }, 5_000);
    socket.on("data", (chunk: Buffer) => {
      bytes += chunk.byteLength;
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.on("close", (hadError) => {
      clearTimeout(timer);
      resolve({ closed: !hadError, bytes });
    });
  });
}

describe("runner startup health listener", () => {
  it("accepts a real TCP connection, sends no data, and ends it immediately", async () => {
    const health = await startRunnerHealthListener({ port: 0, host: "127.0.0.1" });
    try {
      expect(health.port).toBeGreaterThan(0);
      expect(await connectOnce(health.port)).toEqual({ closed: true, bytes: 0 });
    } finally {
      await health.close();
    }
  });

  it("stops accepting connections after an idempotent close", async () => {
    const health = await startRunnerHealthListener({ port: 0, host: "127.0.0.1" });
    await health.close();
    await health.close();
    await expect(connectOnce(health.port)).rejects.toThrow();
  });

  it("rejects an invalid bind port instead of leaving a half-open listener", async () => {
    await expect(startRunnerHealthListener({ port: 70_000, host: "127.0.0.1" })).rejects.toThrow();
  });
});
