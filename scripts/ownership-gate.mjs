#!/usr/bin/env node
import { appendFile, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { createGitHubClient } from "./github/client.mjs";
import { createLogger } from "./logger.mjs";
import { collectOwners, createMatcher, ownerLogin, parseCodeowners } from "./ownership-gate/codeowners.mjs";
import { parseModeConfig } from "./ownership-gate/modes.mjs";
import { decidePullRequest, STATE_FAILURE, STATE_SUCCESS } from "./ownership-gate/policy.mjs";
import {
  fetchApprovals,
  fetchAuthorAccess,
  fetchChangedFiles,
  postCommitStatus,
} from "./ownership-gate/pull-request.mjs";
import { renderStatusDescription, renderSummary, truncateDescription } from "./ownership-gate/report.mjs";

/**
 * Evaluates one pull request against `.github/CODEOWNERS` and reports a single
 * red-or-green commit status named by `--context`.
 *
 * It reads the policy from the checkout it is running in, which the workflow
 * pins to the DEFAULT BRANCH: a pull request must not be able to relax the gate
 * that judges it. It never checks out or executes pull-request code, and it
 * talks to GitHub through reads plus one status POST, which is what makes the
 * `pull_request_target` and `workflow_run` triggers safe on a public repository.
 */

const CLI_OPTIONS = {
  repository: { type: "string" },
  "pull-request": { type: "string" },
  "head-sha": { type: "string" },
  context: { type: "string" },
  root: { type: "string" },
  "dry-run": { type: "boolean" },
};

export const DEFAULT_CONTEXT = "ownership-gate";
export const CODEOWNERS_PATH = ".github/CODEOWNERS";
export const MODES_PATH = ".github/ownership-modes.json";

export function parseRepository(value) {
  const [owner, name, ...rest] = String(value ?? "").split("/");
  if (!owner || !name || rest.length > 0) {
    throw new TypeError(`Repository must be given as "owner/name", received ${JSON.stringify(value)}`);
  }
  return { owner, name };
}

function optionalPullRequestNumber(raw) {
  if (raw === undefined || raw === null || String(raw).length === 0) {
    return null;
  }
  const number = Number(raw);
  if (!Number.isInteger(number) || number <= 0) {
    throw new TypeError(`A pull request number must be a positive integer, received ${JSON.stringify(raw)}`);
  }
  return number;
}

function optionalSha(raw) {
  const value = String(raw ?? "").trim();
  if (value.length === 0) {
    return null;
  }
  // GitHub sets this; validating it anyway keeps a malformed environment from
  // being interpolated into a request path.
  if (!/^[0-9a-f]{40}$/.test(value)) {
    throw new TypeError(`A head SHA must be 40 hexadecimal characters, received ${JSON.stringify(raw)}`);
  }
  return value;
}

/**
 * The pull request arrives either as a number (`pull_request_target`,
 * `workflow_dispatch`) or, on `workflow_run`, only as the relay run's head SHA.
 * Exactly one is required.
 */
export function buildConfig(argv, env = {}) {
  const { values } = parseArgs({ args: argv, options: CLI_OPTIONS, allowPositionals: false });
  const number = optionalPullRequestNumber(values["pull-request"] ?? env.PULL_REQUEST_NUMBER);
  const headSha = optionalSha(values["head-sha"] ?? env.RELAY_HEAD_SHA);
  if (number === null && headSha === null) {
    throw new TypeError("A pull request number or a head SHA is required; set PULL_REQUEST_NUMBER or RELAY_HEAD_SHA");
  }
  return {
    repository: values.repository ?? env.GITHUB_REPOSITORY,
    number,
    headSha,
    context: values.context ?? env.OWNERSHIP_GATE_CONTEXT ?? DEFAULT_CONTEXT,
    root: resolve(values.root ?? process.cwd()),
    dryRun: values["dry-run"] === true,
  };
}

/** Loads the policy from the checked-out default branch. */
export async function loadPolicy(root) {
  const codeownersText = await readFile(join(root, CODEOWNERS_PATH), "utf8");
  const { rules, problems } = parseCodeowners(codeownersText);
  if (problems.length > 0) {
    const detail = problems.map((problem) => `line ${problem.line}: ${problem.message}`).join("; ");
    throw new Error(`${CODEOWNERS_PATH} has unparseable rules: ${detail}`);
  }
  const modeConfig = parseModeConfig(JSON.parse(await readFile(join(root, MODES_PATH), "utf8")));
  const owners = [];
  for (const token of collectOwners(rules)) {
    const login = ownerLogin(token);
    if (login !== null && !owners.includes(login)) {
      owners.push(login);
    }
  }
  return { rules, matcher: createMatcher(rules), modeConfig, owners };
}

function targetUrl(env) {
  const server = env.GITHUB_SERVER_URL ?? "https://github.com";
  if (!env.GITHUB_REPOSITORY || !env.GITHUB_RUN_ID) {
    return undefined;
  }
  return `${server}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`;
}

async function publishSummary(summary, env, logger) {
  process.stdout.write(summary);
  if (!env.GITHUB_STEP_SUMMARY) {
    return;
  }
  try {
    await appendFile(env.GITHUB_STEP_SUMMARY, summary);
  } catch (error) {
    logger.warn("Could not write the job summary", { message: error?.message });
  }
}

/**
 * On `workflow_run` the payload carries no pull request -- `workflow_run.
 * pull_requests` is empty for pull requests from forks, which is exactly the
 * case this path exists to serve. The relay run's head SHA is the one piece of
 * GitHub-supplied metadata that survives, so the pull request is resolved from
 * it rather than from anything the relay produced.
 */
async function resolvePullRequestNumber(client, { owner, name, config, logger }) {
  if (config.number !== null) {
    return config.number;
  }
  const associated = await client.rest("GET", `/repos/${owner}/${name}/commits/${config.headSha}/pulls?per_page=100`);
  const open = (Array.isArray(associated) ? associated : []).filter(
    (candidate) => candidate?.state === "open" && candidate?.head?.sha === config.headSha,
  );
  logger.info("Resolved pull requests from the relay head SHA", {
    headSha: config.headSha,
    associated: Array.isArray(associated) ? associated.length : 0,
    open: open.length,
  });
  if (open.length === 1) {
    return open[0].number;
  }
  if (open.length === 0) {
    return null;
  }
  throw new Error(
    `Head SHA ${config.headSha} belongs to ${open.length} open pull requests, which share one commit status; re-run the gate for each with workflow_dispatch`,
  );
}

async function readPullRequest(client, { owner, name, number, logger }) {
  const pullRequest = await client.rest("GET", `/repos/${owner}/${name}/pulls/${number}`);
  logger.info("Loaded pull request", {
    number,
    headSha: pullRequest.head?.sha,
    author: pullRequest.user?.login,
    changedFiles: pullRequest.changed_files,
  });
  return pullRequest;
}

async function collectInputs(client, { owner, name, number, pullRequest, logger }) {
  const isFork = pullRequest.head?.repo?.full_name !== `${owner}/${name}`;
  const [files, approvals, access] = await Promise.all([
    fetchChangedFiles(client, { owner, name, number, expectedCount: pullRequest.changed_files, logger }),
    fetchApprovals(client, { owner, name, number, logger }),
    fetchAuthorAccess(client, {
      owner,
      name,
      login: pullRequest.user?.login,
      isBot: pullRequest.user?.type === "Bot",
      isFork,
      authorAssociation: pullRequest.author_association,
      logger,
    }),
  ]);
  return { files, approvals, access, isFork };
}

export async function evaluate({ client, config, policy, logger }) {
  const { owner, name } = parseRepository(config.repository);
  const number = await resolvePullRequestNumber(client, { owner, name, config, logger });
  if (number === null) {
    logger.info("No open pull request has this head commit; nothing to report", { headSha: config.headSha });
    return null;
  }
  const pullRequest = await readPullRequest(client, { owner, name, number, logger });
  const { files, approvals, access, isFork } = await collectInputs(client, {
    owner,
    name,
    number,
    pullRequest,
    logger,
  });

  const decision = decidePullRequest({
    files,
    matcher: policy.matcher,
    modeConfig: policy.modeConfig,
    author: pullRequest.user?.login,
    hasWriteAccess: access.hasWriteAccess,
    approvals,
    owners: policy.owners,
  });

  logger.info("Decided", {
    state: decision.state,
    files: decision.files.length,
    blocking: decision.blocking.length,
    requiredFrom: decision.requiredFrom,
  });

  return {
    decision,
    owner,
    name,
    pullRequest: {
      number,
      url: pullRequest.html_url,
      headSha: pullRequest.head?.sha,
      isFork,
      accessReason: access.reason,
    },
  };
}

async function report({ client, config, env, logger, result }) {
  const { decision, owner, name, pullRequest } = result;
  const summary = renderSummary({
    repository: `${owner}/${name}`,
    pullRequest,
    decision,
    codeownersPath: CODEOWNERS_PATH,
    modesPath: MODES_PATH,
  });
  await publishSummary(summary, env, logger);

  if (config.dryRun) {
    logger.info("Dry run: no commit status was posted", { state: decision.state });
    return;
  }
  try {
    await postCommitStatus(client, {
      owner,
      name,
      sha: pullRequest.headSha,
      state: decision.state === STATE_SUCCESS ? STATE_SUCCESS : STATE_FAILURE,
      context: config.context,
      description: renderStatusDescription(decision),
      targetUrl: targetUrl(env),
      logger,
    });
  } catch (error) {
    await publishSummary(renderPostFailureNote(error), env, logger);
    throw error;
  }
}

/**
 * Every trigger this workflow uses runs with a write-capable token, so a denial
 * here means the token permissions were narrowed rather than that the gate hit
 * the fork restriction. Say which, because the visible symptom -- a red run and
 * a required check that never moves -- is the same for both.
 */
function renderPostFailureNote(error) {
  if (error?.status !== 403) {
    return `\n> Could not publish the commit status: ${error?.message ?? error}\n`;
  }
  return [
    "",
    "> **The verdict above could not be published.** Posting the commit status was denied (403),",
    "> which means this job no longer holds `statuses: write`. Check the workflow permissions and the",
    "> repository's default workflow token permissions, then re-run the gate from the Actions tab.",
    "",
  ].join("\n");
}

/**
 * Reports the gate as `error` when the gate itself could not answer. Absent and
 * pending both block a merge, so failing to post at all would already be
 * fail-closed -- but an explicit `error` says why on the merge box instead of
 * leaving a silent "waiting for status".
 */
async function reportOperationalFailure({ client, config, env, error, headSha, logger }) {
  if (config?.dryRun !== false || !headSha) {
    return;
  }
  try {
    const { owner, name } = parseRepository(config.repository);
    await postCommitStatus(client, {
      owner,
      name,
      sha: headSha,
      state: "error",
      context: config.context,
      description: truncateDescription(`Ownership gate could not run: ${error?.message ?? error}`),
      targetUrl: targetUrl(env),
      logger,
    });
  } catch (postError) {
    logger.error("Could not report the failure as a commit status", { message: postError?.message });
  }
}

async function main() {
  const env = process.env;
  const config = buildConfig(process.argv.slice(2), env);
  const logger = createLogger({
    level: env.OWNERSHIP_GATE_LOG_LEVEL ?? (env.RUNNER_DEBUG === "1" ? "debug" : "info"),
    prefix: "[ownership-gate]",
  });
  logger.debug("Resolved configuration", config);

  const client = createGitHubClient({ token: env.GH_TOKEN ?? env.GITHUB_TOKEN, logger });
  const policy = await loadPolicy(config.root);
  logger.info("Loaded policy", { rules: policy.rules.length, owners: policy.owners });

  // Remembered outside the try so a failure after the pull request was read can
  // still report itself on the right commit.
  let headSha = config.headSha;
  try {
    const result = await evaluate({ client, config, policy, logger });
    if (result === null) {
      return 0;
    }
    headSha = result.pullRequest.headSha ?? headSha;
    await report({ client, config, env, logger, result });
    return 0;
  } catch (error) {
    logger.error("Ownership gate failed", { message: error?.message });
    await reportOperationalFailure({ client, config, env, error, headSha, logger });
    throw error;
  }
}

const isMain = process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`[ownership-gate] ERROR ${error?.stack ?? error}\n`);
      process.exitCode = 1;
    });
}
