import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";
import { createGitHubClient } from "../github/client.mjs";
import { postCommitStatus } from "../ownership-gate/pull-request.mjs";
import { evaluate, loadPolicy } from "../ownership-gate.mjs";

const root = join(import.meta.dirname, "..", "..");
const workflow = parse(await readFile(join(root, ".github/workflows/ownership-gate.yml"), "utf8"));
const actionlint = parse(await readFile(join(root, ".github/actionlint.yaml"), "utf8"));
const policy = await loadPolicy(root);
const logger = { info() {}, debug() {}, warn() {}, error() {} };
const repository = "first-tree-ai/opentag";
const head = "a".repeat(40);
const nextHead = "b".repeat(40);
const otherHead = "c".repeat(40);

function assertWriterQueue() {
  assert.deepEqual(workflow.concurrency, {
    group: "ownership-gate-writer",
    "cancel-in-progress": false,
    queue: "max",
  });
  assert.equal(workflow.jobs.evaluate.concurrency, undefined, "the slot must cover checkout and every step");
}

// Models GitHub's documented exclusion and queueing, not its scheduler implementation.
function writerQueue() {
  assertWriterQueue();
  let tail = Promise.resolve();
  return (operation) => {
    const result = tail.then(operation);
    tail = result.catch(() => {});
    return result;
  };
}

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (key) => (key === "retry-after" ? "60" : null) },
    text: async () => JSON.stringify(body),
  };
}

function pull(number, sha = head, author = "contributor") {
  return {
    number,
    state: "open",
    head: { sha, repo: { full_name: repository } },
    user: { login: author, type: "User" },
    changed_files: 1,
    base: { ref: "main" },
  };
}

function fixture(pulls = [pull(7)]) {
  const reviews = new Map(pulls.map(({ number }) => [number, "APPROVED"]));
  const requests = [];
  const statuses = [];
  let file = "scripts/ownership-gate.mjs";

  function read(path) {
    const commit = path.match(/\/commits\/([^/]+)\/pulls/);
    if (commit) return pulls.filter((entry) => entry.state === "open" && entry.head.sha === commit[1]);
    const match = path.match(/\/pulls\/(\d+)(?:\/(files|reviews))?/);
    assert.ok(match, `Unexpected synthetic request: ${path}`);
    const number = Number(match[1]);
    if (match[2] === "files") return [{ filename: file }];
    if (match[2] === "reviews") {
      return [{ user: { login: "bestony" }, state: reviews.get(number), commit_id: head }];
    }
    return pulls.find((entry) => entry.number === number);
  }

  function clientFor(role, { onPost, onBackoff = async () => {} } = {}) {
    return createGitHubClient({
      token: "synthetic-token",
      logger,
      sleepImpl: onBackoff,
      fetchImpl: async (url, init) => {
        const path = new URL(url).pathname;
        requests.push({ role, method: init.method, path });
        if (init.method === "GET") return response(read(path));
        assert.equal(init.method, "POST");
        const body = JSON.parse(init.body);
        assert.equal(body.context, "ownership-gate");
        const rejected = await onPost?.();
        if (rejected) return rejected;
        statuses.push({ role, sha: path.split("/").at(-1), state: body.state });
        return response({ id: statuses.length });
      },
    });
  }

  async function judge(client, config = {}) {
    return evaluate({ client, config: { repository, number: null, headSha: head, ...config }, policy, logger });
  }

  async function run(client, config) {
    const result = await judge(client, config);
    if (result !== null) {
      await postCommitStatus(client, {
        owner: result.owner,
        name: result.name,
        sha: result.headSha,
        state: result.state,
        context: "ownership-gate",
        description: "Synthetic concurrency test",
        logger,
      });
    }
    return result;
  }

  return { pulls, reviews, requests, statuses, clientFor, judge, run, setFile: (path) => (file = path) };
}

test("every gate trigger shares a workflow-level writer queue", () => {
  assertWriterQueue();
  assert.deepEqual(Object.keys(workflow.on).sort(), ["pull_request_target", "push", "schedule", "workflow_run"]);
});

test("actionlint only suppresses its unsupported queue diagnostic for the gate workflow", () => {
  const patterns = actionlint.paths[".github/workflows/ownership-gate.yml"].ignore;
  assert.equal(patterns.length, 1);
  const diagnostic = 'unexpected key "queue" for "concurrency" section. expected one of "cancel-in-progress", "group"';
  assert.ok(new RegExp(patterns[0]).test(diagnostic));
  assert.ok(!new RegExp(patterns[0]).test(diagnostic.replace('"queue"', '"typo"')));
  assert.ok(!new RegExp(patterns[0]).test(`other error: ${diagnostic}`));
  assertWriterQueue();
});

