#!/usr/bin/env node
import { appendFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { ALERT_CONCLUSIONS, buildAlert, shouldAlert } from "./deploy-alert/classify.mjs";
import { buildCard, sendFeishu, validateWebhookUrl } from "./deploy-alert/feishu.mjs";
import { DOCKER_WORKFLOW_PATH, findProfile } from "./deploy-alert/profiles.mjs";
import { createGitHubClient, sleep } from "./github/client.mjs";
import { createLogger } from "./logger.mjs";

const CLI_OPTIONS = {
  "run-id": { type: "string" },
  rehearsal: { type: "boolean" },
};

export function parseCli(argv) {
  const { values } = parseArgs({ args: argv, options: CLI_OPTIONS, allowPositionals: false });
  const runId = values["run-id"];
  if (!/^\d+$/.test(runId ?? "")) {
    throw new TypeError(`--run-id must be a numeric workflow run id, received ${JSON.stringify(runId)}`);
  }
  return { runId, rehearsal: values.rehearsal === true };
}

/**
 * Deploy Staging waits for the Server image that the Docker workflow builds for the same commit.
 * When that wait failed, the Docker run is the real cause, so it is folded into this one alert.
 * A lookup failure only loses the hint; it must never cost the alert itself.
 */
async function findServerImageCause({ client, repository, sha, logger }) {
  try {
    const workflowFile = basename(DOCKER_WORKFLOW_PATH);
    const result = await client.rest(
      "GET",
      `/repos/${repository}/actions/workflows/${workflowFile}/runs?head_sha=${sha}&event=push&per_page=5`,
    );
    const latest = result?.workflow_runs?.[0];
    logger.debug("Docker runs for the deploy revision", { sha, count: result?.workflow_runs?.length ?? 0 });
    if (latest && ALERT_CONCLUSIONS.has(latest.conclusion)) {
      return { text: "该提交的 Server 镜像构建失败（Docker 工作流）", url: latest.html_url };
    }
    if (!latest) {
      return { text: "该提交没有 Docker 构建记录，Server 镜像未发布", url: null };
    }
    return null;
  } catch (error) {
    logger.warn("Could not look up the Docker run for the deploy revision", { message: error?.message });
    return null;
  }
}

async function writeSummary(path, alert, logger) {
  if (!path) return;
  const lines = [
    "### Deploy failure alert",
    "",
    `- Workflow: ${alert.workflow}`,
    `- Environment: ${alert.environment.key}`,
    `- Phase: ${alert.phase.name}`,
    `- Failed step: ${alert.stepName ?? "none"}`,
    `- Rehearsal: ${alert.rehearsal}`,
    "",
  ];
  try {
    await appendFile(path, lines.join("\n"));
  } catch (error) {
    logger.warn("Could not write the job summary", { message: error?.message });
  }
}

/** Returns the process exit code. Every dependency is injected so tests never touch the network. */
export async function run({ argv, env, logger, fetchImpl = fetch, sleepImpl = sleep, now = Date.now }) {
  const { runId, rehearsal } = parseCli(argv);
  const repository = env.GITHUB_REPOSITORY;
  const rawWebhook = env.FEISHU_WEBHOOK_URL?.trim();
  if (!rawWebhook) {
    // Visible in the run annotations without failing an alert-only workflow.
    process.stdout.write("::warning::FEISHU_DEPLOY_WEBHOOK_URL is not configured; no deploy failure alert was sent\n");
    logger.warn("Webhook is not configured; skipping", { runId });
    return 0;
  }
  const webhookUrl = validateWebhookUrl(rawWebhook);

  const client = createGitHubClient({ token: env.GH_TOKEN ?? env.GITHUB_TOKEN, logger, fetchImpl, sleepImpl });
  const workflowRun = await client.rest("GET", `/repos/${repository}/actions/runs/${runId}`);
  const profile = findProfile(workflowRun.path);
  if (!profile) {
    throw new Error(`Run ${runId} belongs to ${workflowRun.path}, which is not a watched deployment workflow`);
  }
  logger.info("Inspecting run", {
    runId,
    workflow: profile.name,
    conclusion: workflowRun.conclusion,
    event: workflowRun.event,
    rehearsal,
  });

  if (!rehearsal) {
    const decision = shouldAlert(workflowRun, repository);
    if (!decision.alert) {
      logger.info("No alert needed", { runId, reason: decision.reason });
      return 0;
    }
  }

  const jobs = await client.rest("GET", `/repos/${repository}/actions/runs/${runId}/jobs?filter=latest&per_page=100`);
  const alert = buildAlert({ run: workflowRun, jobs: jobs?.jobs, profile, rehearsal });
  if (alert.phase.awaitsServerImage) {
    alert.rootCause = await findServerImageCause({ client, repository, sha: workflowRun.head_sha, logger });
  }
  logger.info("Classified failure", {
    environment: alert.environment.key,
    phase: alert.phase.name,
    job: alert.jobName,
    step: alert.stepName,
    rootCause: alert.rootCause?.text ?? null,
  });

  await sendFeishu({
    webhookUrl,
    secret: env.FEISHU_WEBHOOK_SECRET?.trim() || null,
    message: buildCard(alert),
    fetchImpl,
    sleepImpl,
    now,
    logger,
  });
  await writeSummary(env.GITHUB_STEP_SUMMARY, alert, logger);
  return 0;
}

const isMain = process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  const env = process.env;
  const logger = createLogger({
    level: env.DEPLOY_ALERT_LOG_LEVEL ?? (env.RUNNER_DEBUG === "1" ? "debug" : "info"),
    prefix: "[deploy-alert]",
  });
  run({ argv: process.argv.slice(2), env, logger })
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`[deploy-alert] ERROR ${error?.stack ?? error}\n`);
      process.exitCode = 1;
    });
}
