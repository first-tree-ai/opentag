#!/usr/bin/env node

/**
 * Reads the billing capability of a published Server image from the image itself.
 *
 * The `cloud` Docker target stamps `org.opentag.billing.revision` into the image configuration; the
 * ordinary `runtime` target has no such label. Deployment and the image workflow read this label
 * rather than the source pin, because a source pin alone does not prove that the image published at
 * a commit coordinate bundles billing: an image built without the billing credential, or reused from
 * an earlier run, carries whatever capability it was actually built with.
 */

import { createHash } from "node:crypto";
import { appendFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  MANIFEST_MEDIA_TYPES,
  parseAuthenticateChallenge,
  parseImageReference,
  requestToken,
} from "./registry-coordinate.mjs";

export const BILLING_REVISION_LABEL = "org.opentag.billing.revision";

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const REVISION_PATTERN = /^[0-9a-f]{40}$/;
const CONFIG_MEDIA_TYPES = [
  "application/vnd.oci.image.config.v1+json",
  "application/vnd.docker.container.image.v1+json",
];

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** One authenticated registry reader; the Bearer token is requested once and reused. */
function registryReader({ image, token, fetchImpl }) {
  const { registry, repository } = parseImageReference(image);
  let bearer = null;
  const send = async (url, accept) => {
    const headers = { accept: accept.join(", ") };
    if (bearer) headers.authorization = `Bearer ${bearer}`;
    try {
      return await fetchImpl(url, { method: "GET", headers });
    } catch (error) {
      throw new Error(`registry lookup could not reach ${registry}`, { cause: error });
    }
  };
  return async (kind, reference, accept) => {
    const url = `https://${registry}/v2/${repository}/${kind}/${encodeURIComponent(reference)}`;
    let response = await send(url, accept);
    if (response.status === 401 && !bearer) {
      const challenge = parseAuthenticateChallenge(response.headers.get("www-authenticate"));
      if (!challenge) throw new Error("registry demanded authentication without a usable Bearer challenge");
      try {
        bearer = await requestToken({ challenge, token, fetchImpl });
      } catch (error) {
        throw new Error(`registry token request for ${registry} failed: ${error.message}`, { cause: error });
      }
      response = await send(url, accept);
    }
    if (response.status !== 200) {
      throw new Error(`registry ${kind} lookup for ${image}@${reference} failed with status ${response.status}`);
    }
    return Buffer.from(await response.arrayBuffer());
  };
}

function parseJson(bytes, what) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`registry returned an unreadable ${what}`);
  }
}

/** Platform image manifests only: BuildKit attestation manifests use the `unknown/unknown` platform. */
function platformDigests(index) {
  const digests = (Array.isArray(index.manifests) ? index.manifests : [])
    .filter(
      (entry) =>
        entry?.platform?.os &&
        entry.platform.os !== "unknown" &&
        entry.annotations?.["vnd.docker.reference.type"] !== "attestation-manifest",
    )
    .map((entry) => entry.digest);
  if (digests.length === 0) throw new Error("image index lists no platform image manifest");
  for (const digest of digests) {
    if (!DIGEST_PATTERN.test(digest ?? "")) throw new Error("image index lists a malformed manifest digest");
  }
  return digests;
}

function labelOf(config) {
  const value = config?.config?.Labels?.[BILLING_REVISION_LABEL];
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !REVISION_PATTERN.test(value)) {
    throw new Error(`image label ${BILLING_REVISION_LABEL} is not a full commit SHA`);
  }
  return value;
}

/**
 * Returns the billing revision bundled in `image:reference`, or `null` for an ordinary image.
 *
 * Every manifest and the configuration blob are verified against their content digests, and every
 * platform of a multi-platform image must agree. Any registry answer that cannot prove the
 * capability throws: an unknown capability must never be reported as "no billing" or as billing.
 */
export async function readImageBillingRevision({ image, reference, token, fetchImpl = fetch }) {
  const read = registryReader({ image, token, fetchImpl });
  const top = parseJson(await read("manifests", reference, MANIFEST_MEDIA_TYPES), "manifest");
  const manifests = [];
  if (Array.isArray(top.manifests)) {
    for (const digest of platformDigests(top)) {
      const bytes = await read("manifests", digest, MANIFEST_MEDIA_TYPES);
      if (sha256(bytes) !== digest) throw new Error(`manifest ${digest} does not match its digest`);
      manifests.push(parseJson(bytes, "manifest"));
    }
  } else {
    manifests.push(top);
  }

  const revisions = new Set();
  for (const manifest of manifests) {
    const digest = manifest?.config?.digest;
    if (!DIGEST_PATTERN.test(digest ?? "")) throw new Error("image manifest has no usable configuration digest");
    const bytes = await read("blobs", digest, CONFIG_MEDIA_TYPES);
    if (sha256(bytes) !== digest) throw new Error(`image configuration ${digest} does not match its digest`);
    revisions.add(labelOf(parseJson(bytes, "image configuration")));
  }
  if (revisions.size !== 1) throw new Error("image platforms disagree about the bundled billing revision");
  return [...revisions][0];
}

/** `none` expects an ordinary image; a full SHA expects exactly that bundled billing revision. */
export function assertExpectedBillingRevision(actual, expected) {
  if (expected === undefined) return;
  const wanted = expected === "none" ? null : expected;
  if (wanted !== null && !REVISION_PATTERN.test(wanted)) {
    throw new Error('--expect must be "none" or a full billing commit SHA');
  }
  if (actual !== wanted) {
    throw new Error(
      `image billing capability is ${actual ?? "none"}, expected ${wanted ?? "none"}; refusing to misreport it`,
    );
  }
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!["--image", "--reference", "--expect"].includes(key) || value === undefined || value.startsWith("--")) {
      throw new Error("usage: image-billing.mjs --image <image> --reference <tag> [--expect <none|sha>]");
    }
    values.set(key.slice(2), value);
  }
  if (!values.get("image") || !values.get("reference")) throw new Error("--image and --reference are required");
  return values;
}

async function main(argv) {
  const options = parseArguments(argv);
  const image = options.get("image");
  const reference = options.get("reference");
  const revision = await readImageBillingRevision({ image, reference, token: process.env.GITHUB_TOKEN });
  assertExpectedBillingRevision(revision, options.get("expect"));
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `billing_revision=${revision ?? ""}\n`);
  }
  console.log(
    revision
      ? `${image}:${reference} bundles cloud billing at ${revision}`
      : `${image}:${reference} is an ordinary image without cloud billing`,
  );
}

const isProcessEntry =
  process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isProcessEntry) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`[image-billing] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
