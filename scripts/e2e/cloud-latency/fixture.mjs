import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";

const compress = promisify(gzip);
const decompress = promisify(gunzip);
const digest = (value) => createHash("sha256").update(value).digest("hex");
export const scenarios = [
  { name: "cold-empty", bytes: 0, restore: false, mcp: false, allocation: "fresh" },
  { name: "warm-64k", bytes: 64 * 1024, restore: false, mcp: false, allocation: "ready" },
  { name: "restored-4m", bytes: 4 * 1024 * 1024, restore: true, mcp: false, allocation: "fresh" },
  { name: "mcp-64k", bytes: 64 * 1024, restore: true, mcp: true, allocation: "ready" },
];
export const failureScenarios = [
  { ...scenarios[0], name: "injected-rejection", failure: "reject" },
  { ...scenarios[0], name: "injected-timeout", failure: "hang" },
];

async function populateWorkspace(scenario, directory) {
  const corpus = Buffer.alloc(scenario.bytes);
  for (let index = 0; index < corpus.length; index++) corpus[index] = (index * 31 + (index >>> 9)) % 256;
  const archive = await compress(corpus);
  await writeFile(join(directory, "saved.gz"), archive);
  await mkdir(join(directory, "workspace"));
  if (scenario.allocation === "ready") await mkdir(join(directory, "allocation"));
  if (!scenario.restore) await writeFile(join(directory, "workspace", "corpus"), corpus);
  return { directory, corpusHash: digest(corpus), archiveBytes: archive.length };
}

export async function prepareWorkspace(scenario) {
  const directory = await mkdtemp(join(tmpdir(), "opentag-latency-fixture-"));
  try {
    return await populateWorkspace(scenario, directory);
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

function rpcClient() {
  const child = fork(new URL("./fixture-worker.mjs", import.meta.url), [], {
    stdio: ["ignore", "ignore", "inherit", "ipc"],
    env: {},
    execArgv: [],
  });
  const pending = new Map();
  let sequence = 0;
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  const fail = (error) => {
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
  };
  child.on("error", fail);
  child.on("exit", () => fail(new Error("Fixture worker exited before reply")));
  child.on("message", (message) => {
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(message.error));
    else entry.resolve(message);
  });
  const request = async (command, fields = {}, timeoutMs = 5000) => {
    const id = ++sequence;
    let timer;
    try {
      return await new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        timer = setTimeout(
          () => reject(Object.assign(new Error("Fixture RPC deadline"), { code: "FIXTURE_TIMEOUT" })),
          timeoutMs,
        );
        child.send({ id, command, ...fields }, (error) => {
          if (error) reject(error);
        });
      });
    } finally {
      clearTimeout(timer);
      pending.delete(id);
    }
  };
  return { child, request, exited };
}

async function measured(sample, phase, clock, action) {
  const startMs = clock();
  try {
    return await action();
  } finally {
    sample.spans.push({ phase, startMs, endMs: clock() });
  }
}

async function runBody(scenario, context) {
  const { sample, fixture, phase } = context;
  const workspace = join(fixture.directory, "workspace", "corpus");
  const marker = `fixture-${scenario.name}-${sample.iteration}`;
  await phase("ingress_queue", () => delay(2));
  await phase("runtime_assembly", async () => {
    assert.equal(JSON.parse(JSON.stringify({ marker, skills: Array(100).fill("fixture-skill") })).marker, marker);
  });
  await phase("sandbox_provision", async () => {
    if (scenario.allocation === "fresh") await mkdir(join(fixture.directory, "allocation"));
  });
  await phase("workspace_restore", async () => {
    if (scenario.restore) {
      const bytes = await readFile(join(fixture.directory, "saved.gz"));
      const corpus = await decompress(bytes);
      assert.equal(digest(corpus), fixture.corpusHash);
      await writeFile(workspace, corpus);
      sample.resources.logicalReadBytes += bytes.length;
      sample.resources.logicalWriteBytes += corpus.length;
    }
  });
  await phase("pi_startup", async () => {
    context.rpc = rpcClient();
    assert.equal((await context.rpc.request("get_state")).result, "fixture-ready");
    assert.equal((await context.rpc.request("prompt", { marker })).result, marker);
  });
  await phase("mcp_startup", async () => {
    if (scenario.mcp) assert.deepEqual((await context.rpc.request("mcp")).result, ["fixture_hash"]);
  });
  await phase("model_ttft", async () => {
    const command = scenario.failure ?? "token";
    assert.equal((await context.rpc.request(command, {}, command === "hang" ? 25 : 5000)).result, marker);
  });
  await phase("tool_call", async () => {
    assert.equal((await context.rpc.request("tool")).result, digest(marker));
  });
  await phase("im_outbound", async () => {
    assert.equal((await context.rpc.request("receipt")).result, marker);
    context.mark("firstReceipt");
    await writeFile(join(fixture.directory, "workspace", "receipt"), marker);
    sample.resources.logicalWriteBytes += Buffer.byteLength(marker);
  });
}

