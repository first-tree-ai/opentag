import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createGitHubClient } from "../github/client.mjs";
import { createLogger } from "../logger.mjs";
import {
  CLOSED_MARKER,
  collectMentions,
  findNotice,
  NOTICE_MARKER,
  normalizePullRequest,
} from "../stale-pull-requests/activity.mjs";
import { createPullRequestActions, executeDecisions } from "../stale-pull-requests/executor.mjs";
import {
  ACTION_CLOSE,
  ACTION_NONE,
  ACTION_SKIP,
  ACTION_WARN,
  decidePullRequest,
} from "../stale-pull-requests/policy.mjs";
import { PULL_REQUESTS_QUERY } from "../stale-pull-requests/query.mjs";
import { buildConfig, parseRepository, planSweep } from "../stale-pull-requests.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const workflowPath = join(repoRoot, ".github", "workflows", "stale-pull-requests.yml");

const NOW = "2026-09-01T00:00:00.000Z";
const MS_PER_DAY = 86_400_000;

function daysAgo(days) {
  return new Date(Date.parse(NOW) - days * MS_PER_DAY).toISOString();
}

function config(overrides = {}) {
  return {
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
    ...overrides,
  };
}

function pullRequest(overrides = {}) {
  return {
    number: 1,
    title: "Add a thing",
    url: "https://github.com/first-tree-ai/opentag/pull/1",
    isDraft: false,
    authorLogin: "alice",
    authorKey: "alice",
    labels: [],
    hasStaleLabel: false,
    createdAt: daysAgo(30),
    lastActivityAt: daysAgo(1),
    activityTruncated: false,
    notice: null,
    hasFarewell: false,
    mentions: ["alice"],
    requestedTeamCount: 0,
    ...overrides,
  };
}

function decide(overrides, configOverrides = {}) {
  return decidePullRequest({ pullRequest: pullRequest(overrides), config: config(configOverrides), now: NOW });
}

const silentLogger = createLogger({
  level: "error",
  sink: {
    log: () => {},
    warn: () => {},
    error: () => {},
  },
});

function recordingActions(failOn = new Set()) {
  const calls = [];
  const record = async (kind, ...args) => {
    if (failOn.has(`${kind}:${args[0]}`)) {
      throw new Error(`${kind} failed`);
    }
    calls.push([kind, ...args]);
  };
  return {
    calls,
    comment: (number, body) => record("comment", number, body),
    addLabel: (number, label) => record("addLabel", number, label),
    removeLabel: (number, label) => record("removeLabel", number, label),
    close: (number) => record("close", number),
    createLabel: (name) => record("createLabel", name),
  };
}

// --- Policy -----------------------------------------------------------------

test("a pull request touched inside the notice window is left alone", () => {
  const decision = decide({ lastActivityAt: daysAgo(4.9) });
  assert.equal(decision.action, ACTION_NONE);
  assert.equal(decision.desiredStaleLabel, false);
});

test("a pull request idle past the notice window is notified and marked stale", () => {
  const decision = decide({ lastActivityAt: daysAgo(5.1) });
  assert.equal(decision.action, ACTION_WARN);
  assert.equal(decision.desiredStaleLabel, true);
});

test("a notified pull request is not notified again while it is inside the close window", () => {
  const decision = decide({
    lastActivityAt: daysAgo(6),
    notice: { commentId: "c1", postedAt: daysAgo(1) },
  });
  assert.equal(decision.action, ACTION_NONE);
  assert.equal(decision.desiredStaleLabel, true);
});

test("a notified pull request past the close window is closed once the grace period elapses", () => {
  const decision = decide({
    lastActivityAt: daysAgo(8),
    hasStaleLabel: true,
    notice: { commentId: "c1", postedAt: daysAgo(3) },
  });
  assert.equal(decision.action, ACTION_CLOSE);
  assert.equal(decision.idleDays, 8);
});

