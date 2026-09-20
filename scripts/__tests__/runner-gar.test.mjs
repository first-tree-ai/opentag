import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  lookupRunnerTag,
  parseGarRepository,
  RUNNER_LABELS,
  readGcloudAccessToken,
  verifyRunnerIdentity,
} from "../runner/gar.mjs";

const HOST = "us-west1-docker.pkg.dev";
const PATH = "opentag-test/runners/opentag-runner";
const IMAGE = `${HOST}/${PATH}`;
const VERSION = "0.0.6-staging.30.1";
const SHA = "a".repeat(40);

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function labels(overrides = {}) {
  return {
    [RUNNER_LABELS.channel]: "staging",
    [RUNNER_LABELS.version]: VERSION,
    [RUNNER_LABELS.revision]: SHA,
    [RUNNER_LABELS.sourceDirty]: "false",
    ...overrides,
  };
}

/** Builds a digest-consistent fake registry: config, manifest, optional index, and a router. */
function garFixture({ labelOverrides, arch = "amd64", os = "linux", useIndex = false, extraPlatforms = [] } = {}) {
  const configBytes = Buffer.from(
    JSON.stringify({ architecture: arch, os, config: { Labels: labels(labelOverrides) } }),
  );
  const configDigest = sha256(configBytes);
  const manifestBytes = Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      config: { digest: configDigest, size: configBytes.length },
      layers: [],
    }),
  );
  const manifestDigest = sha256(manifestBytes);
  let rootBytes = manifestBytes;
  let rootType = "application/vnd.oci.image.manifest.v1+json";
  if (useIndex) {
    rootType = "application/vnd.oci.image.index.v1+json";
    rootBytes = Buffer.from(
      JSON.stringify({
        schemaVersion: 2,
        mediaType: rootType,
        manifests: [
          ...extraPlatforms,
          { digest: manifestDigest, size: manifestBytes.length, platform: { os: "linux", architecture: "amd64" } },
        ],
      }),
    );
  }
  const routes = new Map([
    [`https://${HOST}/v2/${PATH}/manifests/${VERSION}`, { digest: sha256(rootBytes), bytes: rootBytes, rootType }],
    [`https://${HOST}/v2/${PATH}/manifests/${manifestDigest}`, { digest: manifestDigest, bytes: manifestBytes }],
    [`https://${HOST}/v2/${PATH}/blobs/${configDigest}`, { digest: configDigest, bytes: configBytes }],
  ]);
  return { rootDigest: sha256(rootBytes), routes };
}

function fakeFetch(routes, { status = 200, digestOverride, mutate } = {}) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    const route = routes.get(url.replace(/%3A/gi, ":"));
    if (!route) {
      return { status: 404, headers: new Headers(), arrayBuffer: async () => new ArrayBuffer(0) };
    }
    if (status !== 200) {
      return { status, headers: new Headers(), arrayBuffer: async () => new ArrayBuffer(0) };
    }
    const bytes = mutate ? mutate(route.bytes) : route.bytes;
    const headers = new Headers({ "docker-content-digest": digestOverride ?? route.digest });
    if (route.rootType) headers.set("content-type", route.rootType);
    return {
      status: 200,
      headers,
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length),
    };
  };
  return { calls, fetchImpl };
}

const repository = { host: HOST, path: PATH, repository: IMAGE };
const expected = { channel: "staging", version: VERSION, sourceSha: SHA };

test("parseGarRepository accepts only untagged Artifact Registry repositories", () => {
  assert.deepEqual(parseGarRepository(IMAGE), { host: HOST, path: PATH, repository: IMAGE });
  assert.throws(() => parseGarRepository("ghcr.io/first-tree-ai/opentag"), /docker\.pkg\.dev/);
  assert.throws(() => parseGarRepository(`${IMAGE}:${VERSION}`), /untagged/);
  assert.throws(() => parseGarRepository(`${IMAGE}@sha256:${"b".repeat(64)}`), /untagged/);
  assert.throws(() => parseGarRepository("opentag-runner"), /untagged|docker\.pkg\.dev/);
});

