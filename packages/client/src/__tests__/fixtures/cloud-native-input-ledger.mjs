import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RunnerCloudTurnWorkerRequestSchema } from "@opentag/shared";
import { PiAgentRuntimeFactory } from "../../providers/pi/agent-runtime.ts";
import { PiRpcProcess } from "../../providers/pi/rpc-wire.ts";
import { CloudJournal } from "../../runner/cloud-journal.ts";
import { CloudTurnRunner } from "../../runner/cloud-turns.ts";
import { buildAgentInput } from "../../runtime/agent-turn-runner.ts";

const cli = join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "cli.js");
let runner;
let runtime;
let rootDelivery;
let runId;
let held;
let endpoint;
let nativeEvents = 0;
const expectedInputs = [];
const emit = (message) => process.send(message);
const textOf = (items) =>
  typeof items === "string"
    ? items
    : items
        .filter((item) => item.type === "text")
        .map((item) => item.text)
        .join("\n");

function reply(response) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const choice of [
    { delta: { role: "assistant", content: "synthetic answer" }, finish_reason: null },
    { delta: {}, finish_reason: "stop" },
  ])
    response.write(
      `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "mock", choices: [{ index: 0, ...choice }] })}\n\n`,
    );
  response.end("data: [DONE]\n\n");
}
function observe(event) {
  if (event.type !== "message_start" || event.message?.role !== "user") return;
  const expected = expectedInputs.shift();
  assert(expected, "Native Pi consumed an input without a matching dispatch/steer");
  const text = textOf(event.message.content);
  assert.equal(text, expected.text);
  nativeEvents += 1;
  emit({
    kind: "native_input",
    agentId: expected.request.agentId,
    sessionId: expected.request.sessionId,
    deliveryId: expected.request.deliveryId,
    requestId: expected.request.requestId,
    textHash: createHash("sha256").update(text).digest("hex"),
    nativeEvents,
    markers: [...text.matchAll(/SYNTHETIC_[AB]_INPUT_\d{4}/g)].map((match) => match[0]),
  });
}
function inputFor(request) {
  const input = buildAgentInput(request, undefined, rootDelivery.runtime);
  expectedInputs.push({ request, text: textOf(input.items) });
  return input;
}
async function openRuntime(directory, delivery) {
  const piHome = join(directory, "pi-home");
  const sessionDirectory = join(directory, "pi-sessions");
  for (const path of [piHome, sessionDirectory]) await mkdir(path, { recursive: true });
  endpoint = createServer(async (request, response) => {
    for await (const _chunk of request) {
    }
    if (!held) {
      held = response;
      emit({ kind: "model_ready" });
    } else reply(response);
  });
  await new Promise((done) => endpoint.listen(0, "127.0.0.1", done));
  await writeFile(
    join(piHome, "models.json"),
    JSON.stringify({
      providers: {
        fixture: {
          api: "openai-completions",
          baseUrl: `http://127.0.0.1:${endpoint.address().port}/v1`,
          models: [{ id: "mock", name: "mock", contextWindow: 128000, maxTokens: 2048 }],
        },
      },
    }),
  );
  await writeFile(join(piHome, "auth.json"), JSON.stringify({ fixture: { type: "api_key", key: "synthetic-only" } }));
  const factory = new PiAgentRuntimeFactory({
    process: { sessionDirectory },
    createClient: (cwd, args, extra) => {
      const raw = new PiRpcProcess({
        command: process.execPath,
        args: [cli, ...args],
        cwd,
        env: {
          PATH: process.env.PATH,
          PI_CODING_AGENT_DIR: piHome,
          PI_OFFLINE: "1",
          PI_SKIP_VERSION_CHECK: "1",
          ...extra,
        },
        requestTimeoutMs: 10000,
      });
      return {
        request: (...args) => raw.request(...args),
        close: (...args) => raw.close(...args),
        subscribe: (listener) =>
          raw.subscribe((event) => {
            observe(event);
            listener(event);
          }),
      };
    },
  });
  return factory.create({
    workspace: { cwd: directory },
    systemPrompt: `Synthetic input test for Agent ${delivery.agentId}, OpenTag Session ${delivery.sessionId}.`,
    configuration: { model: "fixture/mock" },
    policy: { approvals: "never", fileSystem: "unrestricted", network: "enabled", tools: { mode: "provider-default" } },
    eventSink: () => {},
  });
}
async function initialize({ directory, scope }) {
  const journal = await CloudJournal.open(join(directory, "journal"));
  runner = new CloudTurnRunner({
    journal,
    stateDirectory: directory,
    scope: () => scope,
    serverUrl: "https://server.example.test",
    credentialChannel: () => {
      throw new Error("Unexpected credential access in native ledger fixture");
    },
    openExecution: async () => ({ executionDir: directory, close: async () => {} }),
    steeringEnabled: () => true,
    sandbox: {
      name: "synthetic-ledger",
      exec: async () => {
        throw new Error("Unexpected native Sandbox execution");
      },
      openDuplex: () => {
        throw new Error("Unexpected native Sandbox duplex");
      },
    },
    send: (frame) => emit({ kind: "frame", frame }),
    runWorker: async ({ stdin }, signal) => {
      const worker = RunnerCloudTurnWorkerRequestSchema.parse(JSON.parse(stdin));
      assert(worker.steering, "Native input ledger requires a negotiated steer channel");
      rootDelivery = worker.delivery;
      runId = worker.steering.turnId;
      runtime = await openRuntime(directory, rootDelivery);
      const result = await runtime.prompt({ runId, input: inputFor(rootDelivery), signal });
      assert.equal(result.status, "completed", JSON.stringify(result));
      await runtime.close();
      runtime = undefined;
      endpoint.closeAllConnections();
      await new Promise((done) => endpoint.close(done));
      return {
        code: 0,
        stderr: "",
        stdout: `${JSON.stringify({ kind: "result", completion: { outcome: "completed", executionEffects: "completed" } })}\n`,
      };
    },
    steerWorker: async ({ request }) => {
      assert(runtime, "Steer arrived before the native Runtime was ready");
      await runtime.steer({ expectedRunId: runId, input: inputFor(request) });
      return {
        type: "im:steer:result",
        requestId: request.requestId,
        deliveryId: request.deliveryId,
        sessionId: request.sessionId,
        placementGeneration: request.placementGeneration,
        rootDeliveryId: request.rootDeliveryId,
        expectedTurnId: request.expectedTurnId,
        status: "steered",
      };
    },
  });
  emit({ kind: "ready" });
  return journal;
}
let journal;
let tail = Promise.resolve();
function handleFrame(frame) {
  switch (frame.type) {
    case "delivery:run":
      return runner.handleDeliveryRun(frame);
    case "delivery:verified":
      return runner.handleVerified(frame);
    case "delivery:steer":
      return runner.handleSteer(frame);
    case "delivery:steer:ack":
      return runner.handleSteerAck(frame);
    case "delivery:report:ack":
      return runner.handleReportAck(frame);
    default:
      throw new Error(`Unexpected frame ${frame.type}`);
  }
}
async function handleCommand(message) {
  switch (message.kind) {
    case "init":
      journal = await initialize(message);
      return;
    case "frame":
      await handleFrame(message.frame);
      return;
    case "reconcile":
      await runner.reconcile();
      return;
    case "release":
      assert(held);
      reply(held);
      return;
    case "inspect":
      emit({ kind: "journal", entries: await journal.list(), nativeEvents });
      return;
    case "close":
      await runner.close();
      await runtime?.close();
      endpoint?.closeAllConnections();
      process.exit(0);
      return;
    default:
      throw new Error(`Unexpected fixture command ${message.kind}`);
  }
}
process.on("message", (message) => {
  tail = tail.then(() => handleCommand(message)).catch((error) => emit({ kind: "error", message: String(error) }));
});
