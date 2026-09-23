import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { RUNNER_LABELS } from "../runner/gar.mjs";
import { publishRunnerRelease } from "../runner/release.mjs";
import {
  commandRecorder,
  garRouter,
  headerMap,
  IMAGE,
  OTHER_SHA,
  publishDeps,
  SHA,
  VERSION,
} from "./runner-release-fixtures.mjs";

test("publish reuses a verified existing tag without overwriting it", async () => {
  const gar = garRouter();
  const recorder = commandRecorder();
  const { deps, calls, root, outDir } = await publishDeps({
    fetchImpl: gar.fetchImpl,
    runCommand: recorder.runCommand,
  });
  try {
    const record = await publishRunnerRelease(deps);
    assert.equal(record.reused, true);
    assert.equal(record.image, `${IMAGE}@${gar.rootDigest}`);
    assert.equal(calls.filter(([name]) => name === "build").length, 0);
    assert.ok(
      !recorder.calls.some((call) => call[0] === "docker" && call[1] === "push"),
      "immutable retry must never push",
    );
    assert.ok(recorder.calls.some((call) => call.join(" ") === `docker pull ${IMAGE}@${gar.rootDigest}`));
    assert.deepEqual(
      calls.filter(([name]) => name === "smoke").map(([, args]) => args.image),
      [`${IMAGE}@${gar.rootDigest}`],
    );
    const written = JSON.parse(await readFile(deps.output, "utf8"));
    assert.deepEqual(written, {
      schemaVersion: 1,
      channel: "staging",
      version: VERSION,
      sourceSha: SHA,
      image: record.image,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outDir, { recursive: true, force: true });
  }
});

test("publish fails a tag claimed by a different commit and names the recovery", async () => {
  const gar = garRouter({ labelOverrides: { [RUNNER_LABELS.revision]: OTHER_SHA } });
  const recorder = commandRecorder();
  const { deps, root, outDir } = await publishDeps({
    fetchImpl: gar.fetchImpl,
    runCommand: recorder.runCommand,
  });
  try {
    await assert.rejects(
      publishRunnerRelease(deps),
      (error) => {
        assert.match(
          String(error?.message),
          /was claimed by a different release/,
          "the identity mismatch is reported as a claimed-version collision",
        );
        assert.match(
          String(error?.message),
          /staging version resolver steps over every Runner tag already in the registry/,
          "on staging the message points at the self-healing re-run, not a manual tag deletion",
        );
        assert.doesNotMatch(String(error?.message), /delete the exact/);
        assert.match(String(error?.message), /Never overwrite the existing tag/);
        assert.ok(error?.cause instanceof Error, "the underlying identity mismatch is preserved as the cause");
        return true;
      },
      "a claimed tag never falls through to an overwrite",
    );
    assert.ok(
      !recorder.calls.some((call) => call[0] === "docker"),
      "no docker pull/push happens for a mismatched existing tag",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outDir, { recursive: true, force: true });
  }
});

test("publish preserves an inconclusive registry failure without recovery guidance", async () => {
  const gar = garRouter();
  const fetchImpl = async (url, options) => {
    if (String(url).includes("/blobs/")) {
      return { status: 503, headers: headerMap({}), arrayBuffer: async () => new ArrayBuffer(0) };
    }
    return gar.fetchImpl(url, options);
  };
  const recorder = commandRecorder();
  const { deps, root, outDir } = await publishDeps({ fetchImpl, runCommand: recorder.runCommand });
  try {
    await assert.rejects(
      publishRunnerRelease(deps),
      (error) => {
        assert.match(
          String(error?.message),
          /registry blobs fetch of .* failed with status 503/,
          "the original inconclusive fetch failure is preserved unchanged",
        );
        assert.doesNotMatch(
          String(error?.message),
          /Manual recovery|quarantine|delete the exact/,
          "an inconclusive read never prescribes a destructive recovery",
        );
        return true;
      },
      "a transient registry failure stays fail-closed without recovery instructions",
    );
    assert.ok(
      !recorder.calls.some((call) => call[0] === "docker"),
      "no docker pull/push happens for an inconclusive registry read",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outDir, { recursive: true, force: true });
  }
});

test("publish builds, smokes, pushes, and re-verifies an absent tag", async () => {
  let tagReads = 0;
  const gar = garRouter();
  const fetchImpl = async (url, options) => {
    if (url.endsWith(`/manifests/${VERSION}`)) {
      tagReads += 1;
      if (tagReads === 1) return { status: 404, headers: headerMap({}), arrayBuffer: async () => new ArrayBuffer(0) };
    }
    return gar.fetchImpl(url, options);
  };
  const recorder = commandRecorder();
  const { deps, calls, root, outDir } = await publishDeps({ fetchImpl, runCommand: recorder.runCommand });
  try {
    const record = await publishRunnerRelease(deps);
    assert.equal(record.reused, false);
    const build = calls.find(([name]) => name === "build");
    assert.equal(build[1].allowDirty, false, "publish never builds dirty");
    assert.equal(build[1].version, VERSION);
    assert.equal(build[1].tag, `${IMAGE}:${VERSION}`);
    const order = calls.map(([name]) => name);
    assert.deepEqual(order, ["build", "smoke"]);
    assert.deepEqual(calls[1][1].image, `${IMAGE}:${VERSION}`, "smoke runs before the push, on the local tag");
    assert.ok(recorder.calls.some((call) => call.join(" ") === `docker push ${IMAGE}:${VERSION}`));
    assert.equal(tagReads, 2, "the registry is re-read after the push");
    assert.equal(record.image, `${IMAGE}@${gar.rootDigest}`);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outDir, { recursive: true, force: true });
  }
});

