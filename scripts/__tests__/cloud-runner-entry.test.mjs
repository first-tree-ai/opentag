import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { main } from "../e2e/cloud-runner/run.mjs";

test("cloud runner entry executes its first step and records a redacted fixture failure", async () => {
  const artifacts = await mkdtemp(join(tmpdir(), "cloud-runner-entry-"));
  const keys = ["OPENTAG_E3_ARTIFACTS", "OPENTAG_E3_GCP_ACCESS_TOKEN"];
  const before = keys.map((key) => process.env[key]);
  const credential = "synthetic-cloud-entry-credential";
  process.env.OPENTAG_E3_ARTIFACTS = artifacts;
  process.env.OPENTAG_E3_GCP_ACCESS_TOKEN = credential;
  let called = 0;
  try {
    const exit = await main(
      [
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
        "--mode",
        "offline",
      ],
      {
        createFixture: async () => {
          called += 1;
          throw new Error(`fixture unavailable ${credential}`);
        },
      },
    );
    assert.equal(called, 1);
    assert.equal(exit, 1);
    const serialized = await readFile(join(artifacts, "summary.json"), "utf8");
    const summary = JSON.parse(serialized);
    assert.equal(summary.steps[0].label, "01 disposable Server and Postgres");
    assert.equal(summary.steps[0].ok, false);
    assert.equal(summary.outcome, "failed");
    assert.equal(serialized.includes(credential), false);
    assert.deepEqual(summary.allocations, []);
  } finally {
    keys.forEach((key, index) => {
      if (before[index] === undefined) delete process.env[key];
      else process.env[key] = before[index];
    });
    await rm(artifacts, { recursive: true, force: true });
  }
});
