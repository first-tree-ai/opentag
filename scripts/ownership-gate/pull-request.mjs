const PER_PAGE = 100;

/** 3000 entries at 100 per page is the hard cap of the files endpoint; the rest is slack. */
const MAX_PAGES = 40;

const COMMIT_STATUS_STATES = new Set(["success", "failure", "error", "pending"]);

/** GitHub answers 422 rather than truncating an over-long status description. */
export const MAX_DESCRIPTION_LENGTH = 140;
const ELLIPSIS = "…";

/**
 * Review states that say nothing about approval. A COMMENTED review is a remark,
 * and a PENDING one has not been submitted at all, so neither may displace the
 * verdict the same reviewer left earlier.
 */
const NON_DECIDING_REVIEW_STATES = new Set(["COMMENTED", "PENDING"]);

/**
 * A REST author payload spells an app account with a `[bot]` suffix. Human
 * logins cannot contain brackets, so the suffix is a safe secondary signal
 * behind `user.type === "Bot"`, which is what the caller passes as `isBot`.
 */
const BOT_LOGIN_SUFFIX = /\[bot\]$/;

/**
 * Raised when the collected file list cannot be trusted. The files endpoint caps
 * at 3000 entries, and a gate that judged a partial list would wave through
 * paths it never saw, so the check fails closed instead of guessing.
 */
export class TruncatedFileListError extends Error {
  constructor(message, { collected, expected }) {
    super(message);
    this.name = "TruncatedFileListError";
    this.collected = collected;
    this.expected = expected;
  }
}

function encodeSegment(value) {
  return encodeURIComponent(String(value ?? ""));
}

function repositoryPath(owner, name) {
  return `/repos/${encodeSegment(owner)}/${encodeSegment(name)}`;
}

/**
 * Walks a paginated REST collection. Link headers are deliberately ignored: past
 * its 3000-entry cap the files endpoint serves an empty page while still
 * advertising a next link, so the page body -- not the link header -- is the
 * only trustworthy end-of-collection signal.
 */
async function collectPages(client, { path, logger, maxPages = MAX_PAGES }) {
  const entries = [];

  for (let page = 1; page <= maxPages; page += 1) {
    const batch = await client.rest("GET", `${path}?per_page=${PER_PAGE}&page=${page}`);
    const received = Array.isArray(batch) ? batch : [];
    logger.debug("Fetched a REST page", { path, page, received: received.length });
    if (received.length === 0) {
      return entries;
    }
    entries.push(...received);
    if (received.length < PER_PAGE) {
      return entries;
    }
  }

  logger.warn("Stopped paginating at the page cap", { path, maxPages, collected: entries.length });
  return entries;
}

function changedPaths(entry) {
  const paths = [];
  if (typeof entry?.filename === "string" && entry.filename.length > 0) {
    paths.push(entry.filename);
  }
  // A rename moves a file out of one directory and into another. The directory
  // it left lost a file, which is a change that directory's owners must see.
  if (typeof entry?.previous_filename === "string" && entry.previous_filename.length > 0) {
    paths.push(entry.previous_filename);
  }
  return paths;
}

/**
 * Every path the pull request touches, renames counted at both ends.
 *
 * `expectedCount` is the pull request's own `changed_files` field and is
 * compared against what pagination actually returned: the endpoint truncates
 * silently, and an incomplete list would let the gate pass a pull request it
 * exists to block.
 */
export async function fetchChangedFiles(client, { owner, name, number, expectedCount, logger }) {
  if (!Number.isInteger(expectedCount) || expectedCount < 0) {
    throw new TypeError("expectedCount must be the pull request's changed_files count");
  }

  const entries = await collectPages(client, {
    path: `${repositoryPath(owner, name)}/pulls/${number}/files`,
    logger,
  });

  if (entries.length !== expectedCount) {
    throw new TruncatedFileListError(
      `Collected ${entries.length} changed files but pull request #${number} reports ${expectedCount}`,
      { collected: entries.length, expected: expectedCount },
    );
  }

  const paths = entries.flatMap(changedPaths);
  logger.debug("Collected changed files", { number, entries: entries.length, paths: paths.length });
  return paths;
}

/**
 * The logins whose latest deciding review is an approval, lowercased so they can
 * be matched against CODEOWNERS entries.
 *
 * Reviews arrive oldest-first. Non-deciding states are dropped *before* the
 * last-per-user reduction, because a reviewer who approves and then leaves a
 * comment has not withdrawn anything -- taking the plain last review per user is
 * the classic bug and would block the very pull requests an owner just approved.
 * DISMISSED is a deciding state and does revoke.
 */
export async function fetchApprovals(client, { owner, name, number, headSha, logger }) {
  const reviews = await collectPages(client, {
    path: `${repositoryPath(owner, name)}/pulls/${number}/reviews`,
    logger,
  });

  const verdicts = new Map();
  for (const review of reviews) {
    const login = review?.user?.login;
    if (typeof login !== "string" || login.length === 0) {
      continue;
    }
    const state = String(review?.state ?? "").toUpperCase();
    if (NON_DECIDING_REVIEW_STATES.has(state)) {
      continue;
    }
    verdicts.set(login.toLowerCase(), { state, commitId: review?.commit_id ?? null });
  }

  const logins = new Set();
  const stale = [];
  for (const [login, verdict] of verdicts) {
    if (verdict.state !== "APPROVED") {
      continue;
    }
    logins.add(login);
    // An approval keeps counting after a later push, because
    // `dismiss_stale_reviews_on_push` is off. That is the accepted policy, not
    // an oversight -- but an approval of a diff that no longer exists should at
    // least be visible to whoever reads the verdict.
    if (typeof headSha === "string" && verdict.commitId !== null && verdict.commitId !== headSha) {
      stale.push(login);
    }
  }

  logger.debug("Resolved review approvals", {
    number,
    reviews: reviews.length,
    approvals: logins.size,
    stale: stale.length,
  });
  return { logins, stale: stale.sort() };
}

