import assert from "node:assert/strict";
import test from "node:test";
import { createGitHubClient } from "../github/client.mjs";
import { createLogger } from "../logger.mjs";
import {
  fetchApprovals,
  fetchAuthorAccess,
  fetchChangedFiles,
  postCommitStatus,
  TruncatedFileListError,
} from "../ownership-gate/pull-request.mjs";

const silentLogger = createLogger({
  level: "error",
  sink: { log: () => {}, warn: () => {}, error: () => {} },
});

function recordingLogger() {
  const warnings = [];
  const logger = createLogger({
    level: "warn",
    sink: { log: () => {}, warn: (line) => warnings.push(line), error: () => {} },
  });
  return { logger, warnings };
}

function fakeResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
  };
}

/** Builds a client whose every request is recorded and answered by `handler`. */
function clientFor(handler, logger = silentLogger) {
  const requests = [];
  const client = createGitHubClient({
    token: "test-token",
    logger,
    sleepImpl: async () => {},
    fetchImpl: async (url, init) => {
      requests.push({ method: init.method, url, body: init.body === undefined ? null : JSON.parse(init.body) });
      return handler(url, init);
    },
  });
  return { client, requests };
}

/** Serves one page per array entry and asserts the pagination contract on the way. */
function paginated(expectedPath, pages) {
  return (url) => {
    const parsed = new URL(url);
    assert.equal(parsed.pathname, expectedPath);
    assert.equal(parsed.searchParams.get("per_page"), "100");
    const page = Number(parsed.searchParams.get("page"));
    assert.ok(page >= 1, "pages are one-based");
    return fakeResponse(pages[page - 1] ?? []);
  };
}

function fileEntries(count, prefix) {
  return Array.from({ length: count }, (_, index) => ({ filename: `${prefix}/file-${index}.ts` }));
}

function review(login, state) {
  return { user: login === null ? null : { login }, state };
}

const FILES_PATH = "/repos/first-tree-ai/opentag/pulls/7/files";
const REVIEWS_PATH = "/repos/first-tree-ai/opentag/pulls/7/reviews";

function changedFiles(pages, expectedCount) {
  const { client, requests } = clientFor(paginated(FILES_PATH, pages));
  return {
    requests,
    result: fetchChangedFiles(client, {
      owner: "first-tree-ai",
      name: "opentag",
      number: 7,
      expectedCount,
      logger: silentLogger,
    }),
  };
}

function approvals(pages) {
  const { client, requests } = clientFor(paginated(REVIEWS_PATH, pages));
  return {
    requests,
    result: fetchApprovals(client, { owner: "first-tree-ai", name: "opentag", number: 7, logger: silentLogger }),
  };
}

// --- Changed files ----------------------------------------------------------

test("changed files are collected across every page of the files endpoint", async () => {
  const { result, requests } = changedFiles([fileEntries(100, "a"), fileEntries(100, "b"), fileEntries(30, "c")], 230);
  const paths = await result;

  assert.equal(paths.length, 230);
  assert.equal(paths[0], "a/file-0.ts");
  assert.equal(paths.at(-1), "c/file-29.ts");
  assert.equal(requests.length, 3, "a short page ends the walk");
});

test("an empty page ends the walk even though the link header still advertises a next page", async () => {
  // Past its 3000-entry cap the endpoint serves an empty page and keeps
  // promising more, so trusting the link header would loop forever.
  const { result, requests } = changedFiles([fileEntries(100, "a"), []], 100);
  const paths = await result;

  assert.equal(paths.length, 100);
  assert.equal(requests.length, 2);
});

test("a file count that disagrees with the pull request fails closed", async () => {
  const { result } = changedFiles([fileEntries(100, "a"), []], 250);

  await assert.rejects(result, (error) => {
    assert.ok(error instanceof TruncatedFileListError);
    assert.equal(error.collected, 100);
    assert.equal(error.expected, 250);
    assert.match(error.message, /100/);
    assert.match(error.message, /250/);
    return true;
  });
});

