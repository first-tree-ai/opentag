import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { assertExpectedBillingRevision, BILLING_REVISION_LABEL, readImageBillingRevision } from "../image-billing.mjs";

const IMAGE = "ghcr.io/first-tree-ai/opentag";
const REFERENCE = "c".repeat(40);
const BILLING_SHA = "b".repeat(40);

function blob(value) {
  const bytes = Buffer.from(JSON.stringify(value));
  return { bytes, digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}` };
}

function configBlob(labels) {
  return blob({ architecture: "amd64", os: "linux", config: { Labels: labels } });
}

function platformManifest(config) {
  return blob({
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    config: { mediaType: "application/vnd.oci.image.config.v1+json", digest: config.digest },
    layers: [],
  });
}

/** A BuildKit-shaped index: platform manifests plus an `unknown/unknown` attestation manifest. */
function imageIndex(manifests) {
  const attestation = blob({ schemaVersion: 2, config: { digest: `sha256:${"9".repeat(64)}` } });
  return blob({
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.index.v1+json",
    manifests: [
      ...manifests.map(({ manifest, architecture = "amd64" }) => ({
        digest: manifest.digest,
        platform: { os: "linux", architecture },
      })),
      {
        digest: attestation.digest,
        platform: { os: "unknown", architecture: "unknown" },
        annotations: { "vnd.docker.reference.type": "attestation-manifest" },
      },
    ],
  });
}

function response(status, bytes = Buffer.alloc(0), headers = {}) {
  const lookup = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => lookup.get(name.toLowerCase()) ?? null },
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    json: async () => JSON.parse(bytes.toString("utf8")),
  };
}

/** Serves `objects` by path, behind the anonymous Bearer challenge GHCR uses. */
function registry(objects, { authenticate = true } = {}) {
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push(url);
    if (url.startsWith("https://ghcr.io/token")) return response(200, Buffer.from(JSON.stringify({ token: "t" })));
    if (authenticate && options.headers?.authorization !== "Bearer t") {
      return response(401, undefined, {
        "www-authenticate": 'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:x:pull"',
      });
    }
    const path = decodeURIComponent(new URL(url).pathname.replace("/v2/first-tree-ai/opentag/", ""));
    const bytes = objects.get(path);
    return bytes ? response(200, bytes) : response(404);
  };
  return { fetchImpl, requests };
}

function publish({ labelsPerPlatform, single = false }) {
  const objects = new Map();
  const manifests = labelsPerPlatform.map((labels, index) => {
    const config = configBlob(labels);
    const manifest = platformManifest(config);
    objects.set(`blobs/${config.digest}`, config.bytes);
    objects.set(`manifests/${manifest.digest}`, manifest.bytes);
    return { manifest, architecture: index === 0 ? "amd64" : "arm64" };
  });
  const top = single ? manifests[0].manifest : imageIndex(manifests);
  objects.set(`manifests/${REFERENCE}`, top.bytes);
  return objects;
}

const read = (objects, options) =>
  readImageBillingRevision({ image: IMAGE, reference: REFERENCE, ...registry(objects, options) });

test("a cloud image reports its bundled billing revision through the index, skipping attestations", async () => {
  const objects = publish({ labelsPerPlatform: [{ [BILLING_REVISION_LABEL]: BILLING_SHA }] });
  const fake = registry(objects);
  assert.equal(await readImageBillingRevision({ image: IMAGE, reference: REFERENCE, ...fake }), BILLING_SHA);
  assert.equal(fake.requests.filter((url) => url.includes("/token")).length, 1, "one Bearer token is reused");
  assert.ok(!fake.requests.some((url) => url.includes("9".repeat(64))), "attestation manifests are not read");
});

test("an ordinary image, with no label or an empty one, reports no billing", async () => {
  assert.equal(await read(publish({ labelsPerPlatform: [{ "org.opencontainers.image.revision": REFERENCE }] })), null);
  assert.equal(await read(publish({ labelsPerPlatform: [{ [BILLING_REVISION_LABEL]: "" }] })), null);
  assert.equal(await read(publish({ labelsPerPlatform: [{}], single: true }), { authenticate: false }), null);
});

test("every platform must agree, and a malformed label is never taken at face value", async () => {
  await assert.rejects(
    read(publish({ labelsPerPlatform: [{ [BILLING_REVISION_LABEL]: BILLING_SHA }, {}] })),
    /platforms disagree/,
  );
  await assert.rejects(read(publish({ labelsPerPlatform: [{ [BILLING_REVISION_LABEL]: "main" }] })), /full commit SHA/);
});

test("content that does not match its digest, or a missing image, cannot prove a capability", async () => {
  const objects = publish({ labelsPerPlatform: [{ [BILLING_REVISION_LABEL]: BILLING_SHA }] });
  const configPath = [...objects.keys()].find((key) => key.startsWith("blobs/"));
  objects.set(configPath, configBlob({}).bytes);
  await assert.rejects(read(objects), /does not match its digest/);

  await assert.rejects(read(new Map()), /failed with status 404/);

  const unreachable = async () => {
    throw new TypeError("fetch failed");
  };
  await assert.rejects(
    readImageBillingRevision({ image: IMAGE, reference: REFERENCE, fetchImpl: unreachable }),
    /could not reach ghcr\.io/,
  );
});

test("expectations compare the published capability exactly", () => {
  assertExpectedBillingRevision(null, undefined);
  assertExpectedBillingRevision(BILLING_SHA, undefined);
  assertExpectedBillingRevision(null, "none");
  assertExpectedBillingRevision(BILLING_SHA, BILLING_SHA);
  assert.throws(() => assertExpectedBillingRevision(BILLING_SHA, "none"), /expected none/);
  assert.throws(() => assertExpectedBillingRevision(null, BILLING_SHA), /capability is none/);
  assert.throws(() => assertExpectedBillingRevision(null, "main"), /--expect must be/);
});
