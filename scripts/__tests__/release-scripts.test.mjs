import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { classifyRegistryLookup } from "../check-npm-version.mjs";
import { assertCurrentStagingRevision } from "../check-staging-revision.mjs";
import { prepareCliRelease } from "../prepare-cli-release.mjs";
import {
  compareReleaseVersions,
  findLatestStagingVersion,
  formatStagingVersion,
  resolveNextPublishedStagingVersion,
  resolveProductionVersion,
} from "../release-versions.mjs";
import { classifyDistTagLookup, resolveDistTag, SUPERSEDED_DIST_TAG } from "../resolve-npm-dist-tag.mjs";
import { classifyPublishedMetadataLookup, classifyPublishedVersionsLookup } from "../resolve-staging-release.mjs";
import { generateThirdPartyNotices } from "../third-party-notices.mjs";

const sourceManifest = {
  name: "open-tag",
  version: "0.0.1",
  private: true,
  license: "Apache-2.0",
  repository: {
    type: "git",
    url: "git+https://github.com/first-tree-ai/opentag.git",
    directory: "apps/cli",
  },
  bin: {
    "opentag-dev": "./dist/cli/index.mjs",
  },
  devDependencies: {
    "@opentag/client": "workspace:*",
    "@opentag/shared": "workspace:*",
    commander: "^13.1.0",
    ws: "^8.21.3",
  },
};

