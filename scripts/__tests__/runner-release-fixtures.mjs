import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RUNNER_LABELS } from "../runner/gar.mjs";

export const HOST = "us-west1-docker.pkg.dev";
export const PATH = "opentag-test/runners/opentag-runner";
export const IMAGE = `${HOST}/${PATH}`;
export const VERSION = "0.0.6-staging.30.1";
export const SHA = "a".repeat(40);
export const OTHER_SHA = "b".repeat(40);
export const PACKAGE = "open-tag-staging";

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** Digest-consistent fake registry router; `tagStatus` controls the first tag lookup. */
export function garRouter({ labelOverrides, tagStatus = 200 } = {}) {
  const configBytes = Buffer.from(
    JSON.stringify({
      architecture: "amd64",
      os: "linux",
      config: {
        Labels: {
          [RUNNER_LABELS.channel]: "staging",
          [RUNNER_LABELS.version]: VERSION,
          [RUNNER_LABELS.revision]: SHA,
          [RUNNER_LABELS.sourceDirty]: "false",
          ...labelOverrides,
        },
      },
    }),
  );
  const manifestBytes = Buffer.from(
    JSON.stringify({ schemaVersion: 2, config: { digest: sha256(configBytes), size: configBytes.length }, layers: [] }),
  );
  const rootDigest = sha256(manifestBytes);
  const bodies = new Map([
    [`https://${HOST}/v2/${PATH}/manifests/${VERSION}`, { digest: rootDigest, bytes: manifestBytes }],
    [`https://${HOST}/v2/${PATH}/blobs/${sha256(configBytes)}`, { digest: sha256(configBytes), bytes: configBytes }],
  ]);
  let tagReads = 0;
  const fetchImpl = async (url) => {
    const route = bodies.get(url.replace(/%3A/gi, ":"));
    if (!route) return { status: 404, headers: headerMap({}), arrayBuffer: async () => new ArrayBuffer(0) };
    if (url.endsWith(`/manifests/${VERSION}`)) {
      tagReads += 1;
      if (tagStatus !== 200)
        return { status: tagStatus, headers: headerMap({}), arrayBuffer: async () => new ArrayBuffer(0) };
    }
    return {
      status: 200,
      headers: headerMap({ "docker-content-digest": route.digest }),
      arrayBuffer: async () =>
        route.bytes.buffer.slice(route.bytes.byteOffset, route.bytes.byteOffset + route.bytes.length),
    };
  };
  return { rootDigest, fetchImpl, tagReads: () => tagReads };
}

export function headerMap(entries) {
  const map = new Map(Object.entries(entries).map(([key, value]) => [key.toLowerCase(), value]));
  return { get: (name) => map.get(name.toLowerCase()) ?? null };
}

export function commandRecorder(responses = {}) {
  const calls = [];
  const runCommand = async (command, args) => {
    calls.push([command, ...args]);
    if (command === "gcloud") return { status: 0, stdout: "gcloud-token\n", stderr: "" };
    const key = `${command} ${args[0]}`;
    return responses[key] ?? { status: 0, stdout: "", stderr: "" };
  };
  return { calls, runCommand };
}

export async function tempDir(label) {
  return mkdtemp(join(tmpdir(), label));
}

export async function publishDeps(overrides = {}) {
  const root = await tempDir("opentag-checkout-");
  const outDir = await tempDir("opentag-release-out-");
  const calls = [];
  const deps = {
    image: IMAGE,
    channel: "staging",
    version: VERSION,
    sourceSha: SHA,
    output: join(outDir, "runner-release.json"),
    repositoryRoot: root,
    readSource: () => ({ sourceSha: SHA, sourceDirty: false, cliVersion: "0.0.5" }),
    build: async (args) => {
      calls.push(["build", args]);
      return { architecture: "amd64", tag: args.tag };
    },
    smoke: async (args) => {
      calls.push(["smoke", args]);
      return {};
    },
    ...overrides,
  };
  return { deps, calls, root, outDir };
}