test("a backlog pull request is notified first and can only be closed on a later run", () => {
  // The whole point of the grace period: a pull request idle for a month must
  // still get a notice and a real window to answer it, not a same-run close.
  const firstRun = decide({ lastActivityAt: daysAgo(30) });
  assert.equal(firstRun.action, ACTION_WARN);

  const sameDayRerun = decide({
    lastActivityAt: daysAgo(30),
    hasStaleLabel: true,
    notice: { commentId: "c1", postedAt: daysAgo(0.1) },
  });
  assert.equal(sameDayRerun.action, ACTION_NONE);
  assert.match(sameDayRerun.reason, /grace period/);
});

test("activity after a notice supersedes it and clears the stale label", () => {
  const decision = decide({
    lastActivityAt: daysAgo(1),
    hasStaleLabel: true,
    notice: { commentId: "c1", postedAt: daysAgo(3) },
  });
  assert.equal(decision.action, ACTION_NONE);
  assert.equal(decision.desiredStaleLabel, false);
});

test("a notice older than the last activity is superseded rather than counted", () => {
  // Reached inside the stale branch, where supersession actually decides
  // between notifying afresh and closing. Idle 8 days would close if the stale
  // notice still counted.
  const superseded = decide({
    lastActivityAt: daysAgo(6),
    notice: { commentId: "c1", postedAt: daysAgo(7) },
  });
  assert.equal(superseded.action, ACTION_WARN);

  const stillValid = decide({
    lastActivityAt: daysAgo(8),
    notice: { commentId: "c1", postedAt: daysAgo(3) },
  });
  assert.equal(stillValid.action, ACTION_CLOSE);
});

test("a notice posted in the same instant as the last activity still counts", () => {
  const decision = decide({
    lastActivityAt: daysAgo(8),
    notice: { commentId: "c1", postedAt: daysAgo(8) },
  });
  assert.equal(decision.action, ACTION_CLOSE, "an equal timestamp must not be treated as superseded");
});

test("a revived pull request that goes quiet again is notified afresh instead of closed", () => {
  const decision = decide({
    lastActivityAt: daysAgo(8),
    hasStaleLabel: true,
    notice: { commentId: "c1", postedAt: daysAgo(20) },
  });
  assert.equal(decision.action, ACTION_WARN);
});

test("drafts are exempt", () => {
  const decision = decide({ isDraft: true, lastActivityAt: daysAgo(90) });
  assert.equal(decision.action, ACTION_SKIP);
  assert.match(decision.reason, /draft/);
});

test("an exempt label keeps a long-idle pull request open and drops the stale label", () => {
  const decision = decide({
    labels: ["keep-open", "stale"],
    hasStaleLabel: true,
    lastActivityAt: daysAgo(90),
  });
  assert.equal(decision.action, ACTION_SKIP);
  assert.equal(decision.desiredStaleLabel, false);
});

test("an exempt author is never notified or closed", () => {
  const decision = decide({ authorKey: "dependabot", lastActivityAt: daysAgo(90) }, { exemptAuthors: ["dependabot"] });
  assert.equal(decision.action, ACTION_SKIP);
  assert.match(decision.reason, /exempt author/);
});

test("a truncated activity history leaves the pull request exactly as it is", () => {
  const decision = decide({ activityTruncated: true, hasStaleLabel: true, lastActivityAt: daysAgo(90) });
  assert.deepEqual(decision, {
    action: ACTION_SKIP,
    reason: "activity history is truncated; last human activity cannot be dated",
    idleDays: null,
    desiredStaleLabel: true,
  });
});

test("a close window at or below the notice window is rejected", () => {
  assert.throws(() => decide({}, { closeAfterDays: 5 }), /closeAfterDays/);
  assert.throws(() => decide({}, { graceHours: 0 }), /graceHours/);
});

// --- Activity resolution ----------------------------------------------------

function graphqlNode(overrides = {}) {
  return {
    id: "PR_1",
    number: 7,
    title: "Add a thing",
    url: "https://github.com/first-tree-ai/opentag/pull/7",
    createdAt: daysAgo(30),
    isDraft: false,
    author: { __typename: "User", login: "alice" },
    labels: { nodes: [] },
    reviewRequests: { nodes: [] },
    latestReviews: { nodes: [] },
    comments: { nodes: [] },
    reviewThreads: { nodes: [] },
    timelineItems: { pageInfo: { hasPreviousPage: false }, nodes: [] },
    ...overrides,
  };
}

