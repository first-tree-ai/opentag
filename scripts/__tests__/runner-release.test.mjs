import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { parseReleaseArgv, resolveRunnerRelease, writeGithubOutput } from "../runner/release.mjs";
import { formatReleaseRecord, writeReleaseRecord } from "../runner/release-record.mjs";
import {
  commandRecorder,
  garRouter,
  HOST,
  IMAGE,
  OTHER_SHA,
  PACKAGE,
  SHA,
  tempDir,
  VERSION,
} from "./runner-release-fixtures.mjs";

function npmViewFake(packument) {
  const calls = [];
  const npmView = async (args) => {
    calls.push(args);
    if (args[0] === PACKAGE && args[1] === "versions") {
      return { status: 0, stdout: JSON.stringify(Object.keys(packument)), stderr: "" };
    }
    const match = new RegExp(`^${PACKAGE}@(.+)$`).exec(args[0]);
    if (match && Object.hasOwn(packument, match[1])) {
      const gitHead = packument[match[1]];
      return gitHead
        ? { status: 0, stdout: JSON.stringify({ version: match[1], gitHead }), stderr: "" }
        : { status: 0, stdout: JSON.stringify({ version: match[1] }), stderr: "" };
    }
    return { status: 1, stdout: "", stderr: "npm error code E404" };
  };
  return {
    calls,
    npmView,
    npmVersions: async () => Object.entries(packument).map(([version, gitHead]) => ({ version, gitHead })),
  };
}

async function resolveDeps(overrides = {}) {
  const root = await tempDir("opentag-checkout-");
  const outDir = await tempDir("opentag-resolve-out-");
  const gar = garRouter();
  const deps = {
    image: IMAGE,
    channel: "staging",
    output: join(outDir, "runner-target.json"),
    repositoryRoot: root,
    fetchImpl: gar.fetchImpl,
    runCommand: commandRecorder().runCommand,
    npmView: npmViewFake({ [VERSION]: SHA }).npmView,
    ...overrides,
  };
  return { deps, gar, root, outDir };
}

test("resolve verifies metadata against npm gitHead and the registry", async () => {
  const { deps, gar, root, outDir } = await resolveDeps();
  const metadataPath = join(outDir, "metadata.json");
  await writeReleaseRecord(
    metadataPath,
    formatReleaseRecord({
      channel: "staging",
      version: VERSION,
      sourceSha: SHA,
      repository: IMAGE,
      digest: gar.rootDigest,
    }),
  );
  try {
    const record = await resolveRunnerRelease({ ...deps, metadata: metadataPath, sourceSha: SHA });
    assert.deepEqual(record, {
      schemaVersion: 1,
      channel: "staging",
      version: VERSION,
      sourceSha: SHA,
      image: `${IMAGE}@${gar.rootDigest}`,
    });
    const written = JSON.parse(await readFile(deps.output, "utf8"));
    assert.deepEqual(written, record);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outDir, { recursive: true, force: true });
  }
});

test("resolve rejects metadata that disagrees with the request or the registry", async () => {
  const { deps, gar, root, outDir } = await resolveDeps();
  const write = async (overrides) => {
    const path = join(outDir, `metadata-${Math.random().toString(36).slice(2)}.json`);
    await writeFile(
      path,
      JSON.stringify(
        formatReleaseRecord({
          channel: "staging",
          version: VERSION,
          sourceSha: SHA,
          repository: IMAGE,
          digest: gar.rootDigest,
          ...overrides,
        }),
      ),
    );
    return path;
  };
  try {
    await assert.rejects(
      resolveRunnerRelease({ ...deps, metadata: await write({ channel: "prod", version: "0.0.5" }) }),
      /channel/,
    );
    await assert.rejects(
      resolveRunnerRelease({ ...deps, metadata: await write({ repository: `${HOST}/other/repo/image` }) }),
      /image repository/,
    );
    await assert.rejects(
      resolveRunnerRelease({ ...deps, version: "0.0.6-staging.31.1", metadata: await write({}) }),
      /metadata version/,
    );
    await assert.rejects(
      resolveRunnerRelease({ ...deps, metadata: await write({ digest: `sha256:${"0".repeat(64)}` }) }),
      /does not match release metadata digest/,
    );
    await assert.rejects(
      resolveRunnerRelease({ ...deps, metadata: await write({ sourceSha: OTHER_SHA }) }),
      /npm gitHead/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outDir, { recursive: true, force: true });
  }
});

test("resolve with an explicit version takes the source from npm gitHead and verifies the registry", async () => {
  const { deps, gar, root, outDir } = await resolveDeps();
  try {
    const record = await resolveRunnerRelease({ ...deps, version: VERSION });
    assert.equal(record.sourceSha, SHA);
    assert.equal(record.image, `${IMAGE}@${gar.rootDigest}`);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outDir, { recursive: true, force: true });
  }
});

