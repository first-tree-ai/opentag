import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RunnerClientFrame, RunnerCloudDeliveryVerifiedFrame } from "@opentag/shared";
import { describe, expect, it } from "vitest";
import { CloudJournal } from "../runner/cloud-journal.js";
import { CloudTurnRunner, type CloudTurnScope } from "../runner/cloud-turns.js";
import { cloudDeliveryFixture } from "./cloud-turns.fixture.js";

const fixture = fileURLToPath(new URL("./fixtures/cloud-turn-crash.mjs", import.meta.url));

describe.skipIf(process.platform === "win32")("Cloud Turn recovery after process death", () => {
  it.each(["received", "started", "reported"] as const)(
    "recovers the exact %s boundary after SIGKILL without inventing completion or replaying uncertain work",
    async (phase) => {
      const directory = await mkdtemp(join(tmpdir(), "opentag-turn-crash-"));
      const delivery = cloudDeliveryFixture();
      const scope: CloudTurnScope = {
        sandboxId: randomUUID(),
        sessionId: delivery.sessionId,
        environmentGeneration: 1,
        resourceName: "projects/p/locations/r/instances/ots-crash-test-1",
        resourceUid: "synthetic-uid",
      };
      const verified: RunnerCloudDeliveryVerifiedFrame = {
        type: "delivery:verified",
        requestId: delivery.requestId,
        status: "verified",
        model: {
          baseUrl: "https://server.example.test/api/v1/cloud-model",
          model: delivery.runtime.model ?? "synthetic-model",
          token: "synthetic-execution-token-0123456789",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          contextWindow: 64_000,
          maxTokens: 8_192,
        },
      };
      const child = spawn(process.execPath, ["--import", "tsx", fixture], {
        stdio: ["pipe", "ignore", "pipe", "ipc"],
      });
      let stderr = "";
      child.stderr?.on("data", (chunk) => {
        stderr = (stderr + chunk.toString()).slice(-4_096);
      });
      const exited = new Promise<{ signal: NodeJS.Signals | null }>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (_code, signal) => resolve({ signal }));
      });
      let recovered: CloudTurnRunner | undefined;
      try {
        const boundary = new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`Crash fixture boundary timed out: ${stderr}`)), 10_000);
          child.once("message", (message) => {
            clearTimeout(timer);
            if ((message as { boundary?: string }).boundary === phase) resolve();
            else reject(new Error("Unexpected crash fixture boundary"));
          });
          child.once("error", (error) => {
            clearTimeout(timer);
            reject(error);
          });
          child.once("exit", () => {
            clearTimeout(timer);
            reject(new Error(`Crash fixture exited before boundary: ${stderr}`));
          });
        });
        child.stdin?.end(JSON.stringify({ directory, delivery, scope, phase, verified }));
        await boundary;
        expect(child.kill("SIGKILL")).toBe(true);
        expect((await exited).signal).toBe("SIGKILL");

        const journal = await CloudJournal.open(join(directory, "journal"));
        const [persisted] = await journal.list();
        expect(persisted).toMatchObject({ phase, deliveryId: delivery.deliveryId, scope });
        const frames: RunnerClientFrame[] = [];
        let workerCalls = 0;
        recovered = new CloudTurnRunner({
          credentialChannel: () => {
            throw new Error("Unexpected credential access in recovery test");
          },
          journal,
          openExecution: async () => ({ close: async () => {}, executionDir: directory }),
          runWorker: async () => {
            workerCalls += 1;
            return {
              code: 0,
              stderr: "",
              stdout: `${JSON.stringify({
                kind: "result",
                completion: { outcome: "completed", executionEffects: "completed" },
              })}\n`,
            };
          },
          sandbox: {
            name: "synthetic-crash-fixture",
            exec: async () => {
              throw new Error("Unexpected native execution in recovery test");
            },
            openDuplex: () => {
              throw new Error("Unexpected native duplex in recovery test");
            },
          },
          scope: () => scope,
          send: (frame) => frames.push(frame),
          serverUrl: "https://server.example.test",
          stateDirectory: directory,
        });
        await recovered.reconcile();
        expect(workerCalls).toBe(0);
        if (phase === "received") {
          expect(frames).toContainEqual(
            expect.objectContaining({ type: "delivery:received", deliveryId: delivery.deliveryId }),
          );
          expect(frames.some((frame) => frame.type === "delivery:report")).toBe(false);
          await recovered.handleDeliveryRun({ type: "delivery:run", requestId: delivery.requestId, delivery });
          await recovered.handleVerified(verified);
          await recovered.handleVerified(verified);
          await recovered.waitForActive();
          expect(workerCalls).toBe(1);
          const reports = frames.filter((frame) => frame.type === "delivery:report");
          expect(reports).toHaveLength(1);
          expect(reports[0]?.report).toMatchObject({
            deliveryId: delivery.deliveryId,
            sessionId: delivery.sessionId,
            agentId: delivery.agentId,
            outcome: "completed",
          });
        } else {
          await recovered.reconcile();
          const reports = frames.filter((frame) => frame.type === "delivery:report");
          expect(reports).toHaveLength(2);
          expect(reports[0]?.report).toEqual(reports[1]?.report);
          expect(reports[0]?.report).toMatchObject({
            deliveryId: delivery.deliveryId,
            outcome: phase === "started" ? "unknown" : "completed",
          });
          expect(workerCalls).toBe(0);
        }
      } finally {
        child.kill("SIGKILL");
        await exited;
        await recovered?.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
    15_000,
  );
});
