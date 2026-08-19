#!/usr/bin/env node

import { appendFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const MANIFEST_MEDIA_TYPES = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.docker.distribution.manifest.v2+json",
];

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

/**
 * Splits `ghcr.io/owner/name` into the registry host and the repository path.
 * A bare `owner/name` is rejected rather than defaulting to Docker Hub, because every coordinate
 * this repository publishes is fully qualified and a silent default would query the wrong registry.
 */
export function parseImageReference(image) {
  const separator = image.indexOf("/");
  if (separator === -1) {
    throw new Error(`image "${image}" must be fully qualified as <registry>/<repository>`);
  }
  const registry = image.slice(0, separator);
  const repository = image.slice(separator + 1);
  if (!registry.includes(".") || repository.length === 0) {
    throw new Error(`image "${image}" must be fully qualified as <registry>/<repository>`);
  }
  return { registry, repository };
}

/**
 * Turns a manifest response into a definitive answer, or throws.
 *
 * Only `200` proves the coordinate is published and only `404` proves it is absent. Authentication,
 * rate limiting, and registry faults all arrive as other statuses, and treating them as absence is
 * what would let a transient failure overwrite a published release.
 */
export function classifyManifestLookup({ status, digest, body }) {
  if (status === 200) {
    if (!DIGEST_PATTERN.test(digest ?? "")) {
      throw new Error(`registry returned no usable Docker-Content-Digest header (got "${digest ?? "none"}")`);
    }
    return { present: true, digest };
  }
  if (status === 404) {
    return { present: false, digest: null };
  }
  const detail = body ? `: ${body.slice(0, 200).trim()}` : "";
  throw new Error(`registry manifest lookup was inconclusive with status ${status}${detail}`);
}

/**
 * Parses a `WWW-Authenticate: Bearer realm="...",service="...",scope="..."` challenge.
 */
export function parseAuthenticateChallenge(header) {
  if (!header || !/^bearer\b/i.test(header.trim())) {
    return null;
  }
  const parameters = new Map();
  for (const match of header.matchAll(/([a-zA-Z0-9_]+)="([^"]*)"/g)) {
    parameters.set(match[1], match[2]);
  }
  const realm = parameters.get("realm");
  if (!realm) {
    return null;
  }
  return { realm, service: parameters.get("service") ?? null, scope: parameters.get("scope") ?? null };
}

async function requestToken({ challenge, token, fetchImpl }) {
  const url = new URL(challenge.realm);
  if (challenge.service) {
    url.searchParams.set("service", challenge.service);
  }
  if (challenge.scope) {
    url.searchParams.set("scope", challenge.scope);
  }

  const headers = {};
  if (token) {
    // GHCR accepts any username alongside a GitHub token; the registry only reads the password.
    headers.authorization = `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
  }

  const response = await fetchImpl(url.toString(), { headers });
  if (!response.ok) {
    throw new Error(`registry token request failed with status ${response.status}`);
  }
  const payload = await response.json();
  const issued = payload.token ?? payload.access_token;
  if (!issued) {
    throw new Error("registry token response contained no token");
  }
  return issued;
}

/**
 * Resolves whether a coordinate is published, and the digest it points at.
 *
 * Throws on anything that does not definitively answer that question, so callers can treat a
 * successful return as trustworthy.
 */
export async function resolveCoordinate({ image, reference, token, fetchImpl = fetch }) {
  const { registry, repository } = parseImageReference(image);
  const url = `https://${registry}/v2/${repository}/manifests/${encodeURIComponent(reference)}`;
  const headers = { accept: MANIFEST_MEDIA_TYPES.join(", ") };

  let response;
  try {
    response = await fetchImpl(url, { method: "GET", headers });
  } catch (error) {
    throw new Error(`registry manifest lookup could not reach ${registry}`, { cause: error });
  }

  if (response.status === 401) {
    const challenge = parseAuthenticateChallenge(response.headers.get("www-authenticate"));
    if (!challenge) {
      throw new Error("registry demanded authentication without a usable Bearer challenge");
    }
    const issued = await requestToken({ challenge, token, fetchImpl });
    try {
      response = await fetchImpl(url, {
        method: "GET",
        headers: { ...headers, authorization: `Bearer ${issued}` },
      });
    } catch (error) {
      throw new Error(`registry manifest lookup could not reach ${registry}`, { cause: error });
    }
  }

  const body = response.status === 200 || response.status === 404 ? "" : await response.text().catch(() => "");
  return classifyManifestLookup({
    status: response.status,
    digest: response.headers.get("docker-content-digest"),
    body,
  });
}

function parseArguments(arguments_) {
  const values = new Map();
  for (let index = 0; index < arguments_.length; index += 1) {
    const key = arguments_[index];
    if (!key?.startsWith("--")) {
      throw new Error(`invalid argument sequence near "${key ?? ""}"`);
    }
    const next = arguments_[index + 1];
    if (next === undefined || next.startsWith("--")) {
      values.set(key.slice(2), "true");
      continue;
    }
    values.set(key.slice(2), next);
    index += 1;
  }
  return values;
}

async function main() {
  const arguments_ = parseArguments(process.argv.slice(2));
  const image = arguments_.get("image");
  const reference = arguments_.get("reference");
  if (!image || !reference) {
    throw new Error("--image and --reference are required");
  }

  const result = await resolveCoordinate({
    image,
    reference,
    token: process.env.GITHUB_TOKEN,
  });

  if (arguments_.get("require-absent") === "true" && result.present) {
    throw new Error(`${image}:${reference} is already published at ${result.digest} and must not be overwritten`);
  }

  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `present=${result.present}\ndigest=${result.digest ?? ""}\n`);
  }
  console.log(
    result.present ? `${image}:${reference} is published at ${result.digest}` : `${image}:${reference} is unpublished`,
  );
}

const isProcessEntry =
  process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isProcessEntry) {
  main().catch((error) => {
    console.error(`[registry-coordinate] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
