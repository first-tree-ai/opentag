import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CloudJournal } from "../../runner/cloud-journal.ts";
import { CloudTurnRunner } from "../../runner/cloud-turns.ts";

const { directory, delivery, scope, phase, verified } = JSON.parse(readFileSync(0, "utf8"));
const journal = await CloudJournal.open(join(directory, "journal"));
const runner = new CloudTurnRunner({
  credentialChannel: () => {
    throw new Error("Unexpected credential access in synthetic crash fixture");
  },
  journal,
  openExecution: async () => ({ close: async () => {}, executionDir: directory }),
  runWorker: async () => {
    if (phase === "started") {
      process.send({ boundary: "started", deliveryId: delivery.deliveryId });
      return new Promise(() => {});
    }
    return {
      code: 0,
      stderr: "",
      stdout: `${JSON.stringify({
        kind: "result",
        completion: { outcome: "completed", executionEffects: "completed", finalText: "synthetic completion" },
      })}\n`,
    };
  },
  sandbox: {
    name: "synthetic-crash-fixture",
    exec: async () => {
      throw new Error("Unexpected native execution in synthetic crash fixture");
    },
    openDuplex: () => {
      throw new Error("Unexpected native duplex in synthetic crash fixture");
    },
  },
  scope: () => scope,
  send: (frame) => {
    if (phase === "received" && frame.type === "delivery:received") {
      process.send({ boundary: "received", deliveryId: delivery.deliveryId });
    }
    if (phase === "reported" && frame.type === "delivery:report") {
      process.send({ boundary: "reported", report: frame.report });
    }
  },
  serverUrl: "https://server.example.test",
  stateDirectory: directory,
});

setInterval(() => {}, 1_000);
await runner.handleDeliveryRun({ type: "delivery:run", requestId: delivery.requestId, delivery });
if (phase !== "received") await runner.handleVerified(verified);