function noticeComment(postedAt) {
  return {
    id: "IC_notice",
    createdAt: postedAt,
    body: `${NOTICE_MARKER}\n@alice — this pull request has had no activity.`,
    author: { __typename: "Bot", login: "github-actions" },
  };
}

test("the sweep's own notice never counts as activity, so a notified pull request still closes", () => {
  // The regression this whole design exists to prevent: the notice bumps
  // updatedAt, and a sweep that trusted updatedAt would reset its own clock and
  // never close anything.
  const node = graphqlNode({
    comments: { nodes: [noticeComment(daysAgo(3))] },
    timelineItems: {
      pageInfo: { hasPreviousPage: false },
      nodes: [
        { __typename: "IssueComment", createdAt: daysAgo(10), author: { __typename: "User", login: "bob" } },
        { __typename: "IssueComment", createdAt: daysAgo(3), author: { __typename: "Bot", login: "github-actions" } },
        {
          __typename: "LabeledEvent",
          createdAt: daysAgo(3),
          actor: { __typename: "Bot", login: "github-actions" },
        },
      ],
    },
  });

  const [{ pullRequest, decision }] = planSweep({ nodes: [node], config: config(), now: NOW });
  assert.equal(pullRequest.lastActivityAt, daysAgo(10));
  assert.equal(decision.action, ACTION_CLOSE);
});

test("another bot's activity still counts, so a maintained pull request is not closed", () => {
  const node = graphqlNode({
    timelineItems: {
      pageInfo: { hasPreviousPage: false },
      nodes: [
        { __typename: "IssueComment", createdAt: daysAgo(1), author: { __typename: "Bot", login: "dependabot" } },
      ],
    },
  });

  const [{ decision }] = planSweep({ nodes: [node], config: config(), now: NOW });
  assert.equal(decision.action, ACTION_NONE);
});

test("commit activity uses the later of the committed and authored dates", () => {
  // A rebase rewrites committedDate and can move it either way; taking the max
  // keeps a freshly pushed branch from looking abandoned.
  const node = graphqlNode({
    timelineItems: {
      pageInfo: { hasPreviousPage: false },
      nodes: [
        {
          __typename: "PullRequestCommit",
          commit: {
            committedDate: daysAgo(20),
            authoredDate: daysAgo(2),
            author: { user: { login: "alice" } },
            committer: { user: null },
          },
        },
      ],
    },
  });

  const normalized = normalizePullRequest(node, { botLogins: ["github-actions"], staleLabel: "stale", now: NOW });
  assert.equal(normalized.lastActivityAt, daysAgo(2));
});

test("a review thread reply counts as activity even with nothing on the timeline", () => {
  // A reply typed into an existing review thread frequently produces no
  // PullRequestReview timeline item at all, so review threads must be read from
  // their own connection. Without this the pull request below looks 30 days
  // idle and gets closed while a review is actively in progress.
  const node = graphqlNode({
    reviewThreads: {
      nodes: [
        { comments: { nodes: [{ createdAt: daysAgo(40), author: { __typename: "User", login: "bob" } }] } },
        { comments: { nodes: [{ createdAt: daysAgo(2), author: { __typename: "User", login: "carol" } }] } },
      ],
    },
  });

  const [{ pullRequest, decision }] = planSweep({ nodes: [node], config: config(), now: NOW });
  assert.equal(pullRequest.lastActivityAt, daysAgo(2));
  assert.equal(decision.action, ACTION_NONE);
});

test("the sweep's own review thread comment does not count as activity", () => {
  const node = graphqlNode({
    reviewThreads: {
      nodes: [
        { comments: { nodes: [{ createdAt: daysAgo(1), author: { __typename: "Bot", login: "github-actions" } }] } },
      ],
    },
  });

  const normalized = normalizePullRequest(node, { botLogins: ["github-actions"], staleLabel: "stale", now: NOW });
  assert.equal(normalized.lastActivityAt, daysAgo(30), "must fall back to createdAt");
});