test("a rename reports the directory the file left as well as the one it entered", async () => {
  const { result } = changedFiles(
    [
      [
        { filename: "packages/server/src/gate.ts", previous_filename: "packages/client/src/gate.ts" },
        { filename: "README.md" },
      ],
    ],
    2,
  );

  assert.deepEqual(await result, ["packages/server/src/gate.ts", "packages/client/src/gate.ts", "README.md"]);
});

test("a changed file count that is not an integer is rejected outright", async () => {
  const { result } = changedFiles([[]], undefined);
  await assert.rejects(result, TypeError);
});

// --- Approvals --------------------------------------------------------------

test("a comment left after an approval does not withdraw it", async () => {
  // The classic bug: reducing to the plain last review per user would drop
  // alice's approval the moment she typed a follow-up remark.
  const { result } = approvals([
    [review("alice", "APPROVED"), review("bob", "COMMENTED"), review("alice", "COMMENTED")],
  ]);

  assert.deepEqual(await result, new Set(["alice"]));
});

test("a dismissal withdraws an earlier approval, and a fresh approval restores it", async () => {
  const dismissed = approvals([[review("alice", "APPROVED"), review("alice", "DISMISSED")]]);
  assert.deepEqual(await dismissed.result, new Set());

  const reapproved = approvals([
    [review("alice", "APPROVED"), review("alice", "DISMISSED"), review("alice", "APPROVED")],
  ]);
  assert.deepEqual(await reapproved.result, new Set(["alice"]));
});

test("a pending review never counts and never displaces a submitted verdict", async () => {
  const { result } = approvals([[review("alice", "APPROVED"), review("alice", "PENDING"), review("bob", "PENDING")]]);

  assert.deepEqual(await result, new Set(["alice"]));
});

test("a later change request overrides an earlier approval", async () => {
  const { result } = approvals([[review("alice", "APPROVED"), review("alice", "CHANGES_REQUESTED")]]);
  assert.deepEqual(await result, new Set());
});

test("approvals are read from every page of the reviews endpoint", async () => {
  const firstPage = [...Array.from({ length: 99 }, (_, index) => review(`noise-${index}`, "COMMENTED"))];
  firstPage.push(review("alice", "APPROVED"));
  const { result, requests } = approvals([firstPage, [review("bob", "APPROVED")]]);

  assert.deepEqual(await result, new Set(["alice", "bob"]));
  assert.equal(requests.length, 2);
});

test("logins are lowercased and reviews without a user are ignored", async () => {
  const { result } = approvals([[review(null, "APPROVED"), review("Alice-Owner", "APPROVED")]]);
  assert.deepEqual(await result, new Set(["alice-owner"]));
});

// --- Author access ----------------------------------------------------------

/** Defaults to a fork, which is the only case that reaches the API at all. */
function authorAccess(handler, options, logger = silentLogger) {
  const { client, requests } = clientFor(handler, logger);
  return {
    requests,
    result: fetchAuthorAccess(client, {
      owner: "first-tree-ai",
      name: "opentag",
      login: "carol",
      isFork: true,
      logger,
      ...options,
    }),
  };
}

function permissionResponse(payload, status = 200) {
  return () => fakeResponse(payload, status);
}

test("a same-repository pull request settles write access without an api call", async () => {
  // Pushing the head branch here already took write access, and this is the
  // path where the apps/web exemption has to stay frictionless, so it must not
  // depend on an endpoint the workflow token may not reach.
  const { result, requests } = authorAccess(permissionResponse({ permission: "none" }), { isFork: false });

  assert.equal((await result).hasWriteAccess, true);
  assert.equal(requests.length, 0);
});

test("a bot is still not an owner even when it pushes to a branch in this repository", async () => {
  const { result, requests } = authorAccess(permissionResponse({}), { isFork: false, login: "dependabot[bot]" });

  assert.deepEqual(await result, { hasWriteAccess: false, reason: "author is a bot account" });
  assert.equal(requests.length, 0);
});

