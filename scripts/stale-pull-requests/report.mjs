import { ACTION_CLOSE, ACTION_NONE, ACTION_SKIP, ACTION_WARN } from "./policy.mjs";

const ACTION_LABELS = {
  [ACTION_WARN]: "Notified",
  [ACTION_CLOSE]: "Closed",
  [ACTION_NONE]: "No change",
  [ACTION_SKIP]: "Exempt",
  capped: "Deferred (cap)",
  failed: "Failed",
};

function escapeCell(value) {
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

function countByOutcome(results) {
  const counts = new Map();
  for (const result of results) {
    counts.set(result.outcome, (counts.get(result.outcome) ?? 0) + 1);
  }
  return counts;
}

function renderRow(result) {
  const { pullRequest, decision, outcome } = result;
  const idle = decision.idleDays === null ? "unknown" : `${decision.idleDays}`;
  return `| [#${pullRequest.number}](${pullRequest.url}) | ${escapeCell(pullRequest.title)} | ${idle} | ${
    ACTION_LABELS[outcome] ?? outcome
  } | ${escapeCell(decision.reason)} |`;
}

function renderTable(results) {
  const acted = results.filter((result) => result.outcome !== ACTION_NONE && result.outcome !== ACTION_SKIP);
  if (acted.length === 0) {
    return "No pull request needed a notice or a close this run.";
  }
  const header = ["| Pull request | Title | Idle days | Outcome | Reason |", "| --- | --- | --- | --- | --- |"];
  return [...header, ...acted.map(renderRow)].join("\n");
}

function renderCounts(results) {
  const counts = countByOutcome(results);
  const parts = [...counts.entries()].map(([outcome, count]) => `${ACTION_LABELS[outcome] ?? outcome}: ${count}`);
  return parts.length === 0 ? "No open pull requests." : parts.join(" · ");
}

/**
 * Renders the run report written to the job summary. It is the only durable
 * record of a scheduled sweep, so it states the policy that produced the
 * outcome, not just the outcome.
 */
export function renderSummary({ repository, config, dryRun, results, cappedNumbers }) {
  const lines = [
    "## Stale pull requests",
    "",
    `Repository: \`${repository}\``,
    `Policy: notify after **${config.warnAfterDays} days** of inactivity, close after **${config.closeAfterDays} days**, with a **${config.graceHours}h** grace period between the two.`,
    `Exempt: ${config.exemptDrafts ? "drafts, " : ""}\`${config.exemptLabels.join("`, `")}\`${
      config.exemptAuthors.length > 0 ? `, authors \`${config.exemptAuthors.join("`, `")}\`` : ""
    }.`,
    "",
  ];

  if (dryRun) {
    lines.push("**Dry run** — no comment, label or close was applied.", "");
  }
  lines.push(renderCounts(results), "", renderTable(results));

  if (cappedNumbers.length > 0) {
    const deferred = cappedNumbers.map((number) => `#${number}`).join(", ");
    lines.push(
      "",
      `Per-run caps (${config.maxNotices} notices, ${config.maxCloses} closes) deferred ${cappedNumbers.length} pull request(s) to the next run: ${deferred}.`,
    );
  }

  return `${lines.join("\n")}\n`;
}