test("a future-dated commit cannot pin a pull request open forever", () => {
  // authoredDate is whatever the contributor's clock said, so it is not trusted
  // past `now`.
  const node = graphqlNode({
    createdAt: daysAgo(60),
    timelineItems: {
      pageInfo: { hasPreviousPage: false },
      nodes: [
        {
          __typename: "PullRequestCommit",
          commit: {
            committedDate: daysAgo(40),
            authoredDate: daysAgo(-3650),
            author: { user: { login: "alice" } },
            committer: { user: null },
          },
        },
      ],
    },
  });

  const normalized = normalizePullRequest(node, { botLogins: ["github-actions"], staleLabel: "stale", now: NOW });
  assert.equal(normalized.lastActivityAt, daysAgo(40));
});

test("a pull request with no activity at all falls back to its creation date", () => {
  const node = graphqlNode({ createdAt: daysAgo(60) });
  const normalized = normalizePullRequest(node, { botLogins: ["github-actions"], staleLabel: "stale", now: NOW });
  assert.equal(normalized.lastActivityAt, daysAgo(60));
  assert.equal(normalized.activityTruncated, false);
});

test("a deleted account's comment still counts as human activity", () => {
  const node = graphqlNode({
    timelineItems: {
      pageInfo: { hasPreviousPage: false },
      nodes: [{ __typename: "IssueComment", createdAt: daysAgo(2), author: null }],
    },
  });

  const normalized = normalizePullRequest(node, { botLogins: ["github-actions"], staleLabel: "stale", now: NOW });
  assert.equal(normalized.lastActivityAt, daysAgo(2));
  assert.equal(normalized.activityTruncated, false);
});

test("a newest timeline page made entirely of sweep events is reported as truncated", () => {
  const node = graphqlNode({
    timelineItems: {
      pageInfo: { hasPreviousPage: true },
      nodes: [
        { __typename: "LabeledEvent", createdAt: daysAgo(1), actor: { __typename: "Bot", login: "github-actions" } },
      ],
    },
  });

  const normalized = normalizePullRequest(node, { botLogins: ["github-actions"], staleLabel: "stale", now: NOW });
  assert.equal(normalized.activityTruncated, true);
});

test("the newest notice wins and only a bot-authored marker counts", () => {
  const notice = findNotice([
    noticeComment(daysAgo(9)),
    { id: "IC_human", createdAt: daysAgo(1), body: NOTICE_MARKER, author: { __typename: "User", login: "mallory" } },
    { ...noticeComment(daysAgo(4)), id: "IC_recent" },
  ]);
  assert.deepEqual(notice, { commentId: "IC_recent", postedAt: daysAgo(4) });
});

test("mentions cover the author, requested reviewers and past reviewers, but never teams or bots", () => {
  const mentions = collectMentions(
    {
      author: { __typename: "User", login: "alice" },
      reviewRequests: {
        nodes: [
          { requestedReviewer: { __typename: "User", login: "bob" } },
          { requestedReviewer: { __typename: "Team" } },
          { requestedReviewer: { __typename: "Bot", login: "dependabot" } },
        ],
      },
      latestReviews: {
        nodes: [{ author: { __typename: "User", login: "carol" } }, { author: { __typename: "User", login: "alice" } }],
      },
    },
    { botLogins: ["github-actions"] },
  );
  assert.deepEqual(mentions, ["alice", "bob", "carol"]);
});

// --- Execution --------------------------------------------------------------

function entryFor(overrides, decisionOverrides) {
  const pr = pullRequest(overrides);
  return {
    pullRequest: pr,
    decision: { ...decidePullRequest({ pullRequest: pr, config: config(), now: NOW }), ...decisionOverrides },
  };
}

test("a dry run decides everything and mutates nothing", async () => {
  const actions = recordingActions();
  const execution = await executeDecisions({
    entries: [entryFor({ number: 11, lastActivityAt: daysAgo(9), notice: { commentId: "c", postedAt: daysAgo(3) } })],
    actions,
    config: config(),
    logger: silentLogger,
    dryRun: true,
    sleepImpl: async () => {},
  });

  assert.deepEqual(actions.calls, []);
  assert.equal(execution.closed, 1);
});

