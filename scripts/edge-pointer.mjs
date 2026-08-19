#!/usr/bin/env node

import { appendFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveCoordinate } from "./registry-coordinate.mjs";

const COMMIT_PATTERN = /^[0-9a-f]{40}$/;

export function parseCommitList(input) {
  const commits = input
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  for (const commit of commits) {
    if (!COMMIT_PATTERN.test(commit)) {
      throw new Error(`main history contained "${commit}", which is not a full commit SHA`);
    }
  }
  return commits;
}

/**
 * Resolves the coordinate `edge` should point at: the newest commit on main with a published image.
 *
 * Like the `latest` reconciler this converges instead of asking whether the current run may promote
 * itself. A run whose commit has been superseded, or whose pointer job was dropped from the queue,
 * still computes the same answer, so `edge` cannot strand on an older image when the tip's own build
 * failed or its promotion never ran.
 *
 * `commits` must be ordered newest first.
 */
export async function resolveEdgeTarget({ commits, lookup }) {
  for (const commit of commits) {
    const result = await lookup(commit);
    if (result.present) {
      return { commit, digest: result.digest };
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

  const commits = parseCommitList(process.env.MAIN_COMMITS ?? "");
  const token = process.env.GITHUB_TOKEN;

  const target = await resolveEdgeTarget({
    commits,
    lookup: (commit) => resolveCoordinate({ image, reference: commit, token }),
  });

  if (!target) {
    if (process.env.GITHUB_OUTPUT) {
      await appendFile(process.env.GITHUB_OUTPUT, "move=false\n");
    }
    console.log("no recent main commit has a published image; edge is left alone");
    return;
  }

  const current = await resolveCoordinate({ image, reference: "edge", token });
  const move = current.digest !== target.digest;

  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `move=${move}\ndigest=${target.digest}\ncommit=${target.commit}\n`);
  }
  console.log(
    move
      ? `edge should point at ${target.commit} (${target.digest})`
      : `edge already points at ${target.commit} (${target.digest})`,
  );
}

const isProcessEntry =
  process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isProcessEntry) {
  main().catch((error) => {
    console.error(`[edge-pointer] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
