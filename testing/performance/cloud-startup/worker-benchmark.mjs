import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { connect as connectTcp, createServer as createTcpServer } from "node:net";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { createServer as createTlsServer } from "node:tls";
import { pathToFileURL } from "node:url";

// Run only in an owned, network-disabled Linux container; these are container paths.
assert.equal(process.platform, "linux");
assert.equal(process.env.OPENTAG_STARTUP_FIXTURE, "1");
const sourceRoot = resolve(process.argv[2]);
const output = resolve(process.argv[3]);
const harnessSource = await readFile(new URL(import.meta.url));
const harnessSha256 = createHash("sha256").update(harnessSource).digest("hex");
await writeFile(`${output}.harness.mjs`, harnessSource);
const stageLocal = process.env.OPENTAG_STARTUP_STAGE_LOCAL === "1";
const root = stageLocal ? await mkdtemp("/tmp/startup-linux-fixture-") : sourceRoot;
if (stageLocal) await cp(sourceRoot, root, { recursive: true, dereference: true });
const samples = Number(process.argv[4] ?? 20);
const scheduledOnly = process.argv[5] === "scheduled-input";
assert.ok(process.argv[5] === undefined || scheduledOnly, "optional scenario must be scheduled-input");
const includeAdapter = process.env.OPENTAG_STARTUP_INCLUDE_ADAPTER === "1";
assert.ok(Number.isInteger(samples) && samples > 0);
const adapters = includeAdapter
  ? Object.fromEntries(
      await Promise.all(
        ["before", "after"].map(async (version) => [
          version,
          (await import(pathToFileURL(join(root, version, "dist/index.mjs")))).RuntimeProxyLoopbackAdapter,
        ]),
      ),
    )
  : undefined;
const template = JSON.parse(await readFile(join(root, "request.json"), "utf8"));
const records = [];
const requests = new Map();
const servers = [];
const children = new Set();
const readCounters = async (path) =>
  Object.fromEntries(
    (await readFile(path, "utf8"))
      .trim()
      .split("\n")
      .map((line) => {
        const [key, value] = line.split(" ");
        return [key, Number(value)];
      }),
  );
const readCpu = () => readCounters("/sys/fs/cgroup/cpu.stat");
const workspace = "/workspace";
const executionDir = "/run/opentag-execution/fixture";
const listen = (server, port) =>
  new Promise((done, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", done);
  });

await mkdir(workspace, { recursive: true });
await mkdir(executionDir, { recursive: true });
await writeFile(
  "/usr/local/bin/pi",
  `#!/bin/sh\nexec /usr/local/bin/node '${join(root, "pi/node_modules/@earendil-works/pi-coding-agent/dist/cli.js")}' "$@"\n`,
  { mode: 0o755 },
);
await cp(join(root, "tls/ca.pem"), join(executionDir, "ca.pem"));
await writeFile(
  join(executionDir, "environment.json"),
  JSON.stringify({
    executionId: randomUUID(),
    environment: {
      OPENTAG_PROVIDER_PROXY_URL: "http://127.0.0.1:18080",
      OPENTAG_PROVIDER_CA_FILE: join(executionDir, "ca.pem"),
    },
  }),
);

const connect = createTcpServer((socket) => {
  socket.once("data", () => socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"));
});
const slack = createTlsServer(
  { cert: await readFile(join(root, "tls/ca.pem")), key: await readFile(join(root, "tls/key.pem")) },
  (socket) => socket.once("data", () => socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n")),
);
const model = createHttpServer((request, response) => {
  void (async () => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    const text = JSON.stringify(body.messages);
    const active = [...requests.values()].find((sample) => text.includes(sample.marker));
    assert.ok(active, "model must receive the exact current input");
    active.modelRequests++;
    active.firstModelRequestMs ??= performance.now() - active.started;
    active.historyPresent = !active.previousMarker || text.includes(active.previousMarker);
    if (active.mode === "model-timeout") return;
    if (active.mode === "model-rejection") {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Invalid fixture request", code: "invalid_request_error" } }));
      return;
    }
    const chunk = (choices, extra = {}) =>
      `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: "fixture-model", choices, ...extra })}\n\n`;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(
      chunk([{ index: 0, delta: { role: "assistant", content: "FIXTURE_DONE" }, finish_reason: null }]) +
        chunk([{ index: 0, delta: {}, finish_reason: "stop" }], {
          usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 },
        }) +
        "data: [DONE]\n\n",
    );
  })().catch(() => response.destroy());
});
servers.push(...(includeAdapter ? [] : [connect, slack]), model);