test("the close cap defers the remaining pull requests to the next run", async () => {
  const entries = [12, 13, 14].map((number) =>
    entryFor({ number, lastActivityAt: daysAgo(9), notice: { commentId: "c", postedAt: daysAgo(3) } }),
  );
  const actions = recordingActions();
  const execution = await executeDecisions({
    entries,
    actions,
    config: config({ maxCloses: 2 }),
    logger: silentLogger,
    sleepImpl: async () => {},
  });

  assert.equal(execution.closed, 2);
  assert.deepEqual(execution.cappedNumbers, [14]);
  assert.deepEqual(
    actions.calls.filter(([kind]) => kind === "close").map(([, number]) => number),
    [12, 13],
  );
});

test("closing announces itself first, with the farewell marker and not the notice marker", async () => {
  const actions = recordingActions();
  await executeDecisions({
    entries: [entryFor({ number: 41, lastActivityAt: daysAgo(9), notice: { commentId: "c", postedAt: daysAgo(3) } })],
    actions,
    config: config(),
    logger: silentLogger,
    sleepImpl: async () => {},
  });

  const [comment, close] = actions.calls;
  assert.equal(comment[0], "comment");
  assert.equal(close[0], "close");
  assert.ok(comment[2].includes(CLOSED_MARKER), "the farewell must carry the closed marker");
  assert.ok(!comment[2].includes(NOTICE_MARKER), "the farewell must not be mistaken for a notice");
});

test("a close that already announced itself is not announced again", async () => {
  // The close failed on an earlier run after the farewell landed; retrying must
  // not post a second identical farewell every day thereafter.
  const actions = recordingActions();
  await executeDecisions({
    entries: [
      entryFor({
        number: 42,
        lastActivityAt: daysAgo(9),
        notice: { commentId: "c", postedAt: daysAgo(3) },
        hasFarewell: true,
      }),
    ],
    actions,
    config: config(),
    logger: silentLogger,
    sleepImpl: async () => {},
  });

  assert.deepEqual(actions.calls, [
    ["close", 42],
    ["addLabel", 42, "stale"],
  ]);
});

test("mutations are spaced by the configured delay, and a dry run never sleeps", async () => {
  const delays = [];
  const entries = [entryFor({ number: 51, lastActivityAt: daysAgo(6) })];
  await executeDecisions({
    entries,
    actions: recordingActions(),
    config: config(),
    logger: silentLogger,
    delayMillis: 1500,
    sleepImpl: async (ms) => delays.push(ms),
  });
  assert.deepEqual(delays, [1500], "one gap between the two mutations, none before the first");

  const dryDelays = [];
  await executeDecisions({
    entries,
    actions: recordingActions(),
    config: config(),
    logger: silentLogger,
    delayMillis: 1500,
    dryRun: true,
    sleepImpl: async (ms) => dryDelays.push(ms),
  });
  assert.deepEqual(dryDelays, []);
});

test("a failure on one pull request does not strand the rest of the sweep", async () => {
  const actions = recordingActions(new Set(["close:21"]));
  const execution = await executeDecisions({
    entries: [21, 22].map((number) =>
      entryFor({ number, lastActivityAt: daysAgo(9), notice: { commentId: "c", postedAt: daysAgo(3) } }),
    ),
    actions,
    config: config(),
    logger: silentLogger,
    sleepImpl: async () => {},
  });

  assert.deepEqual(
    execution.results.map((result) => result.outcome),
    ["failed", ACTION_CLOSE],
  );
});

test("the stale label is reconciled in both directions", async () => {
  const actions = recordingActions();
  await executeDecisions({
    entries: [
      entryFor({ number: 31, lastActivityAt: daysAgo(6) }),
      entryFor({ number: 32, lastActivityAt: daysAgo(1), hasStaleLabel: true }),
    ],
    actions,
    config: config(),
    logger: silentLogger,
    sleepImpl: async () => {},
  });

  assert.deepEqual(
    actions.calls.filter(([kind]) => kind !== "comment"),
    [
      ["addLabel", 31, "stale"],
      ["removeLabel", 32, "stale"],
    ],
  );
});

