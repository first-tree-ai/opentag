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
 * Selects the release tags that rank strictly above `currentTag`, newest first.
 *
 * Tags that are not stable release coordinates are ignored rather than rejected: the repository also
 * carries staging tags, and they never compete for the `latest` pointer.
 */
export function selectGreaterReleases(currentTag, tags) {
  const current = parseReleaseTag(currentTag, "current tag");
  return tags
    .filter((tag) => RELEASE_TAG_PATTERN.test(tag))
    .map((tag) => ({ tag, version: tag.slice(1) }))
    .filter((candidate) => compareStableVersions(candidate.version, current) > 0)
    .sort((left, right) => compareStableVersions(right.version, left.version));
}

/**
 * Decides whether this release may take over the `latest` pointer.
 *
 * Release builds for different tags run concurrently, so finishing order says nothing about version
 * order. The pointer therefore only moves when no higher release is already published: a higher tag
 * whose own build failed or has not published yet does not block, and whichever build publishes last
 * still leaves `latest` on the highest version.
 */
export async function decideLatestPromotion({ currentTag, tags, isPublished }) {
  const greater = selectGreaterReleases(currentTag, tags);
  for (const candidate of greater) {
    if (await isPublished(candidate.version)) {
      return { promote: false, blockedBy: candidate.tag };
    }
  }
  return { promote: true, blockedBy: null };
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
  const currentTag = arguments_.get("tag");
  if (!image || !currentTag) {
    throw new Error("--image and --tag are required");
  }

  const tags = (process.env.RELEASE_TAGS ?? "")
    .split("\n")
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
  const token = process.env.GITHUB_TOKEN;

  const decision = await decideLatestPromotion({
    currentTag,
    tags,
    isPublished: async (version) => (await resolveCoordinate({ image, reference: version, token })).present,
  });

  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `promote=${decision.promote}\n`);
  }
  console.log(
    decision.promote
      ? `${currentTag} is the highest published release; latest may point at it`
      : `leaving latest alone: ${decision.blockedBy} is already published and ranks above ${currentTag}`,
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
