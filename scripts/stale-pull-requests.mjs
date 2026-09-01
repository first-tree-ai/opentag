#!/usr/bin/env node
import { appendFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { normalizeLogin, normalizePullRequest } from "./stale-pull-requests/activity.mjs";
import { createPullRequestActions, ensureLabels, executeDecisions } from "./stale-pull-requests/executor.mjs";
import { createGitHubClient } from "./stale-pull-requests/github.mjs";
import { createLogger } from "./stale-pull-requests/logger.mjs";
import { assertPolicyConfig, decidePullRequest } from "./stale-pull-requests/policy.mjs";
import { fetchOpenPullRequests } from "./stale-pull-requests/query.mjs";
import { renderSummary } from "./stale-pull-requests/report.mjs";

const CLI_OPTIONS = {
  "warn-after-days": { type: "string" },
  "close-after-days": { type: "string" },
  "grace-hours": { type: "string" },
  "stale-label": { type: "string" },
  "exempt-label": { type: "string", multiple: true },
  "exempt-author": { type: "string", multiple: true },
  "bot-login": { type: "string", multiple: true },
  "include-drafts": { type: "boolean" },
  "max-notices": { type: "string" },
  "max-closes": { type: "string" },
  "mutation-delay-ms": { type: "string" },
  repository: { type: "string" },
  "dry-run": { type: "boolean" },
};

const DEFAULTS = {
  warnAfterDays: 5,
  closeAfterDays: 7,
  graceHours: 48,
  staleLabel: "stale",
  exemptLabels: ["keep-open"],
  exemptAuthors: [],
  botLogins: ["github-actions"],
  exemptDrafts: true,
  maxNotices: 25,
  maxCloses: 10,
  mutationDelayMs: 1500,
};

function parseNumber(raw, field, fallback) {
  if (raw === undefined) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new TypeError(`--${field} must be a number, received ${JSON.stringify(raw)}`);
  }
  return value;
}

function normalizeLogins(values) {
  return values.map((value) => normalizeLogin(value)).filter((value) => value !== null);
}

/** Turns argv into the immutable configuration the rest of the sweep reads. */
export function buildConfig(argv) {
  const { values } = parseArgs({ args: argv, options: CLI_OPTIONS, allowPositionals: false });
  const config = {
    warnAfterDays: parseNumber(values["warn-after-days"], "warn-after-days", DEFAULTS.warnAfterDays),
    closeAfterDays: parseNumber(values["close-after-days"], "close-after-days", DEFAULTS.closeAfterDays),
    graceHours: parseNumber(values["grace-hours"], "grace-hours", DEFAULTS.graceHours),
    staleLabel: values["stale-label"] ?? DEFAULTS.staleLabel,
    exemptLabels: values["exempt-label"] ?? DEFAULTS.exemptLabels,
    exemptAuthors: normalizeLogins(values["exempt-author"] ?? DEFAULTS.exemptAuthors),
    botLogins: normalizeLogins(values["bot-login"] ?? DEFAULTS.botLogins),
    exemptDrafts: values["include-drafts"] !== true,
    maxNotices: parseNumber(values["max-notices"], "max-notices", DEFAULTS.maxNotices),
    maxCloses: parseNumber(values["max-closes"], "max-closes", DEFAULTS.maxCloses),
    mutationDelayMs: parseNumber(values["mutation-delay-ms"], "mutation-delay-ms", DEFAULTS.mutationDelayMs),
    dryRun: values["dry-run"] === true,
    repository: values.repository,
  };
  assertPolicyConfig(config);
  return config;
}

export function parseRepository(value) {
  const [owner, name, ...rest] = String(value ?? "").split("/");
  if (!owner || !name || rest.length > 0) {
    throw new TypeError(`Repository must be given as "owner/name", received ${JSON.stringify(value)}`);
  }
  return { owner, name };
}

/**
 * Turns raw GraphQL nodes into decisions. Pure on purpose: every policy question
 * ("would this pull request be closed today?") is answerable without a network.
 */
export function planSweep({ nodes, config, now }) {
  return nodes.map((node) => {
    const pullRequest = normalizePullRequest(node, {
      botLogins: config.botLogins,
      staleLabel: config.staleLabel,
      now,
    });
    return { pullRequest, decision: decidePullRequest({ pullRequest, config, now }) };
  });
}

async function publishSummary(summary, summaryPath, logger) {
  process.stdout.write(`${summary}\n`);
  if (!summaryPath) {
    return;
  }
  try {
    await appendFile(summaryPath, summary);
  } catch (error) {
    logger.warn("Could not write the job summary", { message: error?.message });
  }
}

function logPlan(entries, logger) {
  for (const { pullRequest, decision } of entries) {
    logger.debug("Decision", {
      number: pullRequest.number,
      action: decision.action,
      idleDays: decision.idleDays,
      lastActivityAt: pullRequest.lastActivityAt,
      noticePostedAt: pullRequest.notice?.postedAt ?? null,
      reason: decision.reason,
    });
  }
}

async function run({ config, env, logger, now }) {
  const { owner, name } = parseRepository(config.repository ?? env.GITHUB_REPOSITORY);
  const client = createGitHubClient({ token: env.GH_TOKEN ?? env.GITHUB_TOKEN, logger });
  const actions = createPullRequestActions({ client, owner, name });

  const nodes = await fetchOpenPullRequests(client, { owner, name, logger });
  logger.info("Collected open pull requests", { repository: `${owner}/${name}`, count: nodes.length });

  const entries = planSweep({ nodes, config, now });
  logPlan(entries, logger);

  if (!config.dryRun) {
    await ensureLabels({ actions, config, logger });
  }
  const execution = await executeDecisions({
    entries,
    actions,
    config,
    logger,
    dryRun: config.dryRun,
    delayMillis: config.mutationDelayMs,
  });
  logger.info("Sweep finished", {
    dryRun: config.dryRun,
    warned: execution.warned,
    closed: execution.closed,
    capped: execution.cappedNumbers.length,
  });

  const summary = renderSummary({
    repository: `${owner}/${name}`,
    config,
    dryRun: config.dryRun,
    results: execution.results,
    cappedNumbers: execution.cappedNumbers,
  });
  await publishSummary(summary, env.GITHUB_STEP_SUMMARY, logger);

  return execution.results.some((result) => result.outcome === "failed") ? 1 : 0;
}

async function main() {
  const env = process.env;
  const config = buildConfig(process.argv.slice(2));
  const logger = createLogger({ level: env.STALE_PR_LOG_LEVEL ?? (env.RUNNER_DEBUG === "1" ? "debug" : "info") });
  logger.debug("Resolved configuration", config);
  return run({ config, env, logger, now: new Date().toISOString() });
}

const isMain = process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`[stale-pr] ERROR ${error?.stack ?? error}\n`);
      process.exitCode = 1;
    });
}
