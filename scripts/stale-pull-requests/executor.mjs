import { sleep } from "../github/client.mjs";
import { renderClosingNotice, renderNotice } from "./notice.mjs";
import { ACTION_CLOSE, ACTION_WARN } from "./policy.mjs";

/** GitHub asks for at least one second between mutating requests. */
export const DEFAULT_MUTATION_DELAY_MS = 1500;

const STALE_LABEL_COLOR = "ededed";
const STALE_LABEL_DESCRIPTION = "No activity for long enough that the sweep will close it";
const EXEMPT_LABEL_COLOR = "0e8a16";
const EXEMPT_LABEL_DESCRIPTION = "Never auto-closed by the stale pull request sweep";

function encodePath(value) {
  return encodeURIComponent(value);
}

/**
 * Wraps the four repository mutations the sweep performs. `pull-requests: write`
 * covers all of them, including creating a label.
 */
export function createPullRequestActions({ client, owner, name }) {
  const repositoryPath = `/repos/${encodePath(owner)}/${encodePath(name)}`;

  return {
    // Comment creation is not idempotent: GitHub can commit the comment and
    // still answer 5xx, so this one call opts out of the retry loop and lets the
    // next scheduled run re-post instead of duplicating it inside this one.
    comment: (number, body) =>
      client.rest("POST", `${repositoryPath}/issues/${number}/comments`, { body }, { retries: 0 }),
    addLabel: (number, label) => client.rest("POST", `${repositoryPath}/issues/${number}/labels`, { labels: [label] }),
    removeLabel: (number, label) =>
      client.rest("DELETE", `${repositoryPath}/issues/${number}/labels/${encodePath(label)}`),
    close: (number) => client.rest("PATCH", `${repositoryPath}/pulls/${number}`, { state: "closed" }),
    createLabel: (name_, color, description) =>
      client.rest("POST", `${repositoryPath}/labels`, { name: name_, color, description }),
  };
}

/**
 * Creates the labels the policy references. A label that already exists comes
 * back as 422, which is the expected outcome on every run after the first; any
 * other failure is logged and tolerated because labels are cosmetic -- the
 * hidden notice marker is the sweep's real state.
 */
export async function ensureLabels({ actions, config, logger }) {
  const wanted = [
    { name: config.staleLabel, color: STALE_LABEL_COLOR, description: STALE_LABEL_DESCRIPTION },
    ...config.exemptLabels.map((label) => ({
      name: label,
      color: EXEMPT_LABEL_COLOR,
      description: EXEMPT_LABEL_DESCRIPTION,
    })),
  ];

  for (const label of wanted) {
    try {
      await actions.createLabel(label.name, label.color, label.description);
      logger.info("Created missing label", { label: label.name });
    } catch (error) {
      if (error?.status === 422) {
        logger.debug("Label already exists", { label: label.name });
        continue;
      }
      logger.warn("Could not provision label", { label: label.name, status: error?.status, message: error?.message });
    }
  }
}

function noticeBody(pullRequest, decision, config) {
  return renderNotice({
    idleDays: decision.idleDays,
    warnAfterDays: config.warnAfterDays,
    closeAfterDays: config.closeAfterDays,
    exemptLabels: config.exemptLabels,
    mentions: pullRequest.mentions,
    requestedTeamCount: pullRequest.requestedTeamCount,
  });
}

async function reconcileStaleLabel({ pullRequest, decision, actions, config, run }) {
  if (decision.desiredStaleLabel && !pullRequest.hasStaleLabel) {
    await run(() => actions.addLabel(pullRequest.number, config.staleLabel));
    return "added";
  }
  if (!decision.desiredStaleLabel && pullRequest.hasStaleLabel) {
    await run(() => actions.removeLabel(pullRequest.number, config.staleLabel));
    return "removed";
  }
  return "unchanged";
}

async function applyWarn({ pullRequest, decision, actions, config, run }) {
  await run(() => actions.comment(pullRequest.number, noticeBody(pullRequest, decision, config)));
}

async function applyClose({ pullRequest, decision, actions, config, run }) {
  // A close that failed after its farewell was posted leaves the pull request
  // open and eligible again tomorrow; without this guard it would collect one
  // identical farewell per run for as long as the close keeps failing.
  if (!pullRequest.hasFarewell) {
    const body = renderClosingNotice({
      idleDays: decision.idleDays,
      closeAfterDays: config.closeAfterDays,
      exemptLabels: config.exemptLabels,
    });
    await run(() => actions.comment(pullRequest.number, body));
  }
  await run(() => actions.close(pullRequest.number));
}

function overCap(action, counts, config) {
  if (action === ACTION_WARN) {
    return counts.warned >= config.maxNotices;
  }
  if (action === ACTION_CLOSE) {
    return counts.closed >= config.maxCloses;
  }
  return false;
}

function buildRunner({ dryRun, delayMillis, sleepImpl }) {
  let mutated = false;
  return async (operation) => {
    if (dryRun) {
      return;
    }
    if (mutated) {
      await sleepImpl(delayMillis);
    }
    mutated = true;
    await operation();
  };
}

async function applyOne({ entry, actions, config, run, counts, logger }) {
  const { pullRequest, decision } = entry;
  if (overCap(decision.action, counts, config)) {
    logger.warn("Skipped by the per-run cap", { number: pullRequest.number, action: decision.action });
    counts.cappedNumbers.push(pullRequest.number);
    return { ...entry, outcome: "capped" };
  }

  if (decision.action === ACTION_WARN) {
    await applyWarn({ pullRequest, decision, actions, config, run });
    counts.warned += 1;
  } else if (decision.action === ACTION_CLOSE) {
    await applyClose({ pullRequest, decision, actions, config, run });
    counts.closed += 1;
  }

  const label = await reconcileStaleLabel({ pullRequest, decision, actions, config, run });
  return { ...entry, outcome: decision.action, label };
}

/**
 * Applies every decision in order, honouring the dry-run switch, the per-run
 * caps and the inter-mutation delay. A failure on one pull request is recorded
 * and the sweep continues, so one unlucky pull request cannot strand the rest.
 */
export async function executeDecisions({
  entries,
  actions,
  config,
  logger,
  dryRun = false,
  delayMillis = DEFAULT_MUTATION_DELAY_MS,
  sleepImpl = sleep,
}) {
  const run = buildRunner({ dryRun, delayMillis, sleepImpl });
  const counts = { warned: 0, closed: 0, cappedNumbers: [] };
  const results = [];

  for (const entry of entries) {
    try {
      results.push(await applyOne({ entry, actions, config, run, counts, logger }));
    } catch (error) {
      logger.error("Failed to apply decision", {
        number: entry.pullRequest.number,
        action: entry.decision.action,
        message: error?.message,
        status: error?.status,
      });
      results.push({ ...entry, outcome: "failed", error: error?.message ?? String(error) });
    }
  }

  return { results, warned: counts.warned, closed: counts.closed, cappedNumbers: counts.cappedNumbers };
}