test("lookupRunnerTag resolves a present tag with its verified digest", async () => {
  const { rootDigest, routes } = garFixture();
  const { fetchImpl } = fakeFetch(routes);
  const result = await lookupRunnerTag({ repository, tag: VERSION, accessToken: "token", fetchImpl });
  assert.equal(result.present, true);
  assert.equal(result.digest, rootDigest);
});

test("lookupRunnerTag sends the gcloud token as HTTP Basic and never follows redirects", async () => {
  const { routes } = garFixture();
  const { calls, fetchImpl } = fakeFetch(routes);
  await lookupRunnerTag({ repository, tag: VERSION, accessToken: "secret-token", fetchImpl });
  const auth = calls[0].options.headers.authorization;
  assert.equal(Buffer.from(auth.replace("Basic ", ""), "base64").toString(), "oauth2accesstoken:secret-token");
  assert.equal(calls[0].options.redirect, "manual");

  const redirectFetch = async () => ({ status: 302, headers: new Headers({ location: "https://evil.example" }) });
  await assert.rejects(
    lookupRunnerTag({ repository, tag: VERSION, accessToken: "t", fetchImpl: redirectFetch }),
    /redirect/,
  );
});

test("lookupRunnerTag treats only 404 as absence; auth and server failures are inconclusive", async () => {
  const { routes } = garFixture();
  const absent = await lookupRunnerTag({
    repository,
    tag: VERSION,
    accessToken: "t",
    fetchImpl: fakeFetch(routes, { status: 404 }).fetchImpl,
  });
  assert.deepEqual(absent, { present: false });
  for (const status of [401, 403, 429, 500, 502, 503]) {
    await assert.rejects(
      lookupRunnerTag({
        repository,
        tag: VERSION,
        accessToken: "t",
        fetchImpl: fakeFetch(routes, { status }).fetchImpl,
      }),
      /inconclusive/,
      `status ${status} must not read as absence`,
    );
  }
});

test("lookupRunnerTag rejects a digest header that does not match the downloaded bytes", async () => {
  const { routes } = garFixture();
  await assert.rejects(
    lookupRunnerTag({
      repository,
      tag: VERSION,
      accessToken: "t",
      fetchImpl: fakeFetch(routes, { digestOverride: `sha256:${"0".repeat(64)}` }).fetchImpl,
    }),
    /do not match/,
  );
  const noDigest = async (_url) => ({
    status: 200,
    headers: new Headers(),
    arrayBuffer: async () => new ArrayBuffer(0),
  });
  await assert.rejects(
    lookupRunnerTag({ repository, tag: VERSION, accessToken: "t", fetchImpl: noDigest }),
    /Docker-Content-Digest/,
  );
});

test("verifyRunnerIdentity accepts a docker-produced single manifest image", async () => {
  const { rootDigest, routes } = garFixture();
  const { fetchImpl } = fakeFetch(routes);
  const result = await verifyRunnerIdentity({
    repository,
    root: { digest: rootDigest, bytes: routes.get(`https://${HOST}/v2/${PATH}/manifests/${VERSION}`).bytes },
    expected,
    accessToken: "t",
    fetchImpl,
  });
  assert.deepEqual(result, { digest: rootDigest });
});

test("verifyRunnerIdentity walks an OCI index and ignores non-amd64 attestations", async () => {
  const { rootDigest, routes } = garFixture({
    useIndex: true,
    extraPlatforms: [{ digest: `sha256:${"f".repeat(64)}`, platform: { os: "unknown", architecture: "unknown" } }],
  });
  const { fetchImpl } = fakeFetch(routes);
  const result = await verifyRunnerIdentity({
    repository,
    root: {
      digest: rootDigest,
      bytes: routes.get(`https://${HOST}/v2/${PATH}/manifests/${VERSION}`).bytes,
      contentType: "application/vnd.oci.image.index.v1+json",
    },
    expected,
    accessToken: "t",
    fetchImpl,
  });
  assert.deepEqual(result, { digest: rootDigest });
});

