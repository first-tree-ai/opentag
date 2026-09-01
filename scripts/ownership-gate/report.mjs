import { groupBlocking, STATE_SUCCESS } from "./policy.mjs";

export const MAX_DESCRIPTION_LENGTH = 140;
const MAX_PATHS_PER_GROUP = 20;
const MAX_LOGINS_IN_DESCRIPTION = 3;

/** Truncates to the commit-status limit, which the API rejects rather than trims. */
export function truncateDescription(text, limit = MAX_DESCRIPTION_LENGTH) {
  const value = String(text ?? "");
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

/**
 * A repository path is chosen by whoever opened the pull request, and this text
 * lands in a privileged job summary. Git permits almost anything in a filename,
 * including newlines and backticks, so a path could otherwise close the code
 * span, break the table row, or open a line that GitHub Actions reads as a
 * workflow command.
 */
export function escapeCell(value) {
  return String(value)
    .replaceAll("\\", "\\\\")
    .replaceAll("`", "\\`")
    .replaceAll("|", "\\|")
    .replaceAll(/[\r\n]/g, " ")
    .replaceAll("::", ":​:");
}

function joinLogins(logins) {
  if (logins.length === 0) {
    return "an owner";
  }
  if (logins.length === 1) {
    return logins[0];
  }
  return `${logins.slice(0, -1).join(", ")} or ${logins.at(-1)}`;
}

function blockingSummary(decision) {
  const parts = [];
  if (decision.blocking.length > 0) {
    const count = decision.blocking.length;
    parts.push(`${count} file${count === 1 ? "" : "s"} awaiting approval`);
  }
  if (decision.externalAuthor.required && !decision.externalAuthor.satisfied) {
    parts.push("external author needs an owner approval");
  }
  return parts.join("; ");
}

/**
 * Names who can clear the verdict without overstating it. Blocking rules are
 * conjunctive -- every one of them needs its own approval -- so a union of the
 * eligible logins would read as "any of these will do" when it will not. Only a
 * single requirement is spelled out; several are counted and deferred to the
 * summary, which lists them rule by rule.
 */
function describeRequirement(decision) {
  const groups = new Set(groupBlocking(decision.blocking).map((group) => [...group.eligible].sort().join(",")));
  if (decision.externalAuthor.required && !decision.externalAuthor.satisfied) {
    groups.add([...decision.externalAuthor.eligible].sort().join(","));
  }
  if (groups.size === 0) {
    return "";
  }
  if (groups.size > 1) {
    return ` Needs ${groups.size} separate approvals.`;
  }
  const logins = [...groups][0].split(",").filter(Boolean);
  return logins.length > MAX_LOGINS_IN_DESCRIPTION
    ? ` Needs any of ${logins.length} owners.`
    : ` Needs ${joinLogins(logins)}.`;
}

function describeOne(result) {
  const { decision, pullRequest } = result;
  if (decision.state === STATE_SUCCESS) {
    const count = decision.files.length;
    return `Ownership satisfied for ${count} changed file${count === 1 ? "" : "s"}.`;
  }
  return `#${pullRequest.number}: ${blockingSummary(decision)}.${describeRequirement(decision)}`;
}

/**
 * The one line a reviewer sees on the merge box. It has to name the blocker
 * without the detail, because the API caps it at 140 characters and answers 422
 * on overflow -- which would leave the required check stuck pending forever.
 */
export function renderStatusDescription(results, state) {
  const blocked = results.filter((result) => result.decision.state !== STATE_SUCCESS);
  if (state === STATE_SUCCESS) {
    const suffix = results.length > 1 ? ` (${results.length} pull requests on this commit)` : "";
    return truncateDescription(`${describeOne(results[0])}${suffix}`);
  }
  if (blocked.length === 1 && results.length === 1) {
    return truncateDescription(`${blockingSummary(blocked[0].decision)}.${describeRequirement(blocked[0].decision)}`);
  }
  return truncateDescription(
    `${blocked.length} of ${results.length} pull requests on this commit await approval. See the job summary.`,
  );
}

function renderPaths(paths) {
  const shown = paths.slice(0, MAX_PATHS_PER_GROUP).map((path) => `\`${escapeCell(path)}\``);
  const hidden = paths.length - shown.length;
  return hidden > 0 ? `${shown.join(", ")} and ${hidden} more` : shown.join(", ");
}

function renderBlockingTable(blocking) {
  const header = ["| Rule | Mode | Needs approval from | Files |", "| --- | --- | --- | --- |"];
  const rows = groupBlocking(blocking).map(
    (group) =>
      `| \`${escapeCell(group.pattern)}\` | ${group.mode} | ${joinLogins(group.eligible)} | ${renderPaths(group.paths)} |`,
  );
  return [...header, ...rows].join("\n");
}

function renderExternalLine(decision) {
  if (!decision.externalAuthor.required) {
    return null;
  }
  const verdict = decision.externalAuthor.satisfied ? "satisfied" : "**not satisfied**";
  return `External-author floor: ${verdict} — a pull request from an author without write access needs an approval from any owner named in CODEOWNERS, whatever files it touches.`;
}

function renderPullRequest(result) {
  const { decision, pullRequest } = result;
  const access = decision.hasWriteAccess ? "has write access" : `has no write access (${pullRequest.accessReason})`;
  const lines = [
    `### [#${pullRequest.number}](${pullRequest.url}) → \`${escapeCell(pullRequest.baseRef ?? "unknown")}\``,
    "",
    `Author: \`${escapeCell(decision.author)}\` — ${access}.`,
  ];

  const external = renderExternalLine(decision);
  if (external !== null) {
    lines.push(external);
  }
  lines.push("");

  if (decision.blocking.length === 0) {
    lines.push(
      decision.state === STATE_SUCCESS
        ? `All ${decision.files.length} changed file(s) satisfy the ownership policy.`
        : `All ${decision.files.length} changed file(s) satisfy the per-file policy; only the external-author floor is unmet.`,
    );
  } else {
    lines.push(
      `${decision.blocking.length} of ${decision.files.length} changed file(s) still need an approval.`,
      "",
      renderBlockingTable(decision.blocking),
    );
  }

  const approvals = decision.approvals.map((login) => `\`${escapeCell(login)}\``).join(", ");
  lines.push("", `Approvals counted: ${approvals.length > 0 ? approvals : "none"}.`);
  return lines.join("\n");
}

/**
 * The job summary. It is the only place the gate can explain itself, so it
 * states which rule produced each outcome rather than only the outcome, and it
 * says out loud what the gate does not cover.
 */
export function renderSummary({ repository, headSha, results, state, codeownersPath, modesPath }) {
  const lines = [
    "## Ownership gate",
    "",
    `Repository: \`${repository}\` · Commit: \`${headSha}\` · Verdict: **${state}**`,
    `Policy: \`${codeownersPath}\` with modes from \`${modesPath}\`, both read from the default branch.`,
  ];

  if (results.length > 1) {
    lines.push(
      "",
      `${results.length} open pull requests share this commit, and a commit status is written per commit rather than per pull request. The verdict published is the worst of them.`,
    );
  }

  for (const result of results) {
    lines.push("", renderPullRequest(result));
  }

  lines.push(
    "",
    "This check reports only red or green; it never approves on anyone's behalf. Approvals are not dismissed on a new push, so an approval obtained before a later push still counts here.",
  );

  return `${lines.join("\n")}\n`;
}