// --- GitHub client ----------------------------------------------------------

function fakeResponse({ status = 200, body = {}, headers = {} }) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    text: async () => JSON.stringify(body),
  };
}

function scriptedClient(steps, options = {}) {
  const calls = [];
  const sleeps = [];
  const client = createGitHubClient({
    token: "t",
    logger: silentLogger,
    sleepImpl: async (ms) => {
      sleeps.push(ms);
    },
    fetchImpl: async (url, init) => {
      calls.push(`${init.method} ${url}`);
      const step = steps[Math.min(calls.length - 1, steps.length - 1)];
      if (step instanceof Error) {
        throw step;
      }
      return fakeResponse(step);
    },
    ...options,
  });
  return { client, calls, sleeps };
}

test("a transient 502 is retried until it succeeds", async () => {
  const { client, calls } = scriptedClient([{ status: 502 }, { status: 502 }, { status: 200, body: { ok: true } }]);
  assert.deepEqual(await client.rest("GET", "/x"), { ok: true });
  assert.equal(calls.length, 3);
});

test("a 403 that is a permission failure is thrown at once, not retried", async () => {
  const { client, calls, sleeps } = scriptedClient([
    { status: 403, headers: { "x-ratelimit-remaining": "4832" }, body: { message: "Resource not accessible" } },
  ]);
  await assert.rejects(() => client.rest("PATCH", "/x"), /403/);
  assert.equal(calls.length, 1, "a permission failure must not be hammered");
  assert.deepEqual(sleeps, []);
});

test("a secondary rate limit is retried on the strength of retry-after alone", async () => {
  // The abuse limit leaves the quota untouched, so remaining is not "0"; the
  // retry-after header is the only signal that this is throttling, not denial.
  const { client, calls, sleeps } = scriptedClient([
    { status: 403, headers: { "retry-after": "2", "x-ratelimit-remaining": "4832" } },
    { status: 200, body: { ok: true } },
  ]);
  await client.rest("GET", "/x");
  assert.equal(calls.length, 2);
  assert.deepEqual(sleeps, [2000]);
});

test("a request that never reached GitHub is retried", async () => {
  const { client, calls } = scriptedClient([new TypeError("fetch failed"), { status: 200, body: { ok: true } }]);
  await client.rest("GET", "/x");
  assert.equal(calls.length, 2);
});

test("retries are capped and the last failure is rethrown", async () => {
  const { client, calls } = scriptedClient([{ status: 503 }]);
  await assert.rejects(() => client.rest("GET", "/x"), /503/);
  assert.equal(calls.length, 4, "one attempt plus the three configured retries");
});

test("a non-idempotent call can opt out of retrying entirely", async () => {
  const { client, calls } = scriptedClient([{ status: 502 }]);
  const actions = createPullRequestActions({ client, owner: "o", name: "r" });
  await assert.rejects(() => actions.comment(7, "hello"), /502/);
  assert.equal(calls.length, 1, "GitHub may have committed the comment; a retry would duplicate it");
});

test("a GraphQL timeout arrives as HTTP 200 and is still retried", async () => {
  const { client, calls } = scriptedClient([
    { status: 200, body: { errors: [{ type: "SERVICE_UNAVAILABLE", message: "Something went wrong" }] } },
    { status: 200, body: { data: { ok: true } } },
  ]);
  assert.deepEqual(await client.graphql("query {}", {}), { ok: true });
  assert.equal(calls.length, 2);
});