async function withManifest(manifest, callback) {
  const directory = await mkdtemp(join(tmpdir(), "opentag-release-test-"));
  const manifestPath = join(directory, "package.json");
  try {
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await callback(manifestPath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("resolves next-patch staging versions and matching production tags", () => {
  assert.equal(formatStagingVersion("0.0.1", "42", "3"), "0.0.2-staging.42.3");
  assert.equal(resolveProductionVersion("1.2.3", "v1.2.3"), "1.2.3");
  assert.throws(() => resolveProductionVersion("1.2.3", "v1.2.4"), /does not match source version/);
  assert.throws(() => resolveProductionVersion("0.0.1", "v0.0.1"), /0\.0\.2 or newer/);
});

test("increments the registry staging sequence and keeps same-commit retries idempotent", () => {
  const publishedVersions = ["0.0.1", "0.0.2-staging.42.1", "0.0.2-staging.48.1", "0.0.2-staging.48.2"];
  assert.equal(findLatestStagingVersion("0.0.1", publishedVersions), "0.0.2-staging.48.2");
  assert.equal(
    resolveNextPublishedStagingVersion({
      sourceVersion: "0.0.1",
      publishedVersions,
      latestGitHead: "newer-commit",
      releaseGitHead: "next-commit",
      runAttempt: "1",
    }),
    "0.0.2-staging.49.1",
  );
  assert.equal(
    resolveNextPublishedStagingVersion({
      sourceVersion: "0.0.1",
      publishedVersions,
      latestGitHead: "next-commit",
      releaseGitHead: "next-commit",
      runAttempt: "2",
    }),
    "0.0.2-staging.48.2",
  );
});

test("starts a new staging release line at one and rejects registry lines ahead of source", () => {
  assert.equal(
    resolveNextPublishedStagingVersion({
      sourceVersion: "0.0.2",
      publishedVersions: ["0.0.1", "0.0.2-staging.48.1"],
      releaseGitHead: "next-commit",
      runAttempt: "3",
    }),
    "0.0.3-staging.1.3",
  );
  assert.throws(() => findLatestStagingVersion("0.0.1", ["0.0.3-staging.1.1"]), /ahead of the target release line/);
  assert.throws(() => findLatestStagingVersion("0.0.1", ["0.0.2"]), /not below the target staging release line/);
});

test("rejects stale staging revisions before an old run can publish", () => {
  assert.doesNotThrow(() => assertCurrentStagingRevision("current-commit", "current-commit"));
  assert.throws(
    () => assertCurrentStagingRevision("old-commit", "current-commit"),
    /old-commit is stale; current origin\/main is current-commit/,
  );
});

test("classifies staging registry version and metadata lookups", () => {
  assert.deepEqual(
    classifyPublishedVersionsLookup({ status: 0, stdout: '["0.0.1","0.0.2-staging.1.1"]', stderr: "" }),
    ["0.0.1", "0.0.2-staging.1.1"],
  );
  assert.deepEqual(classifyPublishedVersionsLookup({ status: 1, stdout: "", stderr: "npm error code E404" }), []);
  assert.deepEqual(
    classifyPublishedMetadataLookup({
      status: 0,
      stdout: '{"version":"0.0.2-staging.1.1","gitHead":"commit"}',
      stderr: "",
      expectedVersion: "0.0.2-staging.1.1",
    }),
    { version: "0.0.2-staging.1.1", gitHead: "commit" },
  );
  assert.throws(
    () => classifyPublishedVersionsLookup({ status: 1, stdout: "", stderr: "ECONNRESET" }),
    /versions lookup failed/,
  );
});

test("rewrites the staging identity without losing release metadata", async () => {
  await withManifest(sourceManifest, async (manifestPath) => {
    await prepareCliRelease({ channel: "staging", version: "0.0.2-staging.0.0", manifestPath });
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

    assert.equal(manifest.name, "open-tag-staging");
    assert.equal(manifest.version, "0.0.2-staging.0.0");
    assert.deepEqual(manifest.bin, { "opentag-staging": "./dist/cli/index.mjs" });
    assert.equal(manifest.private, undefined);
    assert.equal(manifest.license, "Apache-2.0");
    assert.equal(manifest.repository.url, sourceManifest.repository.url);
    assert.deepEqual(manifest.devDependencies, { commander: "^13.1.0", ws: "^8.21.3" });
  });
});

test("rejects an unsafe source identity and invalid staging coordinates", async () => {
  await withManifest({ ...sourceManifest, name: "open-tag-staging" }, async (manifestPath) => {
    await assert.rejects(
      prepareCliRelease({ channel: "staging", version: "0.0.2-staging.1.1", manifestPath }),
      /source package name/,
    );
  });
  await withManifest(sourceManifest, async (manifestPath) => {
    await assert.rejects(
      prepareCliRelease({ channel: "staging", version: "0.0.1-staging.1.1", manifestPath }),
      /staging version must match/,
    );
  });
  await withManifest(
    { ...sourceManifest, dependencies: { "@opentag/client": "workspace:*" } },
    async (manifestPath) => {
      await assert.rejects(
        prepareCliRelease({ channel: "staging", version: "0.0.2-staging.1.1", manifestPath }),
        /private runtime dependency/,
      );
    },
  );
});

test("keeps production publishing at a matching stable source version", async () => {
  await withManifest({ ...sourceManifest, version: "0.0.2" }, async (manifestPath) => {
    await prepareCliRelease({ channel: "prod", version: "0.0.2", manifestPath });
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

    assert.equal(manifest.name, "open-tag");
    assert.deepEqual(manifest.bin, { opentag: "./dist/cli/index.mjs" });
    assert.equal(manifest.private, undefined);
  });
});

test("classifies npm registry lookups without treating errors as absence", () => {
  assert.deepEqual(
    classifyRegistryLookup({ status: 1, stdout: "", stderr: "npm error code E404", expectedGitHead: "abc" }),
    { publish: true },
  );
  assert.deepEqual(
    classifyRegistryLookup({
      status: 0,
      stdout: '{"gitHead":"abc"}',
      stderr: "",
      expectedGitHead: "abc",
    }),
    { publish: false },
  );
  assert.throws(
    () =>
      classifyRegistryLookup({
        status: 0,
        stdout: '{"gitHead":"other"}',
        stderr: "",
        expectedGitHead: "abc",
      }),
    /expected "abc"/,
  );
  assert.throws(
    () => classifyRegistryLookup({ status: 1, stdout: "", stderr: "ECONNRESET", expectedGitHead: "abc" }),
    /registry lookup failed/,
  );
});

test("generates complete notices for bundled CLI dependencies", async () => {
  const notices = await generateThirdPartyNotices();

  for (const packageName of [
    "@pinojs/redact",
    "atomic-sleep",
    "commander",
    "on-exit-leak-free",
    "pino",
    "pino-std-serializers",
    "quick-format-unescaped",
    "safe-stable-stringify",
    "sonic-boom",
    "thread-stream",
    "ws",
    "zod",
  ]) {
    assert.match(notices, new RegExp(`^## ${packageName.replace("/", "\\/")}@\\d+\\.\\d+\\.\\d+$`, "m"));
  }
  assert.match(notices, /Copyright \(c\) 2011 TJ Holowaychuk/);
  assert.match(notices, /Copyright \(c\) 2011 Einar Otto Stangvik/);
  assert.match(notices, /Copyright \(c\) 2025 Colin McDonnell/);
  assert.equal((notices.match(/Permission is hereby granted/g) ?? []).length, 12);
});

test("orders stable and staging release versions on one scale", () => {
  assert.equal(compareReleaseVersions("1.2.3", "1.2.3"), 0);
  assert.equal(compareReleaseVersions("1.2.4", "1.2.3"), 1);
  assert.equal(compareReleaseVersions("1.2.3", "1.3.0"), -1);
  assert.equal(compareReleaseVersions("2.0.0", "1.99.99"), 1);
  // A staging prerelease orders below the stable release it leads to, matching semver.
  assert.equal(compareReleaseVersions("0.0.2-staging.9.1", "0.0.2"), -1);
  assert.equal(compareReleaseVersions("0.0.2", "0.0.2-staging.9.1"), 1);
  // Sequence outranks attempt, and both compare numerically rather than lexically.
  assert.equal(compareReleaseVersions("0.0.2-staging.10.1", "0.0.2-staging.9.1"), 1);
  assert.equal(compareReleaseVersions("0.0.2-staging.9.2", "0.0.2-staging.9.1"), 1);
  assert.equal(compareReleaseVersions("0.0.2-staging.9.1", "0.0.2-staging.9.1"), 0);
  assert.throws(() => compareReleaseVersions("1.2", "1.2.3"), /semantic version/);
});

test("npm dist-tag only advances latest on a forward move", () => {
  // A first publish has no channel head to protect.
  assert.equal(resolveDistTag({ publishedLatest: undefined, version: "1.0.0" }).tag, "latest");
  assert.equal(resolveDistTag({ publishedLatest: "1.2.0", version: "1.3.0" }).tag, "latest");
  // Republishing the same coordinate is idempotent, not a regression.
  assert.equal(resolveDistTag({ publishedLatest: "1.3.0", version: "1.3.0" }).tag, "latest");
  // An older release still publishes, but must not drag latest backwards: npm and the portable
  // channel pointer would otherwise advertise different versions.
  const superseded = resolveDistTag({ publishedLatest: "1.3.0", version: "1.2.0" });
  assert.equal(superseded.tag, SUPERSEDED_DIST_TAG);
  assert.match(superseded.reason, /newer than 1\.2\.0/);
  assert.equal(resolveDistTag({ publishedLatest: "0.0.2", version: "0.0.2-staging.9.1" }).tag, SUPERSEDED_DIST_TAG);
});

test("classifies npm dist-tag lookups without mistaking absence for failure", () => {
  assert.deepEqual(classifyDistTagLookup({ status: 0, stdout: '"1.2.3"\n', stderr: "" }), {
    published: true,
    version: "1.2.3",
  });
  // An unpublished package, and a published package with no latest tag, both mean "no head yet".
  assert.deepEqual(classifyDistTagLookup({ status: 1, stdout: "", stderr: "npm error code E404" }), {
    published: false,
  });
  assert.deepEqual(classifyDistTagLookup({ status: 0, stdout: "\n", stderr: "" }), { published: false });
  // A registry error must never be read as absence, which would move latest onto an older release.
  assert.throws(
    () => classifyDistTagLookup({ status: 1, stdout: "", stderr: "ETIMEDOUT" }),
    /npm dist-tag lookup failed/,
  );
  assert.throws(() => classifyDistTagLookup({ status: 0, stdout: "{oops", stderr: "" }), /invalid JSON/);
});
