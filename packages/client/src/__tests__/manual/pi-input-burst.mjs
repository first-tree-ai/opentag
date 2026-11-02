import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PiAgentRuntimeFactory, PiRpcProcess } from "@opentag/client";
import { verifyInputLedger } from "../../../../../scripts/verify-im-input-ledger.mjs";

const evidence = process.argv[2] ? resolve(process.argv[2]) : undefined;
const cli = join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "cli.js");
const root = await mkdtemp(join(tmpdir(), "opentag-native-input-burst-"));
const signal = AbortSignal.timeout(45_000);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
async function bounded(promise) {
  signal.throwIfAborted();
  let onAbort;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        onAbort = () => reject(new Error("Synthetic Pi input burst timed out"));
        signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
function reply(response) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const choice of [
    { delta: { role: "assistant", content: "synthetic answer" }, finish_reason: null },
    { delta: {}, finish_reason: "stop" },
  ]) {
    response.write(
      `data: ${JSON.stringify({ id: "synthetic", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, ...choice }] })}\n\n`,
    );
  }
  response.end("data: [DONE]\n\n");
}
async function scenario(nativeResources, modelFailure) {
  const name = `${nativeResources ? "native-resources" : "resources-disabled"}${modelFailure ? "-model401" : ""}`;
  const workspace = join(root, name);
  const piHome = join(workspace, "pi");
  const sessionDirectory = join(workspace, "sessions");
  for (const path of [workspace, piHome, sessionDirectory]) await mkdir(path, { recursive: true });
  const firstRequest = deferred();
  let held;
  let modelRequests = 0;
  let endpointError;
  const nativeInputs = [];
  const acceptedEvents = [];
  const commands = [];
  const endpoint = createServer(async (request, response) => {
    try {
      assert.equal(request.url, "/v1/chat/completions");
      for await (const _chunk of request) {
      }
      modelRequests += 1;
      if (!held) {
        held = response;
        firstRequest.resolve();
      } else if (modelFailure) {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ error: { message: "synthetic model authorization failure", type: "authentication_error" } }),
        );
      } else reply(response);
    } catch (error) {
      endpointError = error;
      response.writeHead(500).end();
    }
  });
  let runtime;
  try {
    await new Promise((done) => endpoint.listen(0, "127.0.0.1", done));
    await writeFile(
      join(piHome, "models.json"),
      JSON.stringify({
        providers: {
          fixture: {
            api: "openai-completions",
            baseUrl: `http://127.0.0.1:${endpoint.address().port}/v1`,
            models: [{ id: "mock", name: "mock", contextWindow: 128_000, maxTokens: 2_048 }],
          },
        },
      }),
    );
    await writeFile(join(piHome, "auth.json"), JSON.stringify({ fixture: { type: "api_key", key: "synthetic-only" } }));
    const environment = {
      PATH: process.env.PATH,
      PI_CODING_AGENT_DIR: piHome,
      PI_OFFLINE: "1",
      PI_SKIP_VERSION_CHECK: "1",
    };
    const factory = new PiAgentRuntimeFactory({
      nativeResources,
      process: { sessionDirectory },
      createClient: (cwd, args, extra) => {
        const raw = new PiRpcProcess({
          command: process.execPath,
          args: [cli, ...args],
          cwd,
          env: { ...environment, ...extra },
          requestTimeoutMs: 10_000,
        });
        return {
          subscribe(listener) {
            return raw.subscribe((event) => {
              if (event.type === "message_start" && event.message?.role === "user") nativeInputs.push(event.message);
              listener(event);
            });
          },
          request(command, ...rest) {
            commands.push(command.type);
            return raw.request(command, ...rest);
          },
          close(...args) {
            return raw.close(...args);
          },
        };
      },
    });
    runtime = await factory.create({
      workspace: { cwd: workspace },
      systemPrompt: "Synthetic input-delivery test; answer only.",
      configuration: { model: "fixture/mock" },
      policy: {
        approvals: "never",
        fileSystem: "unrestricted",
        network: "enabled",
        tools: { mode: "provider-default" },
      },
      eventSink: (event) => {
        if (event.type === "input_accepted") acceptedEvents.push(event);
      },
    });
    const inputs = Array.from({ length: 65 }, (_, i) => `SYNTHETIC_INPUT_${String(i + 1).padStart(4, "0")}`);
    const agentInput = (text) => ({ items: [{ type: "text", text }] });
    const run = runtime.prompt({ runId: "burst", input: agentInput(inputs[0]), signal });
    await bounded(
      Promise.race([
        firstRequest.promise,
        run.then((result) => {
          throw new Error(`Pi settled before the first model request: ${JSON.stringify(result)}`);
        }),
      ]),
    );
    const steers = await bounded(
      Promise.all(inputs.slice(1).map((text) => runtime.steer({ expectedRunId: "burst", input: agentInput(text) }))),
    );
    assert.equal(steers.length, 64);
    assert.equal(acceptedEvents.length, 64);
    reply(held);
    const result = await bounded(run);
    assert.equal(result.status, modelFailure ? "failed" : "completed", JSON.stringify(result));
    assert.equal(endpointError, undefined);
    const observed = nativeInputs.flatMap((message) => {
      const text =
        typeof message.content === "string"
          ? message.content
          : message.content
              .filter((item) => item.type === "text")
              .map((item) => item.text)
              .join("\n");
      return [...text.matchAll(/SYNTHETIC_INPUT_\d{4}/g)].map((match) => match[0]);
    });
    const identity = (text, order) => ({
      inputId: text,
      agentId: "synthetic-agent",
      sessionId: nativeResources ? "local-pi-session" : "cloud-pi-session",
      streamId: "synthetic-sender-stream",
      contentHash: hash(text),
      order,
    });
    const ledger = {
      environment: "synthetic",
      orderingBasis: "monotonic sender ordinal before 64 concurrent steer calls; every call must ACK",
      accepted: inputs.map((text, order) => identity(text, order)),
      received: observed.map((text) => ({ ...identity(text, inputs.indexOf(text)), boundary: "provider_input" })),
    };
    const verification = verifyInputLedger(ledger);
    const summary = {
      nativeResources,
      modelFailure,
      nativeSessionId: runtime.binding?.payload?.sessionId,
      inputs: inputs.length,
      steerAcks: acceptedEvents.length,
      nativeUserEvents: nativeInputs.length,
      modelRequests,
      commands: Object.fromEntries(
        [...new Set(commands)].map((command) => [command, commands.filter((value) => value === command).length]),
      ),
      result: result.status,
      inputReceiptVerification: verification,
    };
    if (evidence) {
      await mkdir(evidence, { recursive: true });
      await writeFile(join(evidence, `native-pi-burst-${name}-ledger.json`), `${JSON.stringify(ledger, null, 2)}\n`);
      await writeFile(join(evidence, `native-pi-burst-${name}-summary.json`), `${JSON.stringify(summary, null, 2)}\n`);
    }
    console.log(JSON.stringify(summary));
    assert.equal(verification.ok, true, JSON.stringify(verification));
  } finally {
    await runtime?.close();
    endpoint.closeAllConnections();
    await new Promise((done) => endpoint.close(done));
  }
}
try {
  await scenario(false, false);
  await scenario(true, false);
  await scenario(false, true);
  await scenario(true, true);
} finally {
  await rm(root, { recursive: true, force: true });
}
