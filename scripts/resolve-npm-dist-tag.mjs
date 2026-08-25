#!/usr/bin/env node

/**
 * Decides which npm dist-tag a release may publish under.
 *
 * `npm publish --tag latest` moves the registry's `latest` to whatever version it publishes, with no
 * regard for what is already there. A release channel has two heads — the npm dist-tag and the
 * portable channel pointer — and the portable pointer only ever moves forward. If npm moved
 * unconditionally, publishing an older release after a newer one would drop npm's `latest` back while
 * the portable pointer correctly held, and the two heads would advertise different versions.
 *
 * So both heads apply the same rule: advance only on a forward move. An older release still
 * publishes and stays installable by exact version, it just does not claim the channel head.
 */

import { spawnSync } from "node:child_process";
import { appendFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { compareReleaseVersions } from "./release-versions.mjs";

export const LATEST_DIST_TAG = "latest";

/**
 * The tag an out-of-order release publishes under instead. It is left in place rather than removed:
 * trusted publishing authenticates `npm publish` alone, so a follow-up `npm dist-tag rm` would need
 * credentials this workflow deliberately does not hold. A named tag pointing at a superseded release
 * is accurate, and `npm install` still resolves through `latest`.
 */
export const SUPERSEDED_DIST_TAG = "superseded";

export function classifyDistTagLookup({ status, stdout, stderr }) {
  if (status === 0) {
    const trimmed = (stdout ?? "").trim();
    // An existing package with no `latest` tag prints nothing rather than failing.
    if (trimmed === "" || trimmed === "undefined") return { published: false };
    let value;
    try {
      value = JSON.parse(trimmed);
    } catch (error) {
      throw new Error("npm registry returned invalid JSON for the dist-tag lookup", { cause: error });
    }
    if (value === null || value === undefined) return { published: false };
    if (typeof value !== "string") {
      throw new Error(`npm registry returned a non-string dist-tag value: ${trimmed}`);
    }
    return { published: true, version: value };
  }

  // A package that has never been published has no channel head to protect.
  if (/\bE404\b/.test(stderr ?? "")) return { published: false };
  throw new Error(`npm dist-tag lookup failed: ${(stderr ?? "").trim() || `exit status ${status}`}`);
}

export function resolveDistTag({ version, publishedLatest }) {
  if (publishedLatest === undefined || publishedLatest === null) {
    return { tag: LATEST_DIST_TAG, reason: "the package has no published latest tag yet" };
  }
  const order = compareReleaseVersions(version, publishedLatest);
  if (order < 0) {
    return {
      tag: SUPERSEDED_DIST_TAG,
      reason: `latest already points at ${publishedLatest}, which is newer than ${version}`,
    };
  }
  return {
    tag: LATEST_DIST_TAG,
    reason:
      order === 0
        ? `latest already points at ${version}`
        : `${version} is newer than the published latest ${publishedLatest}`,
  };
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
  const packageName = arguments_.get("package");
  const version = arguments_.get("version");
  if (!packageName || !version) {
    throw new Error("--package and --version are required");
  }

  const lookup = spawnSync("npm", ["view", `${packageName}@latest`, "version", "--json"], { encoding: "utf8" });
  const published = classifyDistTagLookup({
    status: lookup.status,
    stdout: lookup.stdout,
    stderr: lookup.stderr,
  });
  const result = resolveDistTag({ publishedLatest: published.published ? published.version : undefined, version });

  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `tag=${result.tag}\n`);
  }
  console.log(`${packageName}@${version} publishes under dist-tag "${result.tag}": ${result.reason}`);
}

const isProcessEntry =
  process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isProcessEntry) {
  main().catch((error) => {
    console.error(`[npm-dist-tag] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
