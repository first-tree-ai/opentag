import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { DEPLOY_WORKFLOWS, DOCKER_WORKFLOW_PATH } from "../deploy-alert/profiles.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const alertPath = join(repoRoot, ".github", "workflows", "deploy-failure-alert.yml");

async function readWorkflow(relativePath) {
  return parse(await readFile(join(repoRoot, relativePath), "utf8"));
}

function stepNames(workflow) {
  return new Set(
    Object.values(workflow.jobs ?? {}).flatMap((job) => (job.steps ?? []).map((step) => step.name).filter(Boolean)),
  );
}

test("the alert watches every profiled deploy workflow by its current name", async () => {
  const alert = parse(await readFile(alertPath, "utf8"));
  const names = [];
  for (const profile of DEPLOY_WORKFLOWS) {
    const workflow = await readWorkflow(profile.path);
    assert.equal(workflow.name, profile.name, `${profile.path} was renamed; update the alert`);
    names.push(workflow.name);
  }
  assert.deepEqual([...alert.on.workflow_run.workflows].sort(), names.sort());
  assert.deepEqual(alert.on.workflow_run.types, ["completed"]);
  const docker = await readWorkflow(DOCKER_WORKFLOW_PATH);
  assert.ok(!alert.on.workflow_run.workflows.includes(docker.name), "Docker failures are folded into Deploy Staging");
});

test("every phase step name still exists in its workflow", async () => {
  for (const profile of DEPLOY_WORKFLOWS) {
    const steps = stepNames(await readWorkflow(profile.path));
    for (const phase of profile.phases) {
      for (const step of phase.steps) {
        assert.ok(steps.has(step), `${profile.path} no longer has a step named "${step}"`);
      }
    }
  }
  const staging = await readWorkflow(".github/workflows/deploy-staging.yml");
  assert.ok(stepNames(staging).has("Wait for the commit image"));
});

test("Deploy Runner exposes channel and mode in its run name", async () => {
  const runner = await readWorkflow(".github/workflows/deploy-runner.yml");
  assert.equal(
    runner["run-name"],
    "Deploy Runner · ${{ inputs.channel }} · ${{ inputs.version }} · ${{ inputs.mode }}",
  );
});

test("the alert job is least-privileged and keeps secrets out of inline scripts", async () => {
  const text = await readFile(alertPath, "utf8");
  const alert = parse(text);
  assert.deepEqual(alert.permissions, { contents: "read" });
  const job = alert.jobs.notify;
  assert.deepEqual(job.permissions, { contents: "read", actions: "read" });
  assert.match(job.if, /github\.repository == 'first-tree-ai\/opentag'/);
  assert.match(job.if, /workflow_run\.event != 'pull_request'/);
  assert.match(job.if, /\["failure","timed_out","startup_failure"\]/);
  assert.match(job.if, /github\.ref == 'refs\/heads\/main'/);

  for (const step of job.steps) {
    assert.doesNotMatch(step.run ?? "", /\$\{\{/, `step "${step.name}" must pass values through env`);
  }
  const send = job.steps.find((step) => step.run?.includes("scripts/deploy-failure-alert.mjs"));
  assert.equal(send.env.FEISHU_WEBHOOK_URL, "${{ secrets.FEISHU_DEPLOY_WEBHOOK_URL }}");
  assert.equal(send.env.FEISHU_WEBHOOK_SECRET, "${{ secrets.FEISHU_DEPLOY_WEBHOOK_SECRET }}");
  const checkouts = job.steps.filter((step) => step.uses?.startsWith("actions/checkout@"));
  assert.equal(checkouts.length, 1);
  assert.equal(checkouts[0].with["persist-credentials"], false);
  // The default branch only; checking out the reported run's ref would run unreviewed code with the secret.
  assert.equal(checkouts[0].with.ref, undefined);
});