test("a bot author never counts as an owner and costs no api call", async () => {
  const byLogin = authorAccess(permissionResponse({}), { login: "dependabot[bot]" });
  assert.deepEqual(await byLogin.result, { hasWriteAccess: false, reason: "author is a bot account" });
  assert.equal(byLogin.requests.length, 0);

  const byFlag = authorAccess(permissionResponse({}), { login: "some-app", isBot: true });
  assert.equal((await byFlag.result).hasWriteAccess, false);
  assert.equal(byFlag.requests.length, 0);
});

test("a read permission on a public repository is not write access", async () => {
  // Every signed-in stranger reads as `read` here, so "not none" would hand the
  // whole internet ownership of a gated directory.
  const { result } = authorAccess(
    permissionResponse({ permission: "read", permissions: { pull: true, push: false, admin: false } }),
    {},
  );

  const access = await result;
  assert.equal(access.hasWriteAccess, false);
  assert.match(access.reason, /read/);
});

test("the maintain role and an explicit push permission both count as write", async () => {
  // GitHub reports the maintain role through the coarse `permission` field as
  // plain "write", so the string branch has to accept it.
  const maintain = authorAccess(permissionResponse({ permission: "write" }), {});
  assert.equal((await maintain.result).hasWriteAccess, true);

  // The booleans hang off `user`, which is where this response actually puts
  // them; reading them from the top level would silently never fire.
  const push = authorAccess(permissionResponse({ user: { permissions: { pull: true, push: true } } }), {});
  assert.equal((await push.result).hasWriteAccess, true);

  const admin = authorAccess(permissionResponse({ permission: "admin" }), {});
  assert.equal((await admin.result).hasWriteAccess, true);
});

test("a 403 on a fork pull request fails safe and says why", async () => {
  const { logger, warnings } = recordingLogger();
  const { result, requests } = authorAccess(
    permissionResponse({ message: "Resource not accessible by integration" }, 403),
    { isFork: true },
    logger,
  );

  const access = await result;
  assert.equal(access.hasWriteAccess, false);
  assert.match(access.reason, /read-only token/);
  assert.equal(requests.length, 1, "a permission denial must not be retried");
  assert.equal(warnings.length, 1, "the summary needs to explain why the answer is a guess");
});

test("a 404 for a deleted or renamed account fails safe", async () => {
  const { result } = authorAccess(permissionResponse({ message: "Not Found" }, 404), {});
  const access = await result;

  assert.equal(access.hasWriteAccess, false);
  assert.match(access.reason, /no longer exists/);
});

test("an unexpected failure falls back to the author association instead of throwing", async () => {
  const { logger } = recordingLogger();
  const { result } = authorAccess(permissionResponse({ message: "boom" }, 500), { authorAssociation: "NONE" }, logger);

  const access = await result;
  assert.equal(access.hasWriteAccess, false);
  assert.match(access.reason, /permission lookup failed with 500; author association is NONE/);
});

test("organization membership does not stand in for write access when the lookup fails", async () => {
  // MEMBER is organization membership and COLLABORATOR also covers read-only
  // and triage collaborators, so accepting either would hand the external-author
  // floor to exactly the people it exists to catch.
  const { logger } = recordingLogger();
  for (const association of ["MEMBER", "COLLABORATOR", "CONTRIBUTOR", "FIRST_TIME_CONTRIBUTOR", "NONE"]) {
    const { result } = authorAccess(
      permissionResponse({ message: "Resource not accessible by integration" }, 403),
      { authorAssociation: association },
      logger,
    );
    assert.equal((await result).hasWriteAccess, false, `${association} must not imply write access`);
  }

  const owner = authorAccess(
    permissionResponse({ message: "Resource not accessible by integration" }, 403),
    { authorAssociation: "OWNER" },
    logger,
  );
  assert.equal((await owner.result).hasWriteAccess, true);
});

