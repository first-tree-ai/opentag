import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyManifestLookup,
  parseAuthenticateChallenge,
  parseImageReference,
  resolveCoordinate,
} from "../registry-coordinate.mjs";
import { decideLatestPromotion, parseReleaseTag, selectGreaterReleases } from "../release-latest-pointer.mjs";

const DIGEST = `sha256:${"a".repeat(64)}`;

function response({ status, headers = {}, body = "", json }) {
  const lookup = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => lookup.get(name.toLowerCase()) ?? null },
    text: async () => body,
    json: async () => json,
  };
}

test("parseImageReference splits a fully qualified coordinate", () => {
  assert.deepEqual(parseImageReference("ghcr.io/first-tree-ai/opentag"), {
    registry: "ghcr.io",
    repository: "first-tree-ai/opentag",
  });
});

test("parseImageReference rejects an unqualified coordinate instead of defaulting a registry", () => {
  assert.throws(() => parseImageReference("first-tree-ai/opentag"), /fully qualified/);
  assert.throws(() => parseImageReference("opentag"), /fully qualified/);
});

test("classifyManifestLookup reports a published coordinate with its digest", () => {
  assert.deepEqual(classifyManifestLookup({ status: 200, digest: DIGEST }), { present: true, digest: DIGEST });
});

test("classifyManifestLookup reports only 404 as absence", () => {
  assert.deepEqual(classifyManifestLookup({ status: 404 }), { present: false, digest: null });
});

test("classifyManifestLookup refuses to treat a failure as absence", () => {
  for (const status of [401, 403, 429, 500, 502, 503]) {
    assert.throws(
      () => classifyManifestLookup({ status, body: "upstream unavailable" }),
      /inconclusive/,
      `status ${status} must not be read as absence`,
    );
  }
});

test("classifyManifestLookup rejects a success without a usable digest", () => {
  assert.throws(() => classifyManifestLookup({ status: 200, digest: null }), /Docker-Content-Digest/);
  assert.throws(() => classifyManifestLookup({ status: 200, digest: "sha256:short" }), /Docker-Content-Digest/);
});

test("parseAuthenticateChallenge reads realm, service, and scope", () => {
  assert.deepEqual(
    parseAuthenticateChallenge('Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:a/b:pull"'),
    { realm: "https://ghcr.io/token", service: "ghcr.io", scope: "repository:a/b:pull" },
  );
});

test("parseAuthenticateChallenge ignores a scheme it cannot satisfy", () => {
  assert.equal(parseAuthenticateChallenge('Basic realm="ghcr.io"'), null);
  assert.equal(parseAuthenticateChallenge(null), null);
});

test("resolveCoordinate answers a published coordinate directly", async () => {
  const result = await resolveCoordinate({
    image: "ghcr.io/first-tree-ai/opentag",
    reference: "1.2.3",
    fetchImpl: async () => response({ status: 200, headers: { "docker-content-digest": DIGEST } }),
  });
  assert.deepEqual(result, { present: true, digest: DIGEST });
});

test("resolveCoordinate exchanges a bearer challenge and retries once", async () => {
  const calls = [];
  const result = await resolveCoordinate({
    image: "ghcr.io/first-tree-ai/opentag",
    reference: "1.2.3",
    token: "gh-token",
    fetchImpl: async (url, options) => {
      calls.push({ url, authorization: options.headers?.authorization ?? null });
      if (calls.length === 1) {
        return response({
          status: 401,
          headers: { "www-authenticate": 'Bearer realm="https://ghcr.io/token",service="ghcr.io"' },
        });
      }
      if (calls.length === 2) {
        return response({ status: 200, json: { token: "issued" } });
      }
      return response({ status: 200, headers: { "docker-content-digest": DIGEST } });
    },
  });

  assert.deepEqual(result, { present: true, digest: DIGEST });
  assert.equal(calls.length, 3);
  assert.match(calls[1].url, /^https:\/\/ghcr\.io\/token\?/);
  assert.equal(calls[1].authorization, `Basic ${Buffer.from("x-access-token:gh-token").toString("base64")}`);
  assert.equal(calls[2].authorization, "Bearer issued");
});