async function checkpoint(context) {
  const { fixture, sample } = context;
  const corpus = await readFile(join(fixture.directory, "workspace", "corpus"));
  const receipt = await readFile(join(fixture.directory, "workspace", "receipt"));
  const bytes = Buffer.concat([corpus, receipt]);
  const archive = await compress(bytes);
  const handle = await open(join(fixture.directory, "checkpoint.gz"), "wx", 0o600);
  try {
    await handle.writeFile(archive);
    await handle.sync();
  } finally {
    await handle.close();
  }
  assert.equal(digest(await decompress(await readFile(join(fixture.directory, "checkpoint.gz")))), digest(bytes));
  sample.resources.logicalReadBytes += corpus.length + receipt.length + archive.length;
  sample.resources.logicalWriteBytes += archive.length;
}

export async function runSample(scenario, iteration) {
  let start = performance.now();
  let cpu = process.cpuUsage();
  const clock = () => performance.now() - start;
  const sample = {
    scenario: scenario.name,
    iteration,
    outcome: "incomplete",
    spans: [],
    marks: { ingress: 0 },
    resources: { parentCpuMs: 0, logicalReadBytes: 0, logicalWriteBytes: 0 },
  };
  const phase = (name, action) => measured(sample, name, clock, action);
  const context = {
    sample,
    phase,
    mark: (name) => {
      sample.marks[name] = clock();
    },
  };
  try {
    context.fixture = await prepareWorkspace(scenario);
    start = performance.now();
    cpu = process.cpuUsage();
    await runBody(scenario, context);
    await phase("terminal_cleanup", async () => {
      const { cpu } = await context.rpc.request("shutdown");
      sample.resources.workerCpuMs = (cpu.user + cpu.system) / 1000;
      assert.deepEqual(await context.rpc.exited, { code: 0, signal: null });
    });
    sample.marks.terminal = clock();
    await phase("checkpoint", () => checkpoint(context));
    sample.marks.checkpoint = clock();
    await phase("report_ack", async () => assert.ok(sample.marks.checkpoint >= sample.marks.terminal));
    sample.marks.reportAck = clock();
    sample.outcome = "success";
  } catch (error) {
    sample.outcome = error.code === "FIXTURE_TIMEOUT" ? "timeout" : "failed";
    sample.failurePhase = sample.spans.at(-1)?.phase ?? "fixture_setup";
    sample.failureCode =
      error.code === "FIXTURE_TIMEOUT"
        ? "fixture_deadline"
        : error.message === "injected_model_rejection"
          ? "injected_model_rejection"
          : "fixture_failure";
  } finally {
    if (context.rpc?.child.exitCode === null && context.rpc?.child.signalCode === null) {
      context.rpc.child.kill("SIGKILL");
      await context.rpc.exited;
    }
    const used = process.cpuUsage(cpu);
    sample.resources.parentCpuMs = (used.user + used.system) / 1000;
    sample.observedUntilMs = clock();
    if (context.fixture) {
      try {
        await rm(context.fixture.directory, { recursive: true, force: true });
      } catch {
        sample.outcome = "failed";
        sample.cleanupFailed = true;
      }
    }
  }
  return sample;
}
