// Run after pnpm build and npm ci --prefix scripts/runner/pi.
// Uses the pinned, real Pi RPC process with a loopback-only model fixture. No paid API or credentials.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PiAgentRuntimeFactory } from "../../packages/client/dist/index.mjs";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const piRoot = resolve(repo, "scripts/runner/pi/node_modules/@earendil-works/pi-coding-agent");
assert.equal(JSON.parse(await readFile(join(piRoot, "package.json"), "utf8")).version, "0.84.2");
const results = [];
for (const window of [64_000, 258_000]) {
  results.push(await scenario(window, "threshold"));
  results.push(await scenario(window, "overflow"));
}
results.push(await scenario(64_000, "cancel"));
results.push(await scenario(64_000, "retry"));
results.push(await scenario(64_000, "summary-refused"));
results.push(await scenario(64_000, "overflow-summary-refused"));
results.push(await scenario(64_000, "process-exit"));
process.stdout.write(`${JSON.stringify({ pi: "0.84.2", realProvider: false, results }, null, 2)}\n`);

async function scenario(window, mode) {
  const root = await mkdtemp(join(tmpdir(), "opentag-compaction-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, ".pi", "agent");
  const sessions = join(root, "sessions");
  await Promise.all([mkdir(workspace), mkdir(agentDir, { recursive: true }), mkdir(sessions)]);
  const events = [];
  const requests = [];
  const errors = [];
  let summaryCount = 0;
  let summaryAttempts = 0;
  let normalCount = 0;
  let toolCount = 0;
  const toolId = window === 258_000 ? `call_${"x".repeat(4_200)}` : "call_fixture";
  let runtime;
  let child;
  let timer;
  let stage = "seed";
  let summarySeen;
  let releaseSummary;
  const seen = new Promise((done) => {
    summarySeen = done;
  });
  const gate = new Promise((done) => {
    releaseSummary = done;
  });
  const server = createServer((request, response) => {
    void handle(request, response).catch((error) => {
      errors.push(error);
      response.destroy();
    });
  });
  async function handle(request, response) {
    assert.equal(request.url, "/v1/chat/completions");
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    const body = JSON.parse(bytes);
    const summary = JSON.stringify(body.messages[0]).includes("context summarization assistant");
    requests.push({ stage, summary, bytes: bytes.length, body });
    if (summary) return handleSummary(response, body);
    normalCount++;
    if (stage === "seed") {
      send(response, body, { content: "Stored LOCAL_CONTEXT_MARKER" }, 1_000, 10);
      return;
    }
    if (stage === "compact") return handleCompacting(response, body);
    handleContinuation(response, body);
  }
  function handleCompacting(response, body) {
    if (mode.startsWith("overflow") && !summaryCount) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: {
            code: "context_length_exceeded",
            message: "context_length_exceeded",
            type: "invalid_request_error",
          },
        }),
      );
    } else {
      send(response, body, { content: "Finished" }, summaryCount ? 500 : window - 16_384 + 1, 10);
    }
  }
  function handleContinuation(response, body) {
    assert.match(JSON.stringify(body.messages), /Checkpoint: preserve LOCAL_CONTEXT_MARKER/);
    if (body.messages.at(-1).role !== "tool") {
      toolCount++;
      send(
        response,
        body,
        {
          tool_calls: [
            {
              index: 0,
              id: toolId,
              type: "function",
              function: { name: "bash", arguments: JSON.stringify({ command: "printf 'once\\n' >> counter.txt" }) },
            },
          ],
        },
        500,
        10,
        "tool_calls",
      );
    } else {
      assert.equal(body.messages.at(-1).tool_call_id, toolId, "preserve wire tool ID verbatim");
      send(response, body, { content: "CONTINUED" }, 550, 10);
    }
  }
  async function handleSummary(response, body) {
    summaryAttempts++;
    assert.equal(runtime.state.phase, "running", "compaction must retain execution ownership");
    summarySeen();
    await gate;
    if (response.destroyed) return;
    if (mode === "retry" && summaryAttempts === 1) {
      response.writeHead(429, { "content-type": "application/json", "retry-after": "0" });
      response.end(JSON.stringify({ error: { message: "Rate limit exceeded", code: "rate_limit_exceeded" } }));
      return;
    }
    if (mode.endsWith("summary-refused")) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Invalid request", code: "invalid_request_error" } }));
      return;
    }
    summaryCount++;
    send(
      response,
      body,
      { content: "Checkpoint: preserve LOCAL_CONTEXT_MARKER; write counter.txt once in the next turn." },
      123,
      20,
    );
    return;
  }
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  try {
    await writeFile(
      join(agentDir, "models.json"),
      JSON.stringify({
        providers: {
          fixture: {
            baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
            api: "openai-completions",
            apiKey: "local-fixture-only",
            models: [
              {
                id: "fixture-model",
                name: "Fixture",
                contextWindow: window,
                maxTokens: 8192,
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                compat: { supportsDeveloperRole: false },
              },
            ],
          },
        },
      }),
    );
    await writeFile(
      join(agentDir, "settings.json"),
      JSON.stringify({
        defaultProvider: "fixture",
        defaultModel: "fixture-model",
        compaction: { enabled: true },
        retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 },
      }),
    );
    const factory = new PiAgentRuntimeFactory({
      process: {
        command: process.execPath,
        args: [join(piRoot, "dist/cli.js")],
        sessionDirectory: sessions,
        spawnProcess: (command, args, options) => {
          child = spawn(command, args, { ...options, stdio: "pipe" });
          return child;
        },
        env: { PATH: process.env.PATH, HOME: root, PI_CODING_AGENT_DIR: agentDir },
      },
    });
    const config = {
      eventSink: (event) => {
        events.push(event);
      },
      systemPrompt: "Local deterministic acceptance fixture.",
      workspace: { cwd: workspace },
      configuration: { model: "fixture/fixture-model" },
      policy: {
        fileSystem: "unrestricted",
        network: "enabled",
        approvals: "never",
        tools: { mode: "provider-default" },
      },
    };
    runtime = await factory.create(config);
    const prompt = (runId, text, signal = AbortSignal.timeout(45_000)) =>
      runtime.prompt({ runId, input: { items: [{ type: "text", text }] }, signal });
    const seed = await prompt("seed", `LOCAL_CONTEXT_MARKER\n${"const value = 你好;\n".repeat(Math.ceil(window / 7))}`);
    assert.equal(seed.status, "completed", JSON.stringify(seed.error));
    const recent = await prompt(
      "recent",
      `Keep this recent turn.\n${"recent code line\n".repeat(Math.ceil(window / 7))}`,
    );
    assert.equal(recent.status, "completed", JSON.stringify(recent.error));
    stage = "compact";
    const controller = new AbortController();
    timer = setTimeout(() => controller.abort(), 45_000);
    const pending = prompt("compact", "Continue the existing work.", controller.signal);
    await Promise.race([
      seen,
      pending.then((value) => {
        throw new Error(
          `No native compaction: ${JSON.stringify(value)} EVENTS ${JSON.stringify(events.filter((e) => e.type === "provider_event"))}`,
        );
      }),
    ]);
    assert.equal(runtime.state.phase, "running");
    assert.ok(
      events.some(
        (event) =>
          event.type === "provider_event" &&
          event.payload.type === "compaction_start" &&
          event.payload.reason === (mode.startsWith("overflow") ? "overflow" : "threshold"),
      ),
      "observe native compaction, not a replacement summarizer",
    );
    assert.equal(
      events.some((e) => e.runId === "compact" && ["run_completed", "run_failed", "run_aborted"].includes(e.type)),
      false,
    );
    if (mode === "cancel") controller.abort();
    else if (mode === "process-exit") child.kill("SIGKILL");
    else releaseSummary();
    const compacted = await pending;
    clearTimeout(timer);
    releaseSummary();
    if (["cancel", "process-exit", "summary-refused", "overflow-summary-refused"].includes(mode)) {
      assertFailureOutcome(mode, compacted, summaryAttempts, summaryCount, events);
      const files = await readdir(sessions, { recursive: true });
      const history = (
        await Promise.all(
          files.filter((file) => file.endsWith(".jsonl")).map((file) => readFile(join(sessions, file), "utf8")),
        )
      ).join("\n");
      assert.match(history, /LOCAL_CONTEXT_MARKER/, "cancellation must retain the saved Session history");
    } else {
      assert.equal(compacted.status, "completed", JSON.stringify(compacted.error));
      const files = await readdir(sessions, { recursive: true });
      const history = (
        await Promise.all(files.filter((f) => f.endsWith(".jsonl")).map((f) => readFile(join(sessions, f), "utf8")))
      ).join("\n");
      assert.match(history, /"type":"compaction"/);
      const compactEvents = events.filter((e) => e.runId === "compact");
      assert.equal(compactEvents.filter((e) => e.type === "run_completed").length, 1);
      assert.equal(compactEvents.at(-1).type, "run_completed");
      const expectedInput = (mode === "overflow" ? 500 : window - 16_384 + 1) + 123 * summaryCount;
      assert.equal(compacted.usage.inputTokens, expectedInput, "summary usage must be counted exactly once");
      const binding = runtime.binding;
      await runtime.close();
      runtime = await factory.resume({ ...config, binding });
      stage = "continue";
      const continued = await prompt("continue", "Use bash to append once to counter.txt, then finish.");
      assert.equal(continued.status, "completed", JSON.stringify(continued.error));
      assert.equal(await readFile(join(workspace, "counter.txt"), "utf8"), "once\n");
      assert.equal(toolCount, 1, "resume must not replay tools");
      assert.equal(runtime.binding.payload.sessionId, binding.payload.sessionId);
    }
    assert.deepEqual(errors, []);
    if (mode === "retry") assert.equal(summaryAttempts, summaryCount + 1);
    assert.ok(Math.max(...requests.map((r) => r.bytes)) > 98_304, "exercise the former prompt ceiling");
    if (process.argv[2]) {
      const directory = resolve(process.argv[2]);
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, `${window}-${mode}.json`),
        JSON.stringify(requests.map((request) => request.body)),
      );
    }
    return {
      window,
      mode,
      status: compacted.status,
      summaryCount,
      summaryAttempts,
      normalCount,
      toolCount,
      maxRequestBytes: Math.max(...requests.map((r) => r.bytes)),
      runningDuringCompaction: true,
    };
  } finally {
    clearTimeout(timer);
    releaseSummary();
    await runtime?.close();
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
    await rm(root, { recursive: true, force: true });
  }
}

