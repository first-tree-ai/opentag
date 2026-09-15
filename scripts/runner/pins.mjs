import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPT_DIR, "..", "..");

function readText(path) {
  return readFileSync(path, "utf8").trim();
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

const rootManifest = readJson(join(REPO_ROOT, "package.json"));
const cliManifest = readJson(join(REPO_ROOT, "apps/cli/package.json"));
const nodeVersion = readText(join(REPO_ROOT, "scripts/portable/node-version.txt"));
const packageManager = String(rootManifest.packageManager ?? "");
const pnpmVersion = packageManager.startsWith("pnpm@") ? packageManager.slice("pnpm@".length) : "";
if (!pnpmVersion) throw new Error("root packageManager must be pnpm@<version>");

const NODE_MAJOR_MINOR_PATCH = nodeVersion.replace(/^v/, "");
const IMAGE_TAG = `${NODE_MAJOR_MINOR_PATCH}-bookworm`;

/**
 * Reviewed linux/amd64 digests per Node version. A Node pin bump in node-version.txt without an
 * accompanying reviewed digest fails here, before any build — never silently relabel an old
 * digest as a new runtime.
 */
const REVIEWED_NODE_IMAGE_DIGESTS = Object.freeze({
  "24.19.0": "sha256:107ceb6ad85808049dccef12414bf17b08eceb299eaf755c0339dc5fc8958d6b",
});

function reviewedNodeDigest(version) {
  const normalized = version.replace(/^v/, "");
  const digest = REVIEWED_NODE_IMAGE_DIGESTS[normalized];
  if (!digest) {
    throw new Error(
      `Node ${normalized} has no reviewed linux/amd64 image digest; add one to REVIEWED_NODE_IMAGE_DIGESTS in scripts/runner/pins.mjs before building`,
    );
  }
  return digest;
}

if (!/^v?\d+\.\d+\.\d+$/.test(nodeVersion)) throw new Error(`invalid Node pin ${nodeVersion}`);
const IMAGE_DIGEST = reviewedNodeDigest(nodeVersion);

/** Host/OpenTag Pi is `@earendil-works/pi-coding-agent@0.84.2`; mariozechner 0.84.2 is unpublished. */
export const PI_PACKAGE = "@earendil-works/pi-coding-agent";
export const PI_VERSION = "0.84.2";

export const RUNNER_PINS = Object.freeze({
  nodeVersion,
  pnpmVersion,
  piPackage: PI_PACKAGE,
  piVersion: PI_VERSION,
  contextTreePackage: "@first-tree-ai/context-tree",
  contextTreeVersion: cliManifest.dependencies["@first-tree-ai/context-tree"],
  cliSourceVersion: cliManifest.version,
  image: {
    name: "node",
    tag: IMAGE_TAG,
    digest: IMAGE_DIGEST,
    platform: "linux/amd64",
  },
  git: {
    source: "node-image",
    version: "2.39.5",
    debian: "1:2.39.5-0+deb12u3",
    probe: "git version 2.39.5",
  },
  gh: {
    source: "github-release",
    version: "2.100.0",
    url: "https://github.com/cli/cli/releases/download/v2.100.0/gh_2.100.0_linux_amd64.tar.gz",
    sha256: "e4d4bb4498e8d007abe545b6568926793ace1b6447da598294a610018cb164be",
    bytes: 15_152_253,
    archiveMember: "gh_2.100.0_linux_amd64/bin/gh",
  },
  model: {
    provider: "deepseek",
    id: "deepseek-v4.1-flash-expires-on-0910",
    thinking: "max",
  },
});

export function nodeImageReference(pins = RUNNER_PINS) {
  if (pins.image.tag !== `${pins.nodeVersion.replace(/^v/, "")}-bookworm`) {
    throw new Error("Node image tag does not match scripts/portable/node-version.txt");
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(pins.image.digest)) throw new Error("Node image digest is not a sha256 pin");
  const reviewed = reviewedNodeDigest(pins.nodeVersion);
  if (pins.image.digest !== reviewed) {
    throw new Error(`Node ${pins.nodeVersion} image digest drifted from the reviewed digest`);
  }
  return `${pins.image.name}:${pins.image.tag}@${pins.image.digest}`;
}

export function runnerResourceLimits() {
  return Object.freeze({
    cpus: "1",
    memory: "1g",
    memorySwap: "1g",
    nanoCpus: 1_000_000_000,
    memoryBytes: 1_073_741_824,
  });
}