test("resolve with version and source-sha requires exact source equality", async () => {
  const { deps, root, outDir } = await resolveDeps();
  try {
    await assert.rejects(resolveRunnerRelease({ ...deps, version: VERSION, sourceSha: OTHER_SHA }), /npm gitHead/);
    const ok = await resolveRunnerRelease({ ...deps, version: VERSION, sourceSha: SHA });
    assert.equal(ok.version, VERSION);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outDir, { recursive: true, force: true });
  }
});

test("resolve by source-sha picks the highest channel version with a matching gitHead", async () => {
  const npm = npmViewFake({
    "0.0.6-staging.28.1": OTHER_SHA,
    "0.0.6-staging.29.1": SHA,
    "0.0.6-staging.30.1": SHA,
  });
  const { deps, root, outDir } = await resolveDeps({ npmView: npm.npmView, npmVersions: npm.npmVersions });
  try {
    const record = await resolveRunnerRelease({ ...deps, sourceSha: SHA });
    assert.equal(record.version, VERSION, "highest matching staging version wins");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outDir, { recursive: true, force: true });
  }
});

test("resolve by source-sha rejects absent matches and malformed packument data", async () => {
  const missing = npmViewFake({ [VERSION]: OTHER_SHA });
  const { deps, root, outDir } = await resolveDeps({ npmView: missing.npmView, npmVersions: missing.npmVersions });
  try {
    await assert.rejects(resolveRunnerRelease({ ...deps, sourceSha: SHA }), /no published staging version/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outDir, { recursive: true, force: true });
  }
  const malformed = npmViewFake({ "not-a-version": SHA });
  const {
    deps: badDeps,
    root: r2,
    outDir: o2,
  } = await resolveDeps({ npmView: malformed.npmView, npmVersions: malformed.npmVersions });
  try {
    await assert.rejects(resolveRunnerRelease({ ...badDeps, sourceSha: SHA }), /staging semantic version/);
  } finally {
    await rm(r2, { recursive: true, force: true });
    await rm(o2, { recursive: true, force: true });
  }
  const noHead = npmViewFake({ [VERSION]: null });
  const {
    deps: headDeps,
    root: r3,
    outDir: o3,
  } = await resolveDeps({ npmView: noHead.npmView, npmVersions: noHead.npmVersions });
  try {
    await assert.rejects(resolveRunnerRelease({ ...headDeps, version: VERSION }), /missing gitHead/);
  } finally {
    await rm(r3, { recursive: true, force: true });
    await rm(o3, { recursive: true, force: true });
  }
});

test("resolve fails closed when the registry tag is absent (incomplete release)", async () => {
  const gar = garRouter({ tagStatus: 404 });
  const { deps, root, outDir } = await resolveDeps({ fetchImpl: gar.fetchImpl });
  try {
    await assert.rejects(resolveRunnerRelease({ ...deps, version: VERSION }), /incomplete/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outDir, { recursive: true, force: true });
  }
});

test("parseReleaseArgv rejects unknown, duplicate, and valueless arguments", () => {
  assert.throws(
    () => parseReleaseArgv(["resolve", "--image", IMAGE, "--channel", "staging", "--output", "/tmp/x", "--wat", "1"]),
    /unknown argument/,
  );
  assert.throws(
    () =>
      parseReleaseArgv(["resolve", "--image", IMAGE, "--image", IMAGE, "--channel", "staging", "--output", "/tmp/x"]),
    /duplicate argument/,
  );
  assert.throws(() => parseReleaseArgv(["publish", "--image", IMAGE, "--channel"]), /requires a value/);
  assert.throws(
    () =>
      parseReleaseArgv([
        "publish",
        "--image",
        IMAGE,
        "--channel",
        "staging",
        "--version",
        VERSION,
        "--source-sha",
        SHA,
      ]),
    /--output is required/,
  );
});

test("resolve requires at least one release selector", async () => {
  const { deps, root, outDir } = await resolveDeps();
  try {
    await assert.rejects(resolveRunnerRelease(deps), /requires --version, --source-sha, or --metadata/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outDir, { recursive: true, force: true });
  }
});

test("writeGithubOutput emits the image, version, and source_sha keys", async () => {
  const dir = await tempDir("opentag-gh-out-");
  const path = join(dir, "github-output");
  const previous = process.env.GITHUB_OUTPUT;
  process.env.GITHUB_OUTPUT = path;
  try {
    await writeGithubOutput({ image: `${IMAGE}@sha256:${"1".repeat(64)}`, version: VERSION, sourceSha: SHA });
    const content = await readFile(path, "utf8");
    assert.match(content, /^image=us-west1-docker\.pkg\.dev\//m);
    assert.match(content, new RegExp(`^version=${VERSION.replaceAll(".", "\\.")}$`, "m"));
    assert.match(content, new RegExp(`^source_sha=${SHA}$`, "m"));
  } finally {
    if (previous === undefined) delete process.env.GITHUB_OUTPUT;
    else process.env.GITHUB_OUTPUT = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