function isBotAuthor(login, isBot) {
  return isBot === true || BOT_LOGIN_SUFFIX.test(String(login ?? ""));
}

/**
 * On a public repository every signed-in stranger comes back as `read`, and the
 * `maintain` role comes back as `write`, so "not none" is not a write test. The
 * booleans hang off `user.permissions` in this response, not off the top level;
 * the coarse `permission` string is the fallback for responses that omit them.
 */
function grantsWriteAccess(payload) {
  if (payload?.user?.permissions?.push === true) {
    return true;
  }
  const permission = String(payload?.permission ?? "").toLowerCase();
  return permission === "admin" || permission === "write";
}

function describeLookupFailure(status, isFork) {
  if (status === 403) {
    return isFork
      ? "permission lookup denied; a fork pull request runs with a read-only token"
      : "permission lookup denied by GitHub";
  }
  if (status === 404) {
    return "author is not a collaborator, or the account no longer exists";
  }
  return status === null || status === undefined
    ? "permission lookup failed before GitHub answered"
    : `permission lookup failed with ${status}`;
}

/**
 * The last resort when the collaborators endpoint is unavailable. Only `OWNER`
 * is accepted: `MEMBER` is organization membership rather than repository
 * write, and `COLLABORATOR` also covers read-only and triage collaborators, so
 * either one would hand the untrusted-author floor to people the policy means
 * to catch. Everything else resolves to "no write access", which costs an
 * outside pull request one owner approval it was going to need anyway.
 */
const WRITE_ASSOCIATIONS = new Set(["OWNER"]);

function accessFromAssociation(association, reason) {
  const normalized = String(association ?? "").toUpperCase();
  if (!WRITE_ASSOCIATIONS.has(normalized)) {
    return { hasWriteAccess: false, reason: `${reason}; author association is ${normalized || "unknown"}` };
  }
  return { hasWriteAccess: true, reason: `${reason}; author association is ${normalized}` };
}

/**
 * Whether the pull request author may merge here, and why.
 *
 * Never throws, and answers without an API call in the two cases that matter
 * most. A bot is never treated as having write access, whatever it can push. A
 * pull request whose head branch lives in this repository was pushed here, which
 * already takes write access -- and that is the case where the `apps/web`
 * exemption has to stay frictionless, so it must not hang on an endpoint that
 * can be unavailable.
 *
 * That leaves fork pull requests, where the collaborators endpoint is both the
 * right answer and the one that can fail: it requires push access on the
 * *calling* token. A failure falls back to the author association, which accepts
 * only `OWNER`, so an unresolvable fork author is treated as untrusted and picks
 * up the single owner approval the policy asks of outside contributors anyway.
 */
export async function fetchAuthorAccess(
  client,
  { owner, name, login, isBot = false, isFork = false, authorAssociation, logger },
) {
  if (typeof login !== "string" || login.length === 0) {
    return { hasWriteAccess: false, reason: "the pull request has no identifiable author" };
  }
  if (isBotAuthor(login, isBot)) {
    return { hasWriteAccess: false, reason: "author is a bot account" };
  }
  if (!isFork) {
    return { hasWriteAccess: true, reason: "the head branch is in this repository, which takes write access" };
  }

  const path = `${repositoryPath(owner, name)}/collaborators/${encodeSegment(login)}/permission`;
  try {
    const payload = await client.rest("GET", path);
    if (grantsWriteAccess(payload)) {
      return { hasWriteAccess: true, reason: "author has write access" };
    }
    const permission = String(payload?.permission ?? "none").toLowerCase();
    return { hasWriteAccess: false, reason: `author has ${permission} access, which is below write` };
  } catch (error) {
    const status = error?.status ?? null;
    const reason = describeLookupFailure(status, isFork);
    logger.warn("Could not read author permission; falling back to the author association", {
      login,
      status,
      reason,
      authorAssociation,
    });
    return accessFromAssociation(authorAssociation, reason);
  }
}

/**
 * Caps a description at what the API accepts. The natural description lists the
 * unapproved paths and overflows on a wide pull request, and GitHub rejects the
 * whole request rather than trimming it -- which would strand a required check
 * on pending forever.
 *
 * It lives here rather than with the other rendering because the 140-character
 * limit is this endpoint's contract, not a presentation choice: whatever else
 * changes, nothing may reach the API untruncated.
 */
export function truncateDescription(description, limit = MAX_DESCRIPTION_LENGTH) {
  const text = typeof description === "string" ? description : "";
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit - ELLIPSIS.length)}${ELLIPSIS}`;
}

/**
 * Publishes the gate's verdict on a commit. Re-posting to the same sha and
 * context is the supported way to update a status -- the latest one wins -- so
 * there is nothing to reconcile and the client's default retries stay on.
 */
export async function postCommitStatus(client, { owner, name, sha, state, context, description, targetUrl, logger }) {
  if (!COMMIT_STATUS_STATES.has(state)) {
    throw new TypeError(
      `Unsupported commit status state "${state}"; expected one of ${[...COMMIT_STATUS_STATES].join(", ")}`,
    );
  }

  logger.debug("Posting commit status", { sha, state, context });
  return client.rest("POST", `${repositoryPath(owner, name)}/statuses/${encodeSegment(sha)}`, {
    state,
    context,
    description: truncateDescription(description),
    target_url: targetUrl ?? null,
  });
}
