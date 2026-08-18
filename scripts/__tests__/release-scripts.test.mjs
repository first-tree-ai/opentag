import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { classifyRegistryLookup } from "../check-npm-version.mjs";
import { prepareCliRelease } from "../prepare-cli-release.mjs";
import { resolveProductionVersion, resolveStagingVersion } from "../release-versions.mjs";
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
  assert.equal(resolveStagingVersion("0.0.1", "42", "3"), "0.0.2-staging.42.3");
  assert.equal(resolveProductionVersion("1.2.3", "v1.2.3"), "1.2.3");
  assert.throws(() => resolveProductionVersion("1.2.3", "v1.2.4"), /does not match source version/);
  assert.throws(() => resolveProductionVersion("0.0.1", "v0.0.1"), /0\.0\.2 or newer/);
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

  assert.match(notices, /^## commander@\d+\.\d+\.\d+$/m);
  assert.match(notices, /^## ws@\d+\.\d+\.\d+$/m);
  assert.match(notices, /^## zod@\d+\.\d+\.\d+$/m);
  assert.match(notices, /Copyright \(c\) 2011 TJ Holowaychuk/);
  assert.match(notices, /Copyright \(c\) 2011 Einar Otto Stangvik/);
  assert.match(notices, /Copyright \(c\) 2025 Colin McDonnell/);
  assert.equal((notices.match(/Permission is hereby granted/g) ?? []).length, 3);
});
