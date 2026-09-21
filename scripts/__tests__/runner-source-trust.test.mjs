import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { prepareCliRelease } from "../prepare-cli-release.mjs";
import { resolveBuildVersion } from "../runner/build-image.mjs";
import { RUNNER_PINS } from "../runner/pins.mjs";
import { applyReleaseCoordinate, assertCleanBuildAllowed, buildIdentityRecord } from "../runner/source-trust.mjs";

const sourceManifest = {
  name: "open-tag",
  version: "0.0.5",
  private: true,
  license: "Apache-2.0",
  repository: { type: "git", url: "git+https://github.com/first-tree-ai/opentag.git" },
  bin: { "opentag-dev": "./dist/cli/index.mjs" },
};

test("staging version must be supplied externally and never self-incremented", () => {
  assert.equal(
    resolveBuildVersion({ channel: "staging", requestedVersion: "0.0.6-staging.4.1", sourceVersion: "0.0.5" }),
    "0.0.6-staging.4.1",
  );
  assert.throws(() => resolveBuildVersion({ channel: "staging", sourceVersion: "0.0.5" }), /externally resolved/);
  assert.throws(
    () => resolveBuildVersion({ channel: "staging", requestedVersion: "0.0.7-staging.1.1", sourceVersion: "0.0.5" }),
    /0\.0\.6-staging/,
  );
  assert.equal(resolveBuildVersion({ channel: "prod", sourceVersion: "0.0.5" }), "0.0.5");
  assert.equal(resolveBuildVersion({ channel: "dev", sourceVersion: "0.0.5" }), "0.0.5");
  assert.throws(
    () => resolveBuildVersion({ channel: "dev", requestedVersion: "0.0.6", sourceVersion: "0.0.5" }),
    /must match CLI source version/,
  );
});

test("prepare-cli-release is reused on a staged manifest copy", async () => {
  const result = await applyReleaseCoordinate({
    channel: "staging",
    version: "0.0.6-staging.2.1",
    manifest: sourceManifest,
  });
  try {
    const written = JSON.parse(await readFile(result.manifestPath, "utf8"));
    assert.equal(written.version, "0.0.6-staging.2.1");
    assert.equal(written.name, "open-tag-staging");
    assert.equal(result.prepared.version, "0.0.6-staging.2.1");
  } finally {
    await rm(result.directory, { recursive: true, force: true });
  }
});

test("dirty builds are explicit and Client 0.0.0 is not the runner version", () => {
  assert.throws(() => assertCleanBuildAllowed({ sourceDirty: true, allowDirty: false }), /dirty/);
  assertCleanBuildAllowed({ sourceDirty: true, allowDirty: true });
  const identity = buildIdentityRecord({
    channel: "dev",
    version: "0.0.5",
    allowDirty: true,
    source: {
      sourceSha: "440dfed53c3bb22a8527cd731f82e9b9006bd9b5",
      sourceDirty: true,
      cliPackageName: "open-tag",
      contextTreeVersion: "0.1.14",
    },
  });
  assert.equal(identity.version, "0.0.5");
  assert.equal(identity.cliPackageName, "open-tag");
  assert.notEqual(identity.version, "0.0.0");
  assert.equal(identity.piVersion, RUNNER_PINS.piVersion);
  assert.equal(identity.contextTreeVersion, "0.1.14");
});

test("prepareCliRelease still owns channel rewrite rules", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opentag-runner-prep-"));
  const manifestPath = join(directory, "package.json");
  await writeFile(manifestPath, `${JSON.stringify(sourceManifest, null, 2)}\n`);
  try {
    const prepared = await prepareCliRelease({
      channel: "prod",
      version: "0.0.5",
      manifestPath,
      buildInfoPath: undefined,
    });
    assert.equal(prepared.version, "0.0.5");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