test("resolveCoordinate surfaces a transport failure instead of reporting absence", async () => {
  await assert.rejects(
    resolveCoordinate({
      image: "ghcr.io/first-tree-ai/opentag",
      reference: "1.2.3",
      fetchImpl: async () => {
        throw new Error("ECONNRESET");
      },
    }),
    /could not reach ghcr\.io/,
  );
});

test("resolveCoordinate surfaces a registry fault instead of reporting absence", async () => {
  await assert.rejects(
    resolveCoordinate({
      image: "ghcr.io/first-tree-ai/opentag",
      reference: "1.2.3",
      fetchImpl: async () => response({ status: 503, body: "service unavailable" }),
    }),
    /inconclusive with status 503/,
  );
});

test("parseReleaseTag accepts only stable release tags", () => {
  assert.equal(parseReleaseTag("v1.2.3"), "1.2.3");
  assert.throws(() => parseReleaseTag("1.2.3"), /vX\.Y\.Z/);
  assert.throws(() => parseReleaseTag("v1.2.3-staging.1.1"), /vX\.Y\.Z/);
});

test("selectGreaterReleases ranks higher releases newest first and ignores other tags", () => {
  const greater = selectGreaterReleases("v1.2.3", [
    "v1.2.3",
    "v1.2.4",
    "v2.0.0",
    "v1.0.0",
    "v1.2.4-staging.1.1",
    "not-a-tag",
  ]);
  assert.deepEqual(
    greater.map((candidate) => candidate.tag),
    ["v2.0.0", "v1.2.4"],
  );
});

test("decideLatestPromotion promotes when no higher release is published", async () => {
  const decision = await decideLatestPromotion({
    currentTag: "v1.2.4",
    tags: ["v1.2.3", "v1.2.4"],
    isPublished: async () => assert.fail("no higher release should be queried"),
  });
  assert.deepEqual(decision, { promote: true, blockedBy: null });
});

test("decideLatestPromotion refuses to drag latest backwards", async () => {
  const queried = [];
  const decision = await decideLatestPromotion({
    currentTag: "v1.2.3",
    tags: ["v1.2.3", "v1.2.4"],
    isPublished: async (version) => {
      queried.push(version);
      return true;
    },
  });
  assert.deepEqual(decision, { promote: false, blockedBy: "v1.2.4" });
  assert.deepEqual(queried, ["1.2.4"]);
});

test("decideLatestPromotion is not blocked by a higher tag that never published", async () => {
  const decision = await decideLatestPromotion({
    currentTag: "v1.2.3",
    tags: ["v1.2.3", "v1.2.4", "v2.0.0"],
    isPublished: async () => false,
  });
  assert.deepEqual(decision, { promote: true, blockedBy: null });
});

test("decideLatestPromotion stops at the highest published release", async () => {
  const queried = [];
  const decision = await decideLatestPromotion({
    currentTag: "v1.0.0",
    tags: ["v1.0.0", "v1.1.0", "v2.0.0"],
    isPublished: async (version) => {
      queried.push(version);
      return version === "2.0.0";
    },
  });
  assert.deepEqual(decision, { promote: false, blockedBy: "v2.0.0" });
  assert.deepEqual(queried, ["2.0.0"]);
});

test("decideLatestPromotion propagates an inconclusive lookup rather than promoting", async () => {
  await assert.rejects(
    decideLatestPromotion({
      currentTag: "v1.2.3",
      tags: ["v1.2.4"],
      isPublished: async () => {
        throw new Error("registry manifest lookup was inconclusive with status 503");
      },
    }),
    /inconclusive/,
  );
});
