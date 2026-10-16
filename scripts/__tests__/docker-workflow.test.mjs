import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

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
  assert.doesNotMatch(pullRequestText, /OPENTAG_BILLING_READ_TOKEN|repository: first-tree-ai\/opentag-billing/);

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

test("only the trusted commit build bundles a pinned private billing package", async () => {
  const jobs = readJobs(await readFile(workflowPath, "utf8"));
  const build = jobText(jobs.get("build"));
  assert.match(build, /github\.event_name == 'push'.*github\.ref_type == 'branch'/);
  assert.match(build, /repository: first-tree-ai\/opentag-billing/);
  assert.match(build, /ref: \$\{\{ steps\.billing\.outputs\.revision \}\}/);
  assert.match(build, /persist-credentials: false/);
  assert.match(build, /target: \$\{\{ steps\.billing\.outputs\.target \}\}/);
  assert.match(
    build,
    /build-contexts: \$\{\{ steps\.billing\.outputs\.target == 'cloud' && 'billing=\.cloud-billing' \|\| '' \}\}/,
  );
  for (const job of jobs.values()) {
    if (job.name !== "build") assert.doesNotMatch(jobText(job), /OPENTAG_BILLING_READ_TOKEN/);
  }
});

function buildSteps() {
  const workflow = parse(readFileSync(workflowPath, "utf8"));
  return new Map(workflow.jobs.build.steps.map((step) => [step.name, step]));
}

/** Runs the workflow's own target-selection script, so the tested branch is the shipped one. */
function chooseTarget(token) {
  const script = buildSteps().get("Choose the image target").run;
  const directory = mkdtempSync(join(tmpdir(), "opentag-docker-target-"));
  try {
    const output = join(directory, "output");
    const result = spawnSync("bash", ["-c", script], {
      cwd: repoRoot,
      encoding: "utf8",
      env: { PATH: process.env.PATH, GITHUB_OUTPUT: output, BILLING_READ_TOKEN: token },
    });
    assert.equal(result.status, 0, result.stderr);
    return Object.fromEntries(
      readFileSync(output, "utf8")
        .trim()
        .split("\n")
        .map((line) => line.split("=")),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("a missing, empty or blank billing credential builds the ordinary image without private access", () => {
  for (const token of ["", " ", "\n\t "]) {
    assert.deepEqual(chooseTarget(token), { target: "runtime", revision: "" });
  }
  const steps = buildSteps();
  for (const name of ["Verify the billing credential", "Check out the private billing package"]) {
    assert.match(steps.get(name).if, /steps\.billing\.outputs\.target == 'cloud'/, `${name} must be billing-only`);
  }
});

test("a supplied billing credential requests the pinned cloud build and is verified before use", () => {
  const pin = JSON.parse(readFileSync(join(repoRoot, "cloud-billing.json"), "utf8")).revision;
  assert.deepEqual(chooseTarget("fixture-token"), { target: "cloud", revision: pin });
  const verify = buildSteps().get("Verify the billing credential");
  assert.equal(verify.env.GH_TOKEN, "${{ secrets.OPENTAG_BILLING_READ_TOKEN }}");
  assert.match(verify.run, /repos\/first-tree-ai\/opentag-billing\/commits\/\$BILLING_REVISION/);
  assert.match(verify.run, /exit 1/);
});

test("the published capability is read back from the image, and a fresh build must match the request", () => {
  const steps = buildSteps();
  const capability = steps.get("Read the published billing capability");
  assert.ok(capability, "the build job must read the published billing capability");
  assert.equal(capability.if, undefined, "the capability is read for fresh and reused images alike");
  assert.equal(capability.env.EXPECTED, "${{ steps.billing.outputs.revision || 'none' }}");
  assert.match(capability.run, /--expect "\$EXPECTED"/);
  assert.equal(
    steps.get("Summarise the commit image").env.BILLING_REVISION,
    "${{ steps.capability.outputs.billing_revision }}",
  );
});
