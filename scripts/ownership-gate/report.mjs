import { groupBlocking, STATE_SUCCESS } from "./policy.mjs";

export const MAX_DESCRIPTION_LENGTH = 140;
const MAX_PATHS_PER_GROUP = 20;

/** Truncates to the commit-status limit, which the API rejects rather than trims. */
export function truncateDescription(text, limit = MAX_DESCRIPTION_LENGTH) {
  const value = String(text ?? "");
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
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

/**
 * The one line a reviewer sees on the merge box. It has to name the blocker
 * without the detail, because the API caps it at 140 characters and answers 422
 * on overflow -- which would leave the required check stuck pending forever.
 */
export function renderStatusDescription(decision) {
  if (decision.state === STATE_SUCCESS) {
    const count = decision.files.length;
    return truncateDescription(`Ownership satisfied for ${count} changed file${count === 1 ? "" : "s"}.`);
  }
  const parts = [];
  if (decision.blocking.length > 0) {
    const count = decision.blocking.length;
    parts.push(`${count} file${count === 1 ? "" : "s"} awaiting approval`);
  }
  if (decision.externalAuthor.required && !decision.externalAuthor.satisfied) {
    parts.push("external author needs an owner approval");
  }
  return truncateDescription(`${parts.join("; ")}. Needs ${joinLogins(decision.requiredFrom)}. See the job summary.`);
}

function renderPaths(paths) {
  const shown = paths.slice(0, MAX_PATHS_PER_GROUP).map((path) => `\`${path}\``);
  const hidden = paths.length - shown.length;
  return hidden > 0 ? `${shown.join(", ")} and ${hidden} more` : shown.join(", ");
}

function renderBlockingTable(blocking) {
  const header = ["| Rule | Mode | Needs approval from | Files |", "| --- | --- | --- | --- |"];
  const rows = groupBlocking(blocking).map(
    (group) => `| \`${group.pattern}\` | ${group.mode} | ${joinLogins(group.eligible)} | ${renderPaths(group.paths)} |`,
  );
  return [...header, ...rows].join("\n");
}

function renderAuthorLine(pullRequest, decision) {
  const access = decision.hasWriteAccess ? "has write access" : `has no write access (${pullRequest.accessReason})`;
  return `Author: \`${decision.author}\` — ${access}.`;
}

function renderExternalLine(decision) {
  if (!decision.externalAuthor.required) {
    return null;
  }
  const verdict = decision.externalAuthor.satisfied ? "satisfied" : "**not satisfied**";
  return `External-author floor: ${verdict} — a pull request from an author without write access needs an approval from any owner named in CODEOWNERS, whatever files it touches.`;
}

/**
 * The job summary. It is the only place the gate can explain itself, so it
 * states which rule produced each outcome rather than only the outcome, and it
 * says out loud what the gate does not cover.
 */
export function renderSummary({ repository, pullRequest, decision, codeownersPath, modesPath }) {
  const lines = [
    "## Ownership gate",
    "",
    `Repository: \`${repository}\` · Pull request: [#${pullRequest.number}](${pullRequest.url}) · Head: \`${pullRequest.headSha}\``,
    `Policy: \`${codeownersPath}\` with modes from \`${modesPath}\`, both read from the default branch.`,
    renderAuthorLine(pullRequest, decision),
    "",
  ];

  const external = renderExternalLine(decision);
  if (external !== null) {
    lines.push(external, "");
  }

  if (decision.state === STATE_SUCCESS) {
    lines.push(`All ${decision.files.length} changed file(s) satisfy the ownership policy.`);
  } else {
    lines.push(
      `${decision.blocking.length} of ${decision.files.length} changed file(s) still need an approval.`,
      "",
      renderBlockingTable(decision.blocking),
    );
  }

  lines.push(
    "",
    `Approvals counted: ${decision.approvals.length > 0 ? decision.approvals.map((login) => `\`${login}\``).join(", ") : "none"}.`,
    "",
    "This check reports only red or green; it never approves on anyone's behalf. Approvals are not dismissed on a new push, so an approval obtained before a later push still counts here.",
  );

  return `${lines.join("\n")}\n`;
}