test("a malformed GraphQL query fails immediately instead of being retried", async () => {
  const { client, calls } = scriptedClient([
    { status: 200, body: { errors: [{ type: "INVALID", message: "Field 'nope' doesn't exist" }] } },
  ]);
  await assert.rejects(() => client.graphql("query {}", {}), /doesn't exist/);
  assert.equal(calls.length, 1);
});

// --- Query ------------------------------------------------------------------

test("the query reads the newest page of every connection it depends on", () => {
  // timelineItems is ordered oldest-first, so `first:` would silently return
  // ancient history and make a busy pull request look abandoned.
  assert.match(PULL_REQUESTS_QUERY, /timelineItems\(last: \d+/);
  assert.match(PULL_REQUESTS_QUERY, /comments\(last: \d+\)/);
  assert.match(PULL_REQUESTS_QUERY, /reviewThreads\(last: \d+\)/);
  assert.match(PULL_REQUESTS_QUERY, /pullRequests\(states: OPEN, first: \d+/);
  assert.match(PULL_REQUESTS_QUERY, /hasPreviousPage/, "truncation is detected with pageInfo, not totalCount");
});

test("the query asks for no Team subfield, which GITHUB_TOKEN cannot read", () => {
  assert.doesNotMatch(PULL_REQUESTS_QUERY, /\.\.\. on Team \{/);
  assert.doesNotMatch(PULL_REQUESTS_QUERY, /pushedDate/, "Commit.pushedDate no longer exists in the schema");
});

// --- Configuration ----------------------------------------------------------

test("the defaults implement the documented five-then-seven day policy", () => {
  const parsed = buildConfig([]);
  assert.equal(parsed.warnAfterDays, 5);
  assert.equal(parsed.closeAfterDays, 7);
  assert.equal(parsed.exemptDrafts, true);
  assert.deepEqual(parsed.exemptLabels, ["keep-open"]);
  assert.deepEqual(parsed.botLogins, ["github-actions"]);
  assert.equal(parsed.dryRun, false);
});

test("bot and author logins are matched with or without the [bot] suffix", () => {
  const parsed = buildConfig(["--exempt-author", "Dependabot[bot]", "--bot-login", "GitHub-Actions[bot]"]);
  assert.deepEqual(parsed.exemptAuthors, ["dependabot"]);
  assert.deepEqual(parsed.botLogins, ["github-actions"]);
});

test("a repository must be given as owner/name", () => {
  assert.deepEqual(parseRepository("first-tree-ai/opentag"), { owner: "first-tree-ai", name: "opentag" });
  assert.throws(() => parseRepository("opentag"), /owner\/name/);
  assert.throws(() => parseRepository(undefined), /owner\/name/);
});

// --- Workflow -----------------------------------------------------------------

test("the sweep runs on a schedule and manually, never on pull request events", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  assert.match(workflow, /^ {4}- cron: "[^"]+"$/m, "the sweep must be scheduled");
  assert.match(workflow, /^ {2}workflow_dispatch:$/m, "the sweep must be startable by hand");
  assert.doesNotMatch(workflow, /^ {2}pull_request(_target)?:/m, "a write-scoped sweep must not run on pull requests");
  assert.doesNotMatch(workflow, /cron: "(17|23) 3 \* \* 1"/, "the cron must not collide with the Monday 03:0x jobs");
});

test("write access is scoped to the sweep job and forks are excluded", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  assert.match(workflow, /^permissions:\n {2}contents: read\n/m, "the workflow default must stay read-only");
  assert.match(workflow, /if: github\.repository == 'first-tree-ai\/opentag'/, "forks must not close their own PRs");
  assert.match(workflow, /permissions:\n {6}contents: read\n {6}pull-requests: write\n/);
  assert.doesNotMatch(workflow, /issues: write/, "the sweep only touches pull requests");
});

test("every action is pinned to a full commit SHA", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  for (const line of workflow.split(/\r?\n/).filter((candidate) => candidate.includes("uses: "))) {
    assert.match(line, /uses: [^@]+@[0-9a-f]{40} # v\d/, `unpinned action: ${line.trim()}`);
  }
});

test("no expression is interpolated straight into the shell", async () => {
  // actionlint rejects it as a script-injection risk; every value must arrive
  // through the step env block instead.
  const workflow = await readFile(workflowPath, "utf8");
  const runBlock = workflow.slice(workflow.indexOf("run: |"));
  assert.doesNotMatch(runBlock, /\$\{\{/, "run: blocks must read values from env, not from expressions");
});