test("verifyRunnerIdentity rejects the wrong channel, version, source, dirty source, or arch", async () => {
  const cases = [
    [{ [RUNNER_LABELS.channel]: "prod" }, /channel/],
    [{ [RUNNER_LABELS.version]: "0.0.6-staging.31.1" }, /version/],
    [{ [RUNNER_LABELS.revision]: "b".repeat(40) }, /revision/],
    [{ [RUNNER_LABELS.sourceDirty]: "true" }, /source\.dirty/],
  ];
  for (const [overrides, pattern] of cases) {
    const { rootDigest, routes } = garFixture({ labelOverrides: overrides });
    await assert.rejects(
      verifyRunnerIdentity({
        repository,
        root: { digest: rootDigest, bytes: routes.get(`https://${HOST}/v2/${PATH}/manifests/${VERSION}`).bytes },
        expected,
        accessToken: "t",
        fetchImpl: fakeFetch(routes).fetchImpl,
      }),
      pattern,
    );
  }
  const arm = garFixture({ arch: "arm64" });
  await assert.rejects(
    verifyRunnerIdentity({
      repository,
      root: { digest: arm.rootDigest, bytes: arm.routes.get(`https://${HOST}/v2/${PATH}/manifests/${VERSION}`).bytes },
      expected,
      accessToken: "t",
      fetchImpl: fakeFetch(arm.routes).fetchImpl,
    }),
    /linux\/amd64/,
  );
});

test("verifyRunnerIdentity rejects a tampered config blob (digest mismatch)", async () => {
  const { rootDigest, routes } = garFixture();
  const { fetchImpl } = fakeFetch(routes, {
    mutate: (bytes) => {
      const copy = Buffer.from(bytes);
      copy[copy.length - 2] = copy[copy.length - 2] ^ 1;
      return copy;
    },
  });
  await assert.rejects(
    verifyRunnerIdentity({
      repository,
      root: { digest: rootDigest, bytes: routes.get(`https://${HOST}/v2/${PATH}/manifests/${VERSION}`).bytes },
      expected,
      accessToken: "t",
      fetchImpl,
    }),
    /do not match|not valid JSON/,
  );
});

test("readGcloudAccessToken captures the token in memory and never leaks it into errors", async () => {
  const ok = await readGcloudAccessToken({ runCommand: async () => ({ status: 0, stdout: "  token-abc\n" }) });
  assert.equal(ok, "token-abc");
  await assert.rejects(
    readGcloudAccessToken({ runCommand: async () => ({ status: 1, stdout: "token-abc", stderr: "unauthorized" }) }),
    (error) => {
      assert.match(error.message, /no token was read/);
      assert.ok(!error.message.includes("token-abc"), "stdout (the token) must never appear in the error");
      return true;
    },
  );
  await assert.rejects(
    readGcloudAccessToken({ runCommand: async () => ({ status: 0, stdout: "has space inside\n" }) }),
    /no usable token/,
  );
});

test("config blob redirects stay on the GAR origin and never forward credentials", async () => {
  const { routes } = garFixture();
  const direct = fakeFetch(routes).fetchImpl;
  const blob = [...routes.keys()].find((url) => url.includes("/blobs/"));
  let redirected = 0;
  const fetchImpl = async (url, options) => {
    if (url.includes("/blobs/")) {
      return { status: 302, headers: new Headers({ location: "/download/config?signature=fixture" }) };
    }
    if (url.includes("/download/")) {
      redirected += 1;
      assert.equal(options.headers, undefined);
      assert.equal(options.redirect, "manual");
      return direct(blob, options);
    }
    return direct(url, options);
  };
  const root = await lookupRunnerTag({ repository, tag: VERSION, accessToken: "secret", fetchImpl });
  await verifyRunnerIdentity({ repository, root, expected, accessToken: "secret", fetchImpl });
  assert.equal(redirected, 1);
  for (const location of [
    "https://evil.example/config",
    "http://us-west1-docker.pkg.dev/config",
    "https://user:pw@us-west1-docker.pkg.dev/config",
  ]) {
    await assert.rejects(
      verifyRunnerIdentity({
        repository,
        root,
        expected,
        accessToken: "secret",
        fetchImpl: async () => ({ status: 302, headers: new Headers({ location }) }),
      }),
      /unsafe blob redirect/,
    );
  }
});