for (const status of [403, 429]) {
  test(`negative control: an uncoordinated ${status} retry overwrites a newer failure`, async () => {
    const api = fixture();
    let attempts = 0;
    const event = api.clientFor("event");
    const sweep = api.clientFor("sweep", {
      onPost: () => (++attempts === 1 ? response({}, status) : undefined),
      onBackoff: async (milliseconds) => {
        assert.equal(milliseconds, 60_000);
        api.reviews.set(7, "DISMISSED");
        await api.run(event);
        assert.equal(api.statuses.at(-1).state, "failure");
      },
    });
    await api.run(sweep);
    assert.deepEqual(
      api.statuses.map(({ state }) => state),
      ["failure", "success"],
    );
  });

  for (let dismissOnAttempt = 1; dismissOnAttempt <= 4; dismissOnAttempt += 1) {
    test(`${status}: dismissal between the read and POST attempt ${dismissOnAttempt} is reconciled last`, async () => {
      const enqueue = writerQueue();
      const api = fixture();
      let attempts = 0;
      let backoffs = 0;
      let eventRun;
      const event = api.clientFor("event");
      const assertEventWaiting = () => {
        assert.ok(
          api.requests.every(({ role }) => role !== "event"),
          "the waiting event must not read yet",
        );
      };
      const sweep = api.clientFor("sweep", {
        onPost: async () => {
          attempts += 1;
          if (attempts === dismissOnAttempt) {
            api.reviews.set(7, "DISMISSED");
            eventRun = enqueue(() => api.run(event));
          }
          await Promise.resolve();
          assertEventWaiting();
          return attempts < 4 ? response({}, status) : undefined;
        },
        onBackoff: async (milliseconds) => {
          assert.equal(milliseconds, 60_000);
          backoffs += 1;
          await Promise.resolve();
          assertEventWaiting();
        },
      });
      await enqueue(() => api.run(sweep));
      await eventRun;
      assert.equal(attempts, 4);
      assert.equal(backoffs, 3);
      assert.deepEqual(
        api.statuses.map(({ state }) => state),
        ["success", "failure"],
      );
    });
  }
}

test("multiple queued heads survive and a numbered event reads its advanced head after acquiring the slot", async () => {
  const enqueue = writerQueue();
  const api = fixture([pull(7), pull(8, otherHead)]);
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  const sweep = api.clientFor("sweep", {
    onPost: async () => {
      started.resolve();
      await release.promise;
    },
  });
  const sweepRun = enqueue(() => api.run(sweep));
  await started.promise;
  const first = enqueue(() => api.run(api.clientFor("first event"), { number: 7 }));
  const second = enqueue(() => api.run(api.clientFor("second event"), { number: 8, headSha: otherHead }));
  api.pulls[0].head.sha = nextHead;
  assert.ok(api.requests.every(({ role }) => role === "sweep"));
  release.resolve();
  await Promise.all([sweepRun, first, second]);
  assert.deepEqual(api.statuses, [
    { role: "sweep", sha: head, state: "success" },
    { role: "first event", sha: nextHead, state: "success" },
    { role: "second event", sha: otherHead, state: "success" },
  ]);
});

test("a sweep skips a head that no longer belongs to an open pull request", async () => {
  const api = fixture([pull(7, nextHead)]);
  assert.equal(await api.run(api.clientFor("sweep")), null);
  assert.deepEqual(api.statuses, []);
});

test("a numbered event retains the accepted stale-approval policy on the latest head", async () => {
  const api = fixture([pull(7, nextHead)]);
  const result = await api.judge(api.clientFor("event"), { number: 7 });
  assert.equal(result.headSha, nextHead);
  assert.equal(result.state, "success");
  assert.deepEqual(result.results[0].pullRequest.staleApprovals, ["bestony"]);
});

test("dismissal still blocks the latest head", async () => {
  const api = fixture([pull(7, nextHead)]);
  api.reviews.set(7, "DISMISSED");
  const result = await api.judge(api.clientFor("event"), { number: 7 });
  assert.equal(result.headSha, nextHead);
  assert.equal(result.state, "failure");
});

test("an owner cannot approve their own gated change", async () => {
  const api = fixture([pull(7, head, "bestony")]);
  assert.equal((await api.judge(api.clientFor("event"))).state, "failure");
});

test("a bot still requires owner review for exempt paths", async () => {
  const api = fixture([pull(7, head, "dependabot[bot]")]);
  api.setFile("apps/web/src/app.tsx");
  api.reviews.set(7, "DISMISSED");
  assert.equal((await api.judge(api.clientFor("event"))).state, "failure");
});

test("the worst open sibling verdict wins on a shared head", async () => {
  const api = fixture([pull(7), pull(8)]);
  api.reviews.set(8, "DISMISSED");
  const result = await api.judge(api.clientFor("event"));
  assert.equal(result.results.length, 2);
  assert.equal(result.state, "failure");
});
