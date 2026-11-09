import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { get } from "node:https";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

assert.equal(process.platform, "linux");
assert.equal(process.env.OPENTAG_STARTUP_FIXTURE, "1");
const root = resolve(process.argv[2]);
const output = resolve(process.argv[3]);
const samples = Number(process.argv[4] ?? 30);
assert.ok(Number.isInteger(samples) && samples > 0);
const variants = Object.fromEntries(
  await Promise.all(
    ["before", "after"].map(async (version) => [
      version,
      await import(pathToFileURL(join(root, version, "dist/index.mjs"))),
    ]),
  ),
);
const records = [];
for (let index = 0; index < samples; index++) {
  for (const version of index % 2 ? ["after", "before"] : ["before", "after"]) {
    const started = performance.now();
    const attempts = await Promise.allSettled(
      [0, 1].map(async (lane) => {
        const directory = await mkdtemp("/tmp/startup-concurrent-ca-");
        let adapter;
        try {
          adapter = await variants[version].RuntimeProxyLoopbackAdapter.start({
            executionId: randomUUID(),
            materialDir: directory,
            verifyHandle: () => false,
            openStream: async () => {
              throw new Error("External calls are forbidden");
            },
            logger: { debug() {}, warn() {} },
          });
          const readyMs = performance.now() - started;
          const ca = await readFile(adapter.caCertPath);
          await new Promise((done, reject) => {
            const request = get(`${adapter.slackApiHost}/api/auth.test`, { ca }, (response) => {
              if (response.statusCode !== 401) {
                response.resume();
                reject(new Error("Expected the execution-local credential challenge"));
                return;
              }
              response.resume();
              response.on("end", done);
            });
            request.on("error", reject);
          });
          return { lane, readyMs, challengeMs: performance.now() - started };
        } finally {
          await adapter?.close();
          await rm(directory, { recursive: true, force: true });
        }
      }),
    );
    records.push({
      index,
      version,
      attempts: attempts.map((attempt) =>
        attempt.status === "fulfilled"
          ? { status: attempt.status, ...attempt.value }
          : { status: attempt.status, error: attempt.reason.name },
      ),
    });
  }
}
await writeFile(
  output,
  `${JSON.stringify(
    {
      node: process.version,
      arch: process.arch,
      samples,
      boundary: "Two real execution adapters and TLS challenges; no workers, relay, native Sandbox or Cloud allocation",
      records,
    },
    null,
    2,
  )}\n`,
);
process.exitCode = records.some((record) => record.attempts.some((attempt) => attempt.status !== "fulfilled")) ? 1 : 0;
