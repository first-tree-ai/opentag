import assert from "node:assert/strict";
import test from "node:test";
import { parseCommitList, resolveEdgeTarget } from "../edge-pointer.mjs";
import {
  classifyManifestLookup,
  parseAuthenticateChallenge,
  parseImageReference,
  resolveCoordinate,
  waitForCoordinate,
} from "../registry-coordinate.mjs";
import { parseReleaseTag, resolveLatestTarget, selectReleaseVersions } from "../release-latest-pointer.mjs";

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

test("waitForCoordinate returns as soon as the image is published", async () => {
  let calls = 0;
  const result = await waitForCoordinate({
    image: "ghcr.io/first-tree-ai/opentag",
    reference: "abc",
    lookup: async () => {
      calls += 1;
      return { present: true, digest: DIGEST };
    },
    pause: async () => assert.fail("must not wait once the image is published"),
  });
  assert.deepEqual(result, { present: true, digest: DIGEST });
  assert.equal(calls, 1);
});

test("waitForCoordinate keeps polling while the branch build is still running", async () => {
  const waits = [];
  let calls = 0;
  const result = await waitForCoordinate({
    image: "ghcr.io/first-tree-ai/opentag",
    reference: "abc",
    attempts: 5,
    intervalMs: 1000,
    lookup: async () => {
      calls += 1;
      return calls < 3 ? { present: false, digest: null } : { present: true, digest: DIGEST };
    },
    pause: async (ms) => waits.push(ms),
  });
  assert.deepEqual(result, { present: true, digest: DIGEST });
  assert.equal(calls, 3);
  assert.deepEqual(waits, [1000, 1000]);
});

test("waitForCoordinate gives up rather than releasing an image that never appeared", async () => {
  let calls = 0;
  await assert.rejects(
    waitForCoordinate({
      image: "ghcr.io/first-tree-ai/opentag",
      reference: "abc",
      attempts: 3,
      lookup: async () => {
        calls += 1;
        return { present: false, digest: null };
      },
      pause: async () => {},
    }),
    /never became available/,
  );
  assert.equal(calls, 3);
});

test("waitForCoordinate propagates an inconclusive lookup instead of retrying it away", async () => {
  await assert.rejects(
    waitForCoordinate({
      image: "ghcr.io/first-tree-ai/opentag",
      reference: "abc",
      lookup: async () => {
        throw new Error("registry manifest lookup was inconclusive with status 503");
      },
      pause: async () => {},
    }),
    /inconclusive/,
  );
});

test("parseReleaseTag accepts only stable release tags", () => {
  assert.equal(parseReleaseTag("v1.2.3"), "1.2.3");
  assert.throws(() => parseReleaseTag("1.2.3"), /vX\.Y\.Z/);
  assert.throws(() => parseReleaseTag("v1.2.3-staging.1.1"), /vX\.Y\.Z/);
});

test("selectReleaseVersions orders releases highest first and ignores other tags", () => {
  assert.deepEqual(selectReleaseVersions(["v1.2.3", "v2.0.0", "v1.0.0", "v1.2.4-staging.1.1", "not-a-tag"]), [
    "2.0.0",
    "1.2.3",
    "1.0.0",
  ]);
});

test("resolveLatestTarget converges on the highest published release", async () => {
  const queried = [];
  const target = await resolveLatestTarget({
    tags: ["v1.0.0", "v1.2.3", "v2.0.0"],
    lookup: async (version) => {
      queried.push(version);
      return { present: version === "2.0.0", digest: version === "2.0.0" ? DIGEST : null };
    },
  });
  assert.deepEqual(target, { version: "2.0.0", digest: DIGEST });
  assert.deepEqual(queried, ["2.0.0"]);
});

test("resolveLatestTarget skips a higher release whose build never published", async () => {
  const target = await resolveLatestTarget({
    tags: ["v1.2.3", "v2.0.0"],
    lookup: async (version) => ({ present: version === "1.2.3", digest: version === "1.2.3" ? DIGEST : null }),
  });
  assert.deepEqual(target, { version: "1.2.3", digest: DIGEST });
});

test("resolveLatestTarget returns the same answer regardless of which run asks", async () => {
  const lookup = async (version) => ({ present: version !== "3.0.0", digest: version !== "3.0.0" ? DIGEST : null });
  const fromHigh = await resolveLatestTarget({ tags: ["v3.0.0", "v2.0.0", "v1.0.0"], lookup });
  const fromLow = await resolveLatestTarget({ tags: ["v1.0.0", "v2.0.0", "v3.0.0"], lookup });
  assert.deepEqual(fromHigh, fromLow);
  assert.equal(fromHigh.version, "2.0.0");
});

test("resolveLatestTarget reports no target when nothing is published", async () => {
  assert.equal(await resolveLatestTarget({ tags: ["v1.0.0"], lookup: async () => ({ present: false }) }), null);
  assert.equal(await resolveLatestTarget({ tags: [], lookup: async () => assert.fail("no lookup") }), null);
});

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);

test("parseCommitList rejects anything that is not a full commit SHA", () => {
  assert.deepEqual(parseCommitList(`${SHA_A}\n${SHA_B}\n`), [SHA_A, SHA_B]);
  assert.throws(() => parseCommitList("abc123"), /not a full commit SHA/);
});

test("resolveEdgeTarget converges on the newest commit with a published image", async () => {
  const queried = [];
  const target = await resolveEdgeTarget({
    commits: [SHA_C, SHA_B, SHA_A],
    lookup: async (commit) => {
      queried.push(commit);
      return { present: commit === SHA_B, digest: commit === SHA_B ? DIGEST : null };
    },
  });
  assert.deepEqual(target, { commit: SHA_B, digest: DIGEST });
  assert.deepEqual(queried, [SHA_C, SHA_B]);
});

test("resolveEdgeTarget does not strand edge when the tip build failed", async () => {
  // C is the tip but never published; B is newer than A and did publish.
  const lookup = async (commit) => ({ present: commit !== SHA_C, digest: commit !== SHA_C ? DIGEST : null });
  const fromTip = await resolveEdgeTarget({ commits: [SHA_C, SHA_B, SHA_A], lookup });
  const fromSuperseded = await resolveEdgeTarget({ commits: [SHA_C, SHA_B, SHA_A], lookup });
  assert.deepEqual(fromTip, fromSuperseded);
  assert.equal(fromTip.commit, SHA_B);
});

test("resolveEdgeTarget reports no target when nothing is published", async () => {
  assert.equal(await resolveEdgeTarget({ commits: [SHA_A], lookup: async () => ({ present: false }) }), null);
  assert.equal(await resolveEdgeTarget({ commits: [], lookup: async () => assert.fail("no lookup") }), null);
});