async function prepareAdapter(record, request) {
  const materialDir = await mkdtemp("/tmp/startup-adapter-");
  const directory = `/run/opentag-execution/${randomUUID()}`;
  const listeners = [];
  const sockets = new Set();
  let adapter;
  const close = async () => {
    for (const socket of sockets) socket.destroy();
    await Promise.all(listeners.map((server) => new Promise((done) => server.close(done))));
    await adapter?.close();
    await rm(materialDir, { recursive: true, force: true });
    await rm(directory, { recursive: true, force: true });
  };
  try {
    adapter = await adapters[record.version].start({
      executionId: randomUUID(),
      materialDir,
      verifyHandle: () => false,
      openStream: async () => {
        throw new Error("No external provider calls are permitted");
      },
      logger: { debug() {}, warn() {} },
    });
    record.adapterReadyMs = performance.now() - record.started;
    // A loopback byte tunnel substitutes only for native sandbox exec's HTTP/2 transport.
    for (const [entry, target] of [
      [18080, adapter.connectProxyUrl],
      [18443, adapter.slackApiHost],
    ]) {
      const listener = createTcpServer({ allowHalfOpen: true }, (client) => {
        const upstream = connectTcp({ host: "127.0.0.1", port: Number(new URL(target).port), allowHalfOpen: true });
        for (const socket of [client, upstream]) {
          sockets.add(socket);
          socket.on("error", () => {
            client.destroy();
            upstream.destroy();
          });
          socket.on("close", () => sockets.delete(socket));
        }
        client.pipe(upstream);
        upstream.pipe(client);
      });
      await listen(listener, entry);
      listeners.push(listener);
    }
    await mkdir(directory);
    await cp(adapter.caCertPath, join(directory, "ca.pem"));
    await writeFile(
      join(directory, "environment.json"),
      JSON.stringify({
        executionId: adapter.executionId,
        environment: { OPENTAG_PROVIDER_PROXY_URL: "http://127.0.0.1:18080" },
      }),
    );
    request.executionDir = directory;
    return { close };
  } catch (error) {
    await close();
    throw error;
  }
}

function quantile(values, q) {
  const sorted = values.filter(Number.isFinite).toSorted((a, b) => a - b);
  return sorted.length ? sorted[Math.ceil(sorted.length * q) - 1] : null;
}