function send(response, body, delta, input, output, finish = "stop") {
  const usage = { prompt_tokens: input, completion_tokens: output, total_tokens: input + output };
  if (!body.stream) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        id: "local",
        object: "chat.completion",
        model: "fixture-model",
        choices: [{ index: 0, message: { role: "assistant", ...delta }, finish_reason: finish }],
        usage,
      }),
    );
    return;
  }
  response.writeHead(200, { "content-type": "text/event-stream" });
  const chunk = (choices, extra = {}) =>
    `data: ${JSON.stringify({ id: "local", object: "chat.completion.chunk", model: "fixture-model", choices, ...extra })}\n\n`;
  response.end(
    chunk([{ index: 0, delta: { role: "assistant", ...delta }, finish_reason: null }]) +
      chunk([{ index: 0, delta: {}, finish_reason: finish }], { usage }) +
      "data: [DONE]\n\n",
  );
}

function assertFailureOutcome(mode, compacted, summaryAttempts, summaryCount, events) {
  const expected = mode === "cancel" ? "aborted" : mode === "summary-refused" ? "completed" : "failed";
  assert.equal(compacted.status, expected, JSON.stringify(compacted));
  if (mode.endsWith("summary-refused")) {
    assert.equal(summaryAttempts, 1, "permanent summary errors must not retry");
    assert.equal(summaryCount, 0);
    assert.ok(
      events.some((event) => event.type === "provider_warning" && event.code === "pi_compaction_failed"),
      "summary failure must remain visible as a diagnostic",
    );
  }
}
