import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { E3_SUBSTITUTIONS, main } from "../e2e/cloud-runner/run.mjs";

const REQUIRED_ARGS = [
  "--project",
  "fixture-project",
  "--region",
  "us-west1",
  "--service-account",
  "fixture@example.invalid",
  "--image",
  `example.invalid/runner@sha256:${"a".repeat(64)}`,
  "--backend-origin",
  "https://example.invalid",
  "--vpc-network",
  "fixture-network",
  "--vpc-subnet",
  "fixture-subnet",
  "--execution-tag",
  "fixture-tag",
  "--storage-base",
  "gs://fixture-bucket/e5-tests",
  "--mode",
  "offline",
];

/** Run the entry against an immediately failing fixture and return its written receipt. */
async function runFailingEntry() {
  const artifacts = await mkdtemp(join(tmpdir(), "cloud-runner-entry-"));
  const keys = ["OPENTAG_E3_ARTIFACTS", "OPENTAG_E3_GCP_ACCESS_TOKEN"];
  const before = keys.map((key) => process.env[key]);
  const credential = "synthetic-cloud-entry-credential";
  process.env.OPENTAG_E3_ARTIFACTS = artifacts;
  process.env.OPENTAG_E3_GCP_ACCESS_TOKEN = credential;
  try {
    let called = 0;
    const exit = await main(REQUIRED_ARGS, {
      createFixture: async (options) => {
        assert.equal(options.serverEnv.OPENTAG_CLOUD_STORAGE_BASE, "gs://fixture-bucket/e5-tests");
        called += 1;
        throw new Error(`fixture unavailable ${credential}`);
      },
    });
    const serialized = await readFile(join(artifacts, "summary.json"), "utf8");
    return { exit, called, credential, serialized, summary: JSON.parse(serialized) };
  } finally {
    keys.forEach((key, index) => {
      if (before[index] === undefined) delete process.env[key];
      else process.env[key] = before[index];
    });
    await rm(artifacts, { recursive: true, force: true });
  }
}

test("cloud runner entry executes its first step and records a redacted fixture failure", async () => {
  const { exit, called, credential, serialized, summary } = await runFailingEntry();
  assert.equal(called, 1);
  assert.equal(exit, 1);
  assert.equal(summary.steps[0].label, "01 disposable Server and Postgres");
  assert.equal(summary.steps[0].ok, false);
  assert.equal(summary.outcome, "failed");
  assert.equal(serialized.includes(credential), false);
  assert.deepEqual(summary.allocations, []);
});

test("cloud runner receipts enumerate only substitutions the E3 path actually performs", async () => {
  const { serialized, summary } = await runFailingEntry();
  // The shared E2 list also carries forged repair codes, fake machine credentials and db-only
  // resource ownership; E3 never injects those and its Instances are real Cloud allocations, so
  // importing that list would forge the receipt.
  assert.deepEqual(
    summary.substitutions,
    E3_SUBSTITUTIONS.map((entry) => entry.name),
  );
  assert.deepEqual(summary.substitutions, ["fixture-slack-binding", "local-channel-target-url"]);
  for (const fabricated of [
    "forged-cloud-repair-code",
    "fake-cloud-machine-credential",
    "db-only-resource-ownership",
  ]) {
    assert.equal(summary.substitutions.includes(fabricated), false, `${fabricated} is not an E3 substitution`);
    assert.equal(serialized.includes(fabricated), false, `${fabricated} leaked into the receipt`);
  }
});

test("cloud runner rejects non-finite readiness deadlines before creating resources", async () => {
  const beforeToken = process.env.OPENTAG_E3_GCP_ACCESS_TOKEN;
  const beforeTimeout = process.env.OPENTAG_E3_READY_TIMEOUT_MS;
  process.env.OPENTAG_E3_GCP_ACCESS_TOKEN = "synthetic-cloud-entry-credential";
  try {
    for (const value of ["NaN", "Infinity", "0", "1.5", "1800001"]) {
      process.env.OPENTAG_E3_READY_TIMEOUT_MS = value;
      const exit = await main(REQUIRED_ARGS, {
        createFixture: () => {
          throw new Error("Invalid timeout must fail before fixture creation");
        },
      });
      assert.equal(exit, 2);
    }
  } finally {
    if (beforeToken === undefined) delete process.env.OPENTAG_E3_GCP_ACCESS_TOKEN;
    else process.env.OPENTAG_E3_GCP_ACCESS_TOKEN = beforeToken;
    if (beforeTimeout === undefined) delete process.env.OPENTAG_E3_READY_TIMEOUT_MS;
    else process.env.OPENTAG_E3_READY_TIMEOUT_MS = beforeTimeout;
  }
});
