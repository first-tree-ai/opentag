import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const workflowPath = join(repoRoot, ".github", "workflows", "docker.yml");

function readJobs(workflow) {
  const lines = workflow.split(/\r?\n/);
  const jobsStart = lines.findIndex((line) => line === "jobs:");
  assert.notEqual(jobsStart, -1, "docker workflow must define jobs");

  const jobs = new Map();
  let currentJob = null;
  for (const line of lines.slice(jobsStart + 1)) {
    const match = line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/);
    if (match) {
      currentJob = { name: match[1], lines: [line] };
      jobs.set(match[1], currentJob);
      continue;
    }
    if (currentJob) currentJob.lines.push(line);
  }
  return jobs;
}

function jobText(job) {
  return job.lines.join("\n");
}

test("every setup-node version-file job checks out the repository first", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  const jobs = readJobs(workflow);

  for (const job of jobs.values()) {
    const lines = job.lines;
    const setupIndex = lines.findIndex(
      (line) =>
        line.includes("uses: actions/setup-node@") &&
        lines.some((candidate) => candidate.includes("node-version-file: .node-version")),
    );
    const versionFileIndex = lines.findIndex((line) => line.includes("node-version-file: .node-version"));
    if (setupIndex === -1 || versionFileIndex === -1) continue;

    const checkoutIndex = lines.findIndex((line) => line.includes("uses: actions/checkout@"));
    assert.ok(checkoutIndex >= 0, `${job.name} uses a version file but has no checkout step`);
    assert.ok(checkoutIndex < setupIndex, `${job.name} must check out before setup-node reads .node-version`);
  }
});

test("pull-request builds are isolated from registry publication", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  const jobs = readJobs(workflow);
  assert.match(workflow, /^ {2}pull_request:\s*$/m, "docker workflow must run on pull requests");

  const pullRequestJob = jobs.get("pull-request-build");
  assert.ok(pullRequestJob, "docker workflow must define a pull-request build job");
  const pullRequestText = jobText(pullRequestJob);
  assert.match(pullRequestText, /if: .*github\.event_name == 'pull_request'/);
  assert.match(pullRequestText, /permissions:\n {6}contents: read\n {4}steps:/);
  assert.match(pullRequestText, /uses: docker\/build-push-action@/);
  assert.match(pullRequestText, /\n {10}push: false\n/);
  assert.doesNotMatch(pullRequestText, /uses: docker\/login-action@/);

  for (const job of jobs.values()) {
    const text = jobText(job);
    const ifLine = text.match(/^ {4}if: (.+)$/m)?.[1] ?? "";
    const isPushOnly = ifLine.includes("github.event_name == 'push'");
    if (isPushOnly) continue;

    assert.doesNotMatch(text, /uses: docker\/login-action@/, `${job.name} must not log in during pull requests`);
    assert.doesNotMatch(text, /\n\s+push: true\s*$/, `${job.name} must not push during pull requests`);
    assert.doesNotMatch(text, /docker buildx imagetools create/, `${job.name} must not publish during pull requests`);
  }
});
