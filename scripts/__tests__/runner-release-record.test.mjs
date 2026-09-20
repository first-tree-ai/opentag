import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  formatReleaseRecord,
  parseReleaseRecord,
  readReleaseRecord,
  writeReleaseRecord,
} from "../runner/release-record.mjs";

const IMAGE = "us-west1-docker.pkg.dev/opentag-test/runners/opentag-runner";
const DIGEST = `sha256:${"1".repeat(64)}`;
const SHA = "a".repeat(40);

function valid() {
  return {
    schemaVersion: 1,
    channel: "staging",
    version: "0.0.6-staging.30.1",
    sourceSha: SHA,
    image: `${IMAGE}@${DIGEST}`,
  };
}

test("a valid record round-trips through write and read", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opentag-record-"));
  const path = join(directory, "nested", "runner-release.json");
  try {
    await writeReleaseRecord(
      path,
      formatReleaseRecord({
        channel: "staging",
        version: "0.0.6-staging.30.1",
        sourceSha: SHA,
        repository: IMAGE,
        digest: DIGEST,
      }),
    );
    const record = await readReleaseRecord(path);
    assert.deepEqual(record, { ...valid(), repository: IMAGE, digest: DIGEST });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("malformed records reject instead of being partially trusted", () => {
  assert.throws(() => parseReleaseRecord(null), /JSON object/);
  assert.throws(() => parseReleaseRecord({ ...valid(), schemaVersion: 2 }), /schemaVersion/);
  assert.throws(() => parseReleaseRecord({ ...valid(), channel: "dev" }), /channel/);
  assert.throws(() => parseReleaseRecord({ ...valid(), channel: "prod" }), /stable semantic version/);
  assert.throws(() => parseReleaseRecord({ ...valid(), version: "0.0.5" }), /staging semantic version/);
  assert.throws(() => parseReleaseRecord({ ...valid(), sourceSha: "abc" }), /40-character/);
  assert.throws(() => parseReleaseRecord({ ...valid(), image: `${IMAGE}:0.0.6-staging.30.1` }), /digest/);
  assert.throws(() => parseReleaseRecord({ ...valid(), image: `${IMAGE}@sha256:short` }), /digest/);
  assert.throws(() => parseReleaseRecord({ ...valid(), token: "unexpected" }), /unknown keys: token/);
  const missing = valid();
  delete missing.version;
  assert.throws(() => parseReleaseRecord(missing), /version is required/);
});

test("prod records require a stable version and the image stays digest-pinned", () => {
  const record = parseReleaseRecord({
    schemaVersion: 1,
    channel: "prod",
    version: "0.0.5",
    sourceSha: SHA,
    image: `${IMAGE}@${DIGEST}`,
  });
  assert.equal(record.channel, "prod");
  assert.equal(record.repository, IMAGE);
  assert.throws(
    () =>
      formatReleaseRecord({ channel: "prod", version: "0.0.5", sourceSha: SHA, repository: IMAGE, digest: "garbage" }),
    /sha256/,
  );
});
