#!/usr/bin/env node

/**
 * Decides whether a TruffleHog scan of a commit range fails the build.
 *
 * TruffleHog scans two kinds of chunk: the content of a file at a commit, and the commit's own
 * metadata (message, author). `--exclude-paths` filters the first kind only — a metadata chunk
 * carries no path, so no exclusion pattern can ever reach it. A commit message that merely
 * describes a credential shape therefore fails the scan, and because the message of a pushed
 * commit cannot be rewritten, that failure can never be fixed forward.
 *
 * The gate closes that hole without weakening the scan of the tree:
 *
 *   - File findings are reported exactly as TruffleHog emits them, verified or not. Path
 *     exclusions have already been applied by the scanner.
 *   - Commit metadata findings are reported only when TruffleHog verified the credential
 *     against its provider. A real token pasted into a commit message still fails the build;
 *     a placeholder DSN written into prose to explain a rule does not.
 *
 * Anything the gate cannot positively identify as a commit metadata chunk is reported, so an
 * unrecognized result shape fails closed.
 *
 * Write no credential-shaped literal into this file. It is scanned like any other production
 * file, and a scanner that reports its own gate is the failure this gate exists to end.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Parses TruffleHog JSON Lines output. Throws on any non-empty line that is not a JSON object. */
export function parseResults(input) {
  const results = [];
  const lines = input.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (line.length === 0) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`line ${index + 1} of the TruffleHog output is not JSON: ${line.slice(0, 120)}`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`line ${index + 1} of the TruffleHog output is not a result object`);
    }
    results.push(parsed);
  }
  return results;
}

/**
 * Normalizes a raw result into the fields the gate reasons about. `fromCommitMetadata` is true
 * only for a recognized git chunk that carries no path, which is how TruffleHog reports a finding
 * in a commit message or author line.
 */
export function describeResult(result) {
  const git = result?.SourceMetadata?.Data?.Git;
  const isGitChunk = Boolean(git) && typeof git === "object";
  const file = isGitChunk && typeof git.file === "string" ? git.file : "";
  return {
    detector:
      typeof result?.DetectorName === "string" && result.DetectorName.length > 0 ? result.DetectorName : "unknown",
    verified: result?.Verified === true,
    commit: isGitChunk && typeof git.commit === "string" ? git.commit : "",
    file,
    line: isGitChunk && Number.isInteger(git.line) ? git.line : 0,
    fromCommitMetadata: isGitChunk && file.length === 0,
  };
}

/** A finding is suppressed only when it sits in commit metadata and TruffleHog could not verify it. */
export function isSuppressed(finding) {
  return finding.fromCommitMetadata && !finding.verified;
}

export function classifyResults(results) {
  const reported = [];
  const suppressed = [];
  for (const result of results) {
    const finding = describeResult(result);
    (isSuppressed(finding) ? suppressed : reported).push(finding);
  }
  return { reported, suppressed };
}

/** Renders a finding without its secret: CI logs are readable by anyone who can read the run. */
export function formatFinding(finding) {
  const location = finding.fromCommitMetadata
    ? `commit message of ${finding.commit.slice(0, 12) || "<unknown commit>"}`
    : `${finding.file}:${finding.line} at ${finding.commit.slice(0, 12) || "<unknown commit>"}`;
  const state = finding.verified ? "verified" : "unverified";
  return `${finding.detector} (${state}) in ${location}`;
}

export function renderReport({ reported, suppressed }, { githubActions = false } = {}) {
  const total = reported.length + suppressed.length;
  const lines = [`Secret scan: ${total} raw result(s), ${reported.length} reported, ${suppressed.length} suppressed.`];
  for (const finding of suppressed) {
    lines.push(`  suppressed (unverified commit metadata): ${formatFinding(finding)}`);
  }
  for (const finding of reported) {
    lines.push(`  reported: ${formatFinding(finding)}`);
    if (githubActions) lines.push(`::error::Secret scan finding: ${formatFinding(finding)}`);
  }
  if (reported.length > 0) {
    lines.push(
      "Remove the credential and rotate it. Test fixtures belong in a path covered by .github/trufflehog-exclude-paths.txt.",
    );
  }
  return lines.join("\n");
}

export function runSecretScanGate(input, options = {}) {
  const classified = classifyResults(parseResults(input));
  return { ...classified, report: renderReport(classified, options) };
}

function readInput(path) {
  try {
    return readFileSync(path === "-" ? 0 : path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`TruffleHog output does not exist: ${path}`);
    throw error;
  }
}

/** `-` reads stdin, so the gate can sit at the end of a pipe as well as read a saved scan. */
export function parseArgs(argv) {
  const options = { path: "-", githubActions: false };
  let sawPath = false;
  for (const arg of argv) {
    if (arg === "--github-actions") {
      options.githubActions = true;
    } else if (arg.startsWith("--")) {
      throw new Error(`unknown argument ${arg}`);
    } else if (sawPath) {
      throw new Error(`unexpected second input path ${arg}`);
    } else {
      options.path = arg;
      sawPath = true;
    }
  }
  return options;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const { path, githubActions } = parseArgs(process.argv.slice(2));
    const { reported, report } = runSecretScanGate(readInput(path), { githubActions });
    console.log(report);
    if (reported.length > 0) process.exitCode = 1;
  } catch (error) {
    console.error(`Secret scan gate failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
