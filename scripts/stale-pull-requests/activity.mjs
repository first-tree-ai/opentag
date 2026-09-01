/**
 * Hidden marker carried by every notice this sweep posts. It is the durable
 * state of the workflow: the label is cosmetic and can be removed by hand, but
 * the marker survives, so a run that finds it knows the author was already told.
 */
export const NOTICE_MARKER = "<!-- opentag-stale-pull-requests:notice -->";

/** Marks the farewell comment, so a close that failed halfway is not re-announced. */
export const CLOSED_MARKER = "<!-- opentag-stale-pull-requests:closed -->";

const COMMIT_ITEM = "PullRequestCommit";

/**
 * GraphQL reports the Actions identity as `github-actions` while REST reports
 * `github-actions[bot]`. Normalizing both ways is what keeps the sweep from
 * treating its own notice as human activity and resetting its own clock.
 */
export function normalizeLogin(login) {
  if (typeof login !== "string" || login.length === 0) {
    return null;
  }
  return login.toLowerCase().replace(/\[bot\]$/, "");
}

export function isSweepActor(actor, botLogins) {
  const login = normalizeLogin(actor?.login);
  return login !== null && botLogins.includes(login);
}

function commitActivity(item) {
  const commit = item.commit ?? {};
  return {
    actor: commit.author?.user ?? commit.committer?.user ?? null,
    // `committedDate` is a rewrite timestamp that a rebase can move backwards,
    // so the later of the two is the honest "someone worked on this" signal.
    timestamps: [commit.committedDate, commit.authoredDate],
  };
}

/**
 * Newest comment on one review thread. Replies typed into a thread do not
 * reliably produce a `PullRequestReview` timeline item -- a reply days after the
 * original review often produces none at all -- so review threads are read from
 * their own connection rather than from the timeline.
 */
export function reviewThreadActivity(thread) {
  const comment = thread?.comments?.nodes?.at(-1) ?? null;
  return { actor: comment?.author ?? null, timestamps: [comment?.createdAt] };
}

function eventActivity(item) {
  return {
    // Event items expose `actor`, comments and reviews expose `author`; a null
    // actor is a deleted account, which must still count as a human.
    actor: item.actor ?? item.author ?? null,
    // `submittedAt` is null on a pending review, hence the `createdAt` fallback.
    timestamps: [item.submittedAt, item.createdAt],
  };
}

/** Extracts the actor and candidate timestamps for one timeline item. */
export function timelineActivity(item) {
  if (item?.__typename === COMMIT_ITEM) {
    return commitActivity(item);
  }
  return eventActivity(item ?? {});
}

function humanTimestamps(nodes, botLogins, extract) {
  const timestamps = [];
  for (const node of nodes) {
    const activity = extract(node);
    if (isSweepActor(activity.actor, botLogins)) {
      continue;
    }
    timestamps.push(...activity.timestamps.filter((value) => typeof value === "string"));
  }
  return timestamps;
}

function newerTimestamp(left, right) {
  return Date.parse(left) >= Date.parse(right) ? left : right;
}

/**
 * Resolves the last activity that was not this sweep's own bookkeeping.
 *
 * The timeline is queried newest-first, so truncation can only hide old items,
 * which cannot change a maximum. The single exception is a timeline whose newest
 * page is entirely this sweep's own events: then the real activity is off-page
 * and the result is reported as truncated so the caller leaves it alone.
 *
 * Timestamps after `now` are discarded: `authoredDate` is whatever the
 * contributor's clock said, so a future-dated commit would otherwise pin a pull
 * request open forever.
 */
export function resolveLastActivity({ createdAt, timelineNodes, reviewThreadNodes, hasOlderTimeline, botLogins, now }) {
  const nowMillis = Date.parse(now);
  const timeline = humanTimestamps(timelineNodes ?? [], botLogins, timelineActivity);
  const threads = humanTimestamps(reviewThreadNodes ?? [], botLogins, reviewThreadActivity);
  const usable = [...timeline, ...threads].filter((value) => Date.parse(value) <= nowMillis);
  return {
    lastActivityAt: usable.reduce(newerTimestamp, createdAt),
    activityTruncated: timeline.length === 0 && hasOlderTimeline === true,
  };
}

function isMarkedComment(comment, marker) {
  return typeof comment?.body === "string" && comment.body.includes(marker) && comment.author?.__typename === "Bot";
}

/** Finds the most recent bot comment carrying `marker`, or null if there is none. */
export function findMarkedComment(commentNodes, marker) {
  let newest = null;
  for (const comment of commentNodes ?? []) {
    if (!isMarkedComment(comment, marker)) {
      continue;
    }
    if (newest === null || Date.parse(comment.createdAt) > Date.parse(newest.createdAt)) {
      newest = comment;
    }
  }
  return newest === null ? null : { commentId: newest.id, postedAt: newest.createdAt };
}

/** Finds the most recent notice this sweep posted, or null if there is none. */
export function findNotice(commentNodes, { marker = NOTICE_MARKER } = {}) {
  return findMarkedComment(commentNodes, marker);
}

function pushUserLogin(target, actor) {
  if (actor?.__typename === "User" && typeof actor.login === "string") {
    target.push(actor.login);
  }
}

/**
 * Collects the people worth @-mentioning: the author, anyone with an open review
 * request, and anyone who already reviewed. Teams are deliberately excluded --
 * a team mention posted by a GitHub App renders as plain text and notifies
 * nobody, and the review request itself already notified the team.
 */
export function collectMentions(node, { botLogins = [] } = {}) {
  const logins = [];
  pushUserLogin(logins, node.author);
  for (const request of node.reviewRequests?.nodes ?? []) {
    pushUserLogin(logins, request?.requestedReviewer);
  }
  for (const review of node.latestReviews?.nodes ?? []) {
    pushUserLogin(logins, review?.author);
  }
  const seen = new Set(botLogins);
  return logins.filter((login) => {
    const key = normalizeLogin(login);
    if (key === null || seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function countRequestedTeams(node) {
  return (node.reviewRequests?.nodes ?? []).filter((request) => request?.requestedReviewer?.__typename === "Team")
    .length;
}

/** Projects one GraphQL pull request node onto the flat facts the policy needs. */
export function normalizePullRequest(node, { botLogins, staleLabel, now, marker = NOTICE_MARKER }) {
  const labels = (node.labels?.nodes ?? []).map((label) => label.name);
  const comments = node.comments?.nodes;
  const activity = resolveLastActivity({
    createdAt: node.createdAt,
    timelineNodes: node.timelineItems?.nodes,
    reviewThreadNodes: node.reviewThreads?.nodes,
    hasOlderTimeline: node.timelineItems?.pageInfo?.hasPreviousPage,
    botLogins,
    now,
  });

  return {
    id: node.id,
    number: node.number,
    title: node.title,
    url: node.url,
    isDraft: node.isDraft === true,
    authorLogin: node.author?.login ?? null,
    authorKey: normalizeLogin(node.author?.login),
    labels,
    hasStaleLabel: labels.includes(staleLabel),
    createdAt: node.createdAt,
    lastActivityAt: activity.lastActivityAt,
    activityTruncated: activity.activityTruncated,
    notice: findMarkedComment(comments, marker),
    // A close that failed after its farewell was posted must not re-announce
    // itself on every later run.
    hasFarewell: findMarkedComment(comments, CLOSED_MARKER) !== null,
    mentions: collectMentions(node, { botLogins }),
    requestedTeamCount: countRequestedTeams(node),
  };
}