test("a lookup failure for an outside contributor stays at no write access", async () => {
  const { logger } = recordingLogger();
  const { result } = authorAccess(
    permissionResponse({ message: "Not Found" }, 404),
    { authorAssociation: "CONTRIBUTOR", isFork: true },
    logger,
  );

  assert.equal((await result).hasWriteAccess, false);
});

test("a missing author association is treated as no write access", async () => {
  const { logger } = recordingLogger();
  const { result } = authorAccess(permissionResponse({ message: "boom" }, 500), {}, logger);

  const access = await result;
  assert.equal(access.hasWriteAccess, false);
  assert.match(access.reason, /author association is unknown/);
});

test("an app login is recognised as a bot even when the payload does not say so", async () => {
  // Human logins cannot contain brackets, so the REST `[bot]` suffix is a safe
  // secondary signal for an app this repository has never seen before.
  const { result, requests } = authorAccess(permissionResponse({ permission: "write" }), {
    login: "code-owners-app[bot]",
    isBot: false,
  });

  assert.deepEqual(await result, { hasWriteAccess: false, reason: "author is a bot account" });
  assert.equal(requests.length, 0, "a bot author must never reach the permission endpoint");
});

test("the author login is percent-encoded into the permission url", async () => {
  const { result, requests } = authorAccess(permissionResponse({ permission: "none" }), { login: "a b" });
  await result;

  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /\/collaborators\/a%20b\/permission$/);
});

test("a pull request whose author was deleted fails safe without an api call", async () => {
  const { result, requests } = authorAccess(permissionResponse({}), { login: null });
  assert.equal((await result).hasWriteAccess, false);
  assert.equal(requests.length, 0);
});

// --- Commit status ----------------------------------------------------------

function commitStatus(overrides = {}) {
  const { client, requests } = clientFor(() => fakeResponse({ id: 1 }));
  return {
    requests,
    result: postCommitStatus(client, {
      owner: "first-tree-ai",
      name: "opentag",
      sha: "0f1e2d3c4b5a69788796a5b4c3d2e1f001234567",
      state: "failure",
      context: "ownership-gate",
      description: "packages/server needs an owner approval",
      targetUrl: "https://github.com/first-tree-ai/opentag/actions/runs/1",
      logger: silentLogger,
      ...overrides,
    }),
  };
}

test("the status is posted to the commit with its context and target url", async () => {
  const { result, requests } = commitStatus();
  await result;

  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, "POST");
  assert.equal(
    new URL(requests[0].url).pathname,
    "/repos/first-tree-ai/opentag/statuses/0f1e2d3c4b5a69788796a5b4c3d2e1f001234567",
  );
  assert.deepEqual(requests[0].body, {
    state: "failure",
    context: "ownership-gate",
    description: "packages/server needs an owner approval",
    target_url: "https://github.com/first-tree-ai/opentag/actions/runs/1",
  });
});

test("an over-long description is truncated to exactly 140 characters", async () => {
  // A wide pull request enumerates enough paths to overflow, and GitHub answers
  // 422 rather than trimming, which would pin the required check on pending.
  const { result, requests } = commitStatus({ description: "packages/server/src/very-long-path.ts, ".repeat(20) });
  await result;

  const { description } = requests[0].body;
  assert.equal(description.length, 140);
  assert.ok(description.endsWith("…"), "the reader must be able to see that the list was cut short");
});

test("a description that already fits is left exactly as it is", async () => {
  const description = "x".repeat(140);
  const { result, requests } = commitStatus({ description });
  await result;
  assert.equal(requests[0].body.description, description);
});

test("an omitted target url is sent as null rather than left out", async () => {
  const { result, requests } = commitStatus({ targetUrl: undefined });
  await result;
  assert.equal(requests[0].body.target_url, null);
});

test("an unsupported state is rejected before any request is made", async () => {
  const { result, requests } = commitStatus({ state: "skipped" });

  await assert.rejects(result, TypeError);
  assert.equal(requests.length, 0);
});
