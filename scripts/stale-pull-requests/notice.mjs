import { CLOSED_MARKER, NOTICE_MARKER } from "./activity.mjs";

const POLICY_LINK = "https://github.com/first-tree-ai/opentag/blob/main/CONTRIBUTING.md#pull-requests";

function renderMentions(mentions) {
  if (mentions.length === 0) {
    return "";
  }
  return `${mentions.map((login) => `@${login}`).join(" ")} — `;
}

function renderTeamHint(requestedTeamCount) {
  if (requestedTeamCount === 0) {
    return "";
  }
  const plural = requestedTeamCount === 1 ? "team" : "teams";
  return `\n\n${requestedTeamCount} requested reviewer ${plural} could not be mentioned here; the original review request still stands.`;
}

/**
 * The notice has to be actionable on its own: it names the people who can move
 * the pull request, states the deadline, and lists every way to stop the clock.
 */
export function renderNotice({ idleDays, warnAfterDays, closeAfterDays, exemptLabels, mentions, requestedTeamCount }) {
  const remainingDays = Math.max(closeAfterDays - warnAfterDays, 0);
  const escapeHatch = exemptLabels.map((label) => `\`${label}\``).join(" or ");

  return `${NOTICE_MARKER}
${renderMentions(mentions)}this pull request has had no activity for ${idleDays} day(s).

OpenTag closes pull requests after **${closeAfterDays} days** without activity, so this one is scheduled to close in about ${remainingDays} day(s). Any of these resets the clock:

- push a commit
- leave a comment
- submit a review

To keep it open indefinitely, add the ${escapeHatch} label, or convert it to a draft.

See [the pull request policy](${POLICY_LINK}).${renderTeamHint(requestedTeamCount)}`;
}

export function renderClosingNotice({ idleDays, closeAfterDays, exemptLabels }) {
  const escapeHatch = exemptLabels.map((label) => `\`${label}\``).join(" or ");

  return `${CLOSED_MARKER}
Closing this pull request: it has had no activity for ${idleDays} day(s), past the ${closeAfterDays}-day limit, and the inactivity notice above went unanswered.

Nothing here is lost — the branch is untouched and anyone with write access can reopen the pull request. If the work is still wanted but simply needs more time, reopen it and add the ${escapeHatch} label.`;
}
