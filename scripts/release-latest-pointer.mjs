#!/usr/bin/env node

import { appendFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveCoordinate } from "./registry-coordinate.mjs";
import { compareStableVersions, parseStableVersion } from "./release-versions.mjs";

const RELEASE_TAG_PATTERN = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function parseReleaseTag(tag, label = "release tag") {
  if (!RELEASE_TAG_PATTERN.test(tag)) {
    throw new Error(`${label} must look like "vX.Y.Z", got "${tag}"`);
  }
  const version = tag.slice(1);
  parseStableVersion(version, label);
  return version;
}

/**
 * Orders the stable release versions found among `tags`, highest first.
 *
 * Tags that are not stable release coordinates are ignored rather than rejected: the repository also
 * carries staging tags, and they never compete for the `latest` pointer.
 */
export function selectReleaseVersions(tags) {
  return tags
    .filter((tag) => RELEASE_TAG_PATTERN.test(tag))
    .map((tag) => tag.slice(1))
    .sort((left, right) => compareStableVersions(right, left));
}

/**
 * Resolves the coordinate `latest` should point at: the highest release that is actually published.
 *
 * This reconciles rather than deciding whether the current run may promote itself. Pointer runs can
 * be dropped from the queue, and a run that only asked "am I the highest?" would then skip and leave
 * `latest` behind forever. Because every run converges on the same answer, whichever run survives
 * the queue lands the pointer on the right digest.
 *
 * A release tag whose build never published is skipped, so a failed release cannot pin `latest`.
 */
export async function resolveLatestTarget({ tags, lookup }) {
  for (const version of selectReleaseVersions(tags)) {
    const result = await lookup(version);
    if (result.present) {
      return { version, digest: result.digest };
    }
  }
  return null;
}

function parseArguments(arguments_) {
  const values = new Map();
  for (let index = 0; index < arguments_.length; index += 2) {
    const key = arguments_[index];
    const value = arguments_[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error(`invalid argument sequence near "${key ?? ""}"`);
    }
    values.set(key.slice(2), value);
  }
  return values;
}

async function main() {
  const arguments_ = parseArguments(process.argv.slice(2));
  const image = arguments_.get("image");
  if (!image) {
    throw new Error("--image is required");
  }

  const tags = (process.env.RELEASE_TAGS ?? "")
    .split("\n")
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
  const token = process.env.GITHUB_TOKEN;

  const target = await resolveLatestTarget({
    tags,
    lookup: (version) => resolveCoordinate({ image, reference: version, token }),
  });

  if (!target) {
    if (process.env.GITHUB_OUTPUT) {
      await appendFile(process.env.GITHUB_OUTPUT, "move=false\n");
    }
    console.log("no published release exists yet; latest is left alone");
    return;
  }

  const current = await resolveCoordinate({ image, reference: "latest", token });
  const move = current.digest !== target.digest;

  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `move=${move}\ndigest=${target.digest}\nversion=${target.version}\n`);
  }
  console.log(
    move
      ? `latest should point at ${target.version} (${target.digest})`
      : `latest already points at ${target.version} (${target.digest})`,
  );
}

const isProcessEntry =
  process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isProcessEntry) {
  main().catch((error) => {
    console.error(`[release-latest-pointer] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
