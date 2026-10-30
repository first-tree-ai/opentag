import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PiAgentRuntimeFactory, PiRpcProcess } from "@opentag/client";

const cli = join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "cli.js");
const root = await mkdtemp(join(tmpdir(), "otpi-lifecycle-"));
const cwd = join(root, "project");
const piHome = join(root, "pi");
const sessionDirectory = join(root, "sessions");
const trigger = join(root, "trigger");
const commandLog = join(root, "consumed");
const models = [];
const records = [];
let phase = "seed";
let runtime;
let fixtureError;
let heldResponse;
let modelReady;
let signal = AbortSignal.timeout(30000);
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
        onAbort = () => reject(new Error("Pi native lifecycle fixture deadline"));
        signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
function reply(response) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  const text = phase === "startup" ? "native startup output" : "owned model output";
  for (const choice of [
    { delta: { role: "assistant", content: text }, finish_reason: null },
    { delta: {}, finish_reason: "stop" },
  ]) {
    response.write(
      `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "mock", choices: [{ index: 0, ...choice }] })}\n\n`,
    );
  }
  response.end("data: [DONE]\n\n");
}
const model = createServer(async (request, response) => {
  try {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    models.push({ phase, body: JSON.parse(Buffer.concat(chunks).toString()) });
    if (phase === "active-steer" && !heldResponse) {
      heldResponse = response;
      modelReady.resolve();
    } else reply(response);
  } catch (error) {
    fixtureError = error;
    response.writeHead(500).end();
  }
});
const environment = {
  HOME: root,
  PATH: process.env.PATH,
  PI_CODING_AGENT_DIR: piHome,
  PI_OFFLINE: "1",
  PI_SKIP_VERSION_CHECK: "1",
};
const input = (text) => ({ items: [{ type: "text", text }] });
const common = (events) => ({
  eventSink: (event) => {
    events.push(event);
  },
  workspace: { cwd },
  systemPrompt: "fixture",
  configuration: { model: "fixture/mock" },
  policy: { approvals: "never", fileSystem: "unrestricted", network: "enabled", tools: { mode: "provider-default" } },
});
const processOptions = { command: process.execPath, args: [cli], env: environment, sessionDirectory };
try {
  for (const path of [cwd, piHome, sessionDirectory, join(cwd, ".pi/extensions")])
    await mkdir(path, { recursive: true });
  await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
  await writeFile(
    join(piHome, "models.json"),
    JSON.stringify({
      providers: {
        fixture: {
          api: "openai-completions",
          baseUrl: `http://127.0.0.1:${model.address().port}/v1`,
          models: [{ id: "mock", name: "mock", contextWindow: 128000, maxTokens: 2048 }],
        },
      },
    }),
  );
  await writeFile(join(piHome, "auth.json"), JSON.stringify({ fixture: { type: "api_key", key: "fixture" } }));
  runtime = await new PiAgentRuntimeFactory({ nativeResources: true, process: processOptions }).create(common([]));
  assert.equal((await runtime.prompt({ runId: "seed", input: input("seed"), signal })).status, "completed");
  const binding = runtime.binding;
  await runtime.close();
  runtime = undefined;
  await writeFile(
    join(cwd, ".pi/extensions/fixture.ts"),
    `
    import { existsSync, writeFileSync } from "node:fs";
    import { setTimeout as delay } from "node:timers/promises";
    export default function(pi) {
      pi.registerCommand("consume-requested", { description: "Consume", handler: async () => writeFileSync(${JSON.stringify(commandLog)}, "consumed") });
      pi.on("session_start", () => {
        if (process.env.REVIEW_PHASE !== "startup") return;
        void (async () => {
          while (!existsSync(${JSON.stringify(trigger)})) await delay(5);
          pi.sendMessage({ customType: "startup", content: "startup trigger", display: true }, { triggerTurn: true });
        })();
      });
      pi.on("before_agent_start", (_event, ctx) => {
        if (process.env.REVIEW_PHASE !== "ui") return;
        ctx.ui.setEditorText("native editor text"); ctx.ui.pasteToEditor("native pasted text");
      });
    }
  `,
  );
  for (phase of ["startup", "steer", "active-steer", "ui"]) {
    signal = AbortSignal.timeout(30000);
    const events = [],
      wire = [],
      commands = [];
    const startupDone = deferred(),
      stopped = deferred(),
      rawAck = deferred(),
      releaseAck = deferred(),
      stateCaptured = deferred(),
      releaseFence = deferred();
    modelReady = deferred();
    let first = true;
    let nativeState;
    const factory = new PiAgentRuntimeFactory({
      nativeResources: true,
      process: processOptions,
      createClient: (_cwd, args, extra) => {
        const raw = new PiRpcProcess({
          command: process.execPath,
          args: [cli, ...args],
          cwd,
          env: { ...environment, REVIEW_PHASE: phase, ...extra },
          requestTimeoutMs: 10000,
        });
        return {
          subscribe(listener) {
            return raw.subscribe((event) => {
              wire.push(event);
              listener(event);
              if (event.type === "agent_settled") startupDone.resolve();
            });
          },
          async request(command, requestSignal, options) {
            commands.push(command);
            if (command.type === "get_state" && first) {
              first = false;
              const data = await raw.request(command, requestSignal, options);
              if (phase === "startup") {
                await writeFile(trigger, "go");
                await bounded(Promise.race([startupDone.promise, stopped.promise]));
              }
              return data;
            }
            if (command.type === "prompt") {
              const data = await raw.request(command, requestSignal, options);
              rawAck.resolve();
              if (phase === "steer") await bounded(releaseAck.promise);
              return data;
            }
            if (command.type === "get_state" && phase === "steer") {
              nativeState = await raw.request(command, requestSignal, options);
              stateCaptured.resolve();
              await bounded(releaseFence.promise);
              return nativeState;
            }
            return raw.request(command, requestSignal, options);
          },
          close(...args) {
            stopped.resolve();
            return raw.close(...args);
          },
        };
      },
    });
    runtime = await factory.resume({ ...common(events), binding });
    const count = models.length;
    const run = runtime.prompt({
      runId: `requested-${phase}`,
      input: input(["startup", "steer"].includes(phase) ? "/consume-requested" : "use native model"),
      signal,
    });
    let steer;
    if (phase === "steer") {
      await bounded(rawAck.promise);
      let settled = false;
      const pending = runtime
        .steer({ expectedRunId: `requested-${phase}`, input: input("important follow-up") })
        .then(
          () => ({ accepted: true }),
          (error) => ({ accepted: false, code: error.code }),
        )
        .finally(() => {
          settled = true;
        });
      releaseAck.resolve();
      await bounded(stateCaptured.promise);
      assert.equal(settled, false);
      assert.equal(
        commands.some((command) => command.type === "steer"),
        false,
      );
      releaseFence.resolve();
      steer = await pending;
      assert.equal(steer.accepted, false);
      assert.equal(steer.code, "provider_request_rejected");
      assert.equal(
        events.some((event) => event.type === "input_accepted"),
        false,
      );
      assert.equal(nativeState.pendingMessageCount, 0);
      assert.equal(models.length, count);
    }
    if (phase === "active-steer") {
      await bounded(modelReady.promise);
      await runtime.steer({ expectedRunId: `requested-${phase}`, input: input("important follow-up") });
      assert.equal(
        events.some((event) => event.type === "input_accepted"),
        true,
      );
      reply(heldResponse);
    }
    const result = await run;
    if (phase === "startup") {
      assert.equal(result.status, "failed", JSON.stringify(result));
      assert.match(result.error.message, /before the requested prompt/);
      assert.equal(
        commands.some((command) => command.type === "prompt"),
        false,
      );
      assert.equal(
        events.some((event) => event.type === "message_completed" || event.type === "run_completed"),
        false,
      );
    } else if (phase === "steer") {
      assert.equal(result.status, "failed");
      assert.equal(result.error.code, "provider_request_rejected");
      assert.equal(await readFile(commandLog, "utf8"), "consumed");
    } else {
      assert.equal(result.status, "completed", JSON.stringify(result));
      if (phase === "ui")
        for (const text of ["native editor text", "native pasted text"])
          assert(wire.some((event) => event.method === "set_editor_text" && event.text === text));
      if (phase === "active-steer") assert.match(JSON.stringify(models.at(-1).body.messages), /important follow-up/);
    }
    records.push({
      phase,
      result: result.status,
      code: result.error?.code,
      steer,
      modelRequests: models.length - count,
      wire: wire.map((event) => ({ type: event.type, method: event.method })),
      commands,
    });
    await runtime.close();
    runtime = undefined;
  }
  assert.equal(fixtureError, undefined);
  console.log(JSON.stringify({ piVersion: "0.84.2", records }, null, 2));
} finally {
  await runtime?.close();
  model.closeAllConnections();
  await new Promise((resolve) => model.close(resolve));
  await rm(root, { recursive: true, force: true });
}