test("publish rejects a source SHA that is not HEAD and a dirty checkout", async () => {
  const {
    deps: shaDeps,
    root: r1,
    outDir: o1,
  } = await publishDeps({
    fetchImpl: async () => assert.fail("no registry call before source validation"),
    readSource: () => ({ sourceSha: OTHER_SHA, sourceDirty: false, cliVersion: "0.0.5" }),
  });
  try {
    await assert.rejects(publishRunnerRelease(shaDeps), /does not match HEAD/);
  } finally {
    await rm(r1, { recursive: true, force: true });
    await rm(o1, { recursive: true, force: true });
  }
  const {
    deps: dirtyDeps,
    root: r2,
    outDir: o2,
  } = await publishDeps({
    fetchImpl: async () => assert.fail("no registry call before source validation"),
    readSource: () => ({ sourceSha: SHA, sourceDirty: true, cliVersion: "0.0.5" }),
  });
  try {
    await assert.rejects(publishRunnerRelease(dirtyDeps), /dirty/);
  } finally {
    await rm(r2, { recursive: true, force: true });
    await rm(o2, { recursive: true, force: true });
  }
});

test("publish rejects a version outside the channel rules before any work", async () => {
  const { deps, root, outDir } = await publishDeps({
    version: "0.0.7-staging.1.1",
    fetchImpl: async () => assert.fail("no registry call before version validation"),
  });
  try {
    await assert.rejects(publishRunnerRelease(deps), /0\.0\.6-staging/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outDir, { recursive: true, force: true });
  }
  const {
    deps: prodDeps,
    root: r2,
    outDir: o2,
  } = await publishDeps({
    channel: "prod",
    version: "0.0.5",
    fetchImpl: async () => assert.fail("no registry call before version validation"),
    readSource: () => ({ sourceSha: SHA, sourceDirty: false, cliVersion: "0.0.6" }),
  });
  try {
    await assert.rejects(publishRunnerRelease(prodDeps), /must match source version/);
  } finally {
    await rm(r2, { recursive: true, force: true });
    await rm(o2, { recursive: true, force: true });
  }
});

test("publish refuses a non-GAR registry and an output inside the checkout", async () => {
  const { deps, root, outDir } = await publishDeps({ image: "ghcr.io/first-tree-ai/opentag-runner" });
  try {
    await assert.rejects(publishRunnerRelease(deps), /docker\.pkg\.dev/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outDir, { recursive: true, force: true });
  }
  const { deps: inside, root: r2, outDir: o2 } = await publishDeps();
  inside.output = join(r2, "runner-release.json");
  try {
    await assert.rejects(publishRunnerRelease(inside), /outside the source checkout/);
  } finally {
    await rm(r2, { recursive: true, force: true });
    await rm(o2, { recursive: true, force: true });
  }
});

test("publish never overwrites a tag whose labels name a different release", async () => {
  const gar = garRouter({ labelOverrides: { [RUNNER_LABELS.revision]: OTHER_SHA } });
  const recorder = commandRecorder();
  const { deps, root, outDir } = await publishDeps({ fetchImpl: gar.fetchImpl, runCommand: recorder.runCommand });
  try {
    await assert.rejects(publishRunnerRelease(deps), /revision/);
    assert.ok(!recorder.calls.some((call) => call[0] === "docker" && call[1] === "push"));
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outDir, { recursive: true, force: true });
  }
});

test("publish treats a registry 5xx as inconclusive, never as absence", async () => {
  const gar = garRouter({ tagStatus: 503 });
  const { deps, calls, root, outDir } = await publishDeps({ fetchImpl: gar.fetchImpl });
  try {
    await assert.rejects(publishRunnerRelease(deps), /inconclusive/);
    assert.equal(calls.filter(([name]) => name === "build").length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outDir, { recursive: true, force: true });
  }
});

test("a build failure leaves no output file behind", async () => {
  const gar = garRouter({ tagStatus: 404 });
  const { deps, root, outDir } = await publishDeps({
    fetchImpl: gar.fetchImpl,
    build: async () => {
      throw new Error("docker build exploded");
    },
  });
  try {
    await assert.rejects(publishRunnerRelease(deps), /exploded/);
    await assert.rejects(readFile(deps.output, "utf8"), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outDir, { recursive: true, force: true });
  }
});