async function run(version, scenario, sessionId, previousMarker, mode = "success") {
  const marker = `STARTUP_INPUT_${randomUUID()}`;
  const cpuBefore = await readCpu();
  const started = performance.now();
  const record = { version, scenario, sessionId, marker, previousMarker, mode, started, modelRequests: 0 };
  const request = structuredClone(template);
  Object.assign(request.delivery, {
    sessionId,
    deliveryId: randomUUID(),
    requestId: randomUUID(),
    deadlineAt: new Date(Date.now() + (mode === "model-timeout" ? 5_000 : 30_000)).toISOString(),
  });
  request.delivery.content.text = marker;
  request.model.baseUrl = "http://127.0.0.1:19999/v1";
  request.model.expiresAt = new Date(Date.now() + 60_000).toISOString();
  request.piSessionDirectory = join(workspace, sessionId, ".opentag/pi-session");
  if (scenario === "scheduled-input") {
    request.kind = "session-message";
    request.sessionKind = "visible";
    request.outboxContext = { provider: "slack", sessionKind: "channel", channelId: "C0FIXTURE" };
    request.deadlineAt = request.delivery.deadlineAt;
    request.message = {
      type: "session:message:deliver",
      requestId: randomUUID(),
      messageId: randomUUID(),
      targetSessionId: sessionId,
      agentId: request.delivery.agentId,
      placementGeneration: 1,
      content: { kind: "text", text: marker },
      runtime: request.delivery.runtime,
      scheduledOrigin: {
        scheduleId: randomUUID(),
        scheduledFor: new Date().toISOString(),
        timezone: "Asia/Taipei",
        name: "Startup fixture",
      },
      sentAt: new Date().toISOString(),
      scheduleDetailUrl: "https://fixture.invalid/schedule",
    };
    delete request.delivery;
  }
  let parent;
  try {
    if (includeAdapter) parent = await prepareAdapter(record, request);
  } catch (error) {
    record.failure = error.name;
    record.outcome = "adapter_preparation_failed";
    record.totalMs = performance.now() - started;
    delete record.started;
    records.push(record);
    return marker;
  }
  record.workerSpawnMs = performance.now() - started;
  requests.set(marker, record);
  const child = spawn(process.execPath, [join(root, version, "dist/runner/bin.mjs"), "worker"], {
    env: { PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.add(child);
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
    if (record.workerReadyMs === undefined && stderr.includes('"event":"ready"')) {
      record.workerReadyMs = performance.now() - started;
    }
  });
  child.stdin.end(`${JSON.stringify(request)}\n`);
  const timeout = setTimeout(() => {
    record.harnessTimeout = true;
    child.kill("SIGTERM");
  }, 40_000);
  const kill = setTimeout(() => child.kill("SIGKILL"), 45_000);
  try {
    const [code, signal] = await new Promise((done, reject) => {
      child.once("error", reject);
      child.once("close", (...args) => done(args));
    });
    record.totalMs = performance.now() - started;
    const cpuAfter = await readCpu();
    record.cgroupCpuUs = cpuAfter.usage_usec - cpuBefore.usage_usec;
    record.cgroupThrottleUs = cpuAfter.throttled_usec - cpuBefore.throttled_usec;
    record.cgroupThrottledPeriods = cpuAfter.nr_throttled - cpuBefore.nr_throttled;
    record.memoryEvents = await readCounters("/sys/fs/cgroup/memory.events");
    record.code = code;
    record.signal = signal;
    const result = JSON.parse(stdout.trim());
    record.outcome = result.completion?.outcome ?? result.code;
    record.errorReason = result.completion?.errorReason;
    record.phases = stderr
      .split("\n")
      .filter((line) => line.startsWith("opentag-pi-diagnostic:"))
      .map((line) => JSON.parse(line.slice("opentag-pi-diagnostic:".length)))
      .map(({ phase, event, durationMs, elapsedMs, outcome }) => ({ phase, event, durationMs, elapsedMs, outcome }));
    record.promptAcceptedWorkerElapsedMs = record.phases.find(
      (entry) => entry.phase === "prompt_acceptance" && entry.event === "end",
    )?.elapsedMs;
    record.success =
      code === 0 &&
      result.completion?.finalText === "FIXTURE_DONE" &&
      record.historyPresent === true &&
      record.modelRequests === 1;
  } catch (error) {
    record.failure = error.name;
  } finally {
    clearTimeout(timeout);
    clearTimeout(kill);
    children.delete(child);
    requests.delete(marker);
    try {
      await parent?.close();
    } catch (error) {
      record.cleanupFailure = error.name;
      record.success = false;
    }
    delete record.started;
    records.push(record);
  }
  return marker;
}

function summary() {
  const groups = new Map();
  for (const record of records) {
    const key = `${record.version}/${record.scenario}`;
    const group = groups.get(key) ?? [];
    group.push(record);
    groups.set(key, group);
  }
  return Object.fromEntries(
    [...groups].map(([key, group]) => [
      key,
      {
        n: group.length,
        successes: group.filter((record) => record.success).length,
        failures: group.filter((record) => !record.success).length,
        timeouts: group.filter((record) => record.errorReason === "turn_timeout" || record.harnessTimeout).length,
        inputAtModelP50Ms: quantile(
          group.map((record) => record.firstModelRequestMs),
          0.5,
        ),
        inputAtModelP95Ms: quantile(
          group.map((record) => record.firstModelRequestMs),
          0.95,
        ),
        workerReadyP50Ms: quantile(
          group.map((record) => record.workerReadyMs),
          0.5,
        ),
        adapterReadyP50Ms: quantile(
          group.map((record) => record.adapterReadyMs),
          0.5,
        ),
        adapterReadyP95Ms: quantile(
          group.map((record) => record.adapterReadyMs),
          0.95,
        ),
        totalP95Ms: quantile(
          group.map((record) => record.totalMs),
          0.95,
        ),
        cgroupCpuP50Us: quantile(
          group.map((record) => record.cgroupCpuUs),
          0.5,
        ),
      },
    ]),
  );
}

async function checkpoint(stage, iteration) {
  if ((iteration + 1) % 10) return;
  await writeFile(
    `${output}.partial`,
    `${JSON.stringify({ stage, iteration, includeAdapter, stageLocal, harnessSha256, summary: summary(), records })}\n`,
  );
}

try {
  await Promise.all([...(includeAdapter ? [] : [listen(connect, 18080), listen(slack, 18443)]), listen(model, 19999)]);
  const sessions = { before: randomUUID(), after: randomUUID() };
  const previous = {};
  for (let index = 0; index < samples; index++) {
    // Alternate order to limit drift; retain all samples, including first process and failures.
    for (const version of index % 2 ? ["after", "before"] : ["before", "after"]) {
      if (!scheduledOnly) {
        await run(version, "fresh-session", randomUUID());
        previous[version] = await run(version, "sequential", sessions[version], previous[version]);
      }
      await run(version, "scheduled-input", randomUUID());
    }
    await checkpoint("primary", index);
  }
  if (!scheduledOnly) {
    await cp(workspace, "/tmp/startup-restore", { recursive: true });
    await rm(workspace, { recursive: true });
    await cp("/tmp/startup-restore", workspace, { recursive: true });
  }
  for (let index = 0; !scheduledOnly && index < samples; index++) {
    for (const version of index % 2 ? ["after", "before"] : ["before", "after"]) {
      previous[version] = await run(version, "restored-files", sessions[version], previous[version]);
      if (!includeAdapter)
        await Promise.all([
          run(version, "concurrent-history", randomUUID()),
          run(version, "concurrent-history", randomUUID()),
        ]);
    }
    await checkpoint("restored", index);
  }
  for (const version of ["before", "after"]) {
    await run(version, "model-rejection", randomUUID(), undefined, "model-rejection");
    await run(version, "model-timeout", randomUUID(), undefined, "model-timeout");
  }
} finally {
  for (const child of children) child.kill("SIGKILL");
  for (const server of servers) {
    server.closeAllConnections?.();
    server.close();
  }
  await mkdir(resolve(output, ".."), { recursive: true });
  await writeFile(
    output,
    `${JSON.stringify(
      {
        node: process.version,
        arch: process.arch,
        platform: process.platform,
        samples,
        includeAdapter,
        stageLocal,
        scheduledTarget: "visible",
        scheduledOnly,
        harnessSha256,
        memoryPeakBytes: Number(await readFile("/sys/fs/cgroup/memory.peak", "utf8")),
        boundaries: [
          "Real built Runner CLI, worker, pinned Pi RPC and loopback model; no paid provider or credentials",
          includeAdapter
            ? "Real execution adapter including fresh CA, TLS challenge and fixed CONNECT refusal; byte tunnel substitutes for native Sandbox HTTP/2 bridge"
            : "Transport fixtures prove local TLS/status checks only; no native Sandbox HTTP/2 bridge",
          "No Server ingress, queue, allocation, idle reclamation or GCS; scenarios are local component measurements",
          "Concurrent samples use distinct histories on one container, not physical Session isolation acceptance",
          "First model request proves the exact current input; it excludes model inference and generation",
          "Failure and timeout samples retained; p95 uses nearest rank; sample count does not support p99",
        ],
        summary: summary(),
        records,
      },
      null,
      2,
    )}\n`,
  );
  process.stdout.write(`${JSON.stringify(summary(), null, 2)}\n`);
  if (stageLocal) await rm(root, { recursive: true, force: true });
  process.exitCode = records.some(
    (record) =>
      record.cleanupFailure ||
      record.failure ||
      record.harnessTimeout ||
      (record.mode === "success"
        ? !record.success
        : record.code !== 1 ||
          record.outcome !== "failed" ||
          record.modelRequests !== 1 ||
          record.errorReason !== (record.mode === "model-timeout" ? "turn_timeout" : "provider_request_rejected")),
  )
    ? 1
    : 0;
}
