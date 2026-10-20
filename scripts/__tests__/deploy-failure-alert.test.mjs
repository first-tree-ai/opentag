import assert from "node:assert/strict";
import test from "node:test";
import { buildAlert, findFailure, isSupersededRun, shouldAlert } from "../deploy-alert/classify.mjs";
import {
  ALERT_KEYWORD,
  buildCard,
  FeishuDeliveryError,
  sendFeishu,
  signRequest,
  validateWebhookUrl,
} from "../deploy-alert/feishu.mjs";
import { findProfile } from "../deploy-alert/profiles.mjs";
import { parseCli, run } from "../deploy-failure-alert.mjs";

const REPOSITORY = "first-tree-ai/opentag";
const WEBHOOK = "https://open.feishu.cn/open-apis/bot/v2/hook/test-hook-token";
const SHA = "0123456789abcdef0123456789abcdef01234567";

function silentLogger() {
  const entries = [];
  const record = (level) => (message, details) => entries.push({ level, message, details });
  return { entries, error: record("error"), warn: record("warn"), info: record("info"), debug: record("debug") };
}

function makeRun(overrides = {}) {
  return {
    id: 42,
    path: ".github/workflows/deploy-staging.yml",
    conclusion: "failure",
    event: "workflow_run",
    head_branch: "main",
    head_sha: SHA,
    head_repository: { full_name: REPOSITORY },
    head_commit: { message: "feat(web): ship the thing\n\nLong body" },
    display_title: "Deploy Staging",
    html_url: "https://github.com/first-tree-ai/opentag/actions/runs/42",
    run_attempt: 1,
    triggering_actor: { login: "octocat" },
    ...overrides,
  };
}

function failedJob(name, stepName, conclusion = "failure") {
  return {
    name,
    conclusion,
    html_url: `https://github.com/first-tree-ai/opentag/actions/runs/42/job/${encodeURIComponent(name)}`,
    steps: [
      { name: "Check out main", conclusion: "success" },
      { name: stepName, conclusion },
      { name: "Summarise the deployment", conclusion: "success" },
    ],
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("signRequest matches the Feishu documentation vector", () => {
  // Reference value computed independently from the documented algorithm (secret "demo").
  assert.equal(signRequest("demo", 1599360473), "l1N0gAcBjdwBvGm1xMjOF0XSyaLRpR7tuO5dHfhAYc8=");
});

test("validateWebhookUrl accepts only https Feishu or Lark bot hooks and never echoes the value", () => {
  assert.equal(validateWebhookUrl(WEBHOOK), WEBHOOK);
  assert.ok(validateWebhookUrl("https://open.larksuite.com/open-apis/bot/v2/hook/abc"));
  for (const bad of [
    "http://open.feishu.cn/open-apis/bot/v2/hook/secret-a",
    "https://evil.example/open-apis/bot/v2/hook/secret-b",
    "https://open.feishu.cn/other/secret-c",
    "not a url secret-d",
  ]) {
    assert.throws(
      () => validateWebhookUrl(bad),
      (error) => error instanceof TypeError && !/secret-/.test(error.message),
    );
  }
});

test("parseCli requires a numeric run id", () => {
  assert.deepEqual(parseCli(["--run-id", "123"]), { runId: "123", rehearsal: false });
  assert.deepEqual(parseCli(["--run-id", "123", "--rehearsal"]), { runId: "123", rehearsal: true });
  assert.throws(() => parseCli([]), /--run-id/);
  assert.throws(() => parseCli(["--run-id", "12; rm -rf /"]), /--run-id/);
});

test("shouldAlert keeps only real deploy failures from this repository", () => {
  assert.equal(shouldAlert(makeRun(), REPOSITORY).alert, true);
  assert.equal(shouldAlert(makeRun({ conclusion: "timed_out" }), REPOSITORY).alert, true);
  assert.equal(shouldAlert(makeRun({ conclusion: "startup_failure" }), REPOSITORY).alert, true);
  for (const conclusion of ["success", "cancelled", "skipped", "action_required", null]) {
    assert.equal(shouldAlert(makeRun({ conclusion }), REPOSITORY).alert, false, String(conclusion));
  }
  assert.equal(shouldAlert(makeRun({ event: "pull_request" }), REPOSITORY).alert, false);
  assert.equal(shouldAlert(makeRun({ head_repository: { full_name: "fork/opentag" } }), REPOSITORY).alert, false);
});

test("findFailure prefers a failed job over a cancelled one and tolerates missing jobs", () => {
  const cancelled = failedJob("A", "Step A", "cancelled");
  const failed = failedJob("B", "Step B");
  const { job, step } = findFailure([cancelled, failed]);
  assert.equal(job.name, "B");
  assert.equal(step.name, "Step B");
  assert.deepEqual(findFailure(undefined), { job: null, step: null });
});

test("npm Publish failures resolve the environment from the job and the phase from the step", () => {
  const profile = findProfile(".github/workflows/publish-npm-package.yml");
  const staging = buildAlert({
    run: makeRun({ path: profile.path }),
    jobs: [failedJob("Publish CLI Staging", "Publish staging package")],
    profile,
  });
  assert.equal(staging.environment.key, "staging");
  assert.equal(staging.phase.name, "npm 发布");

  const production = buildAlert({
    run: makeRun({ path: profile.path, event: "push", head_branch: "v1.2.3" }),
    jobs: [failedJob("Publish CLI Production", "Install dependencies")],
    profile,
  });
  assert.equal(production.environment.key, "production");
  assert.equal(production.environment.template, "red");
  assert.equal(production.phase.name, "发布前校验");

  // A startup failure has no jobs; a tag push still means production.
  const startup = buildAlert({
    run: makeRun({ path: profile.path, event: "push", conclusion: "startup_failure" }),
    jobs: [],
    profile,
  });
  assert.equal(startup.environment.key, "production");
  assert.equal(startup.stepName, null);
});

test("Deploy Staging maps CapRover and image-wait failures to their phases", () => {
  const profile = findProfile(".github/workflows/deploy-staging.yml@refs/heads/main");
  const caprover = buildAlert({
    run: makeRun(),
    jobs: [failedJob("Deploy Staging", "Deploy the commit image to CapRover")],
    profile,
  });
  assert.equal(caprover.environment.key, "staging");
  assert.equal(caprover.phase.name, "CapRover 部署");
  assert.equal(caprover.phase.awaitsServerImage, false);

  const image = buildAlert({
    run: makeRun(),
    jobs: [failedJob("Deploy Staging", "Wait for the commit image")],
    profile,
  });
  assert.equal(image.phase.awaitsServerImage, true);
});

test("Deploy Runner reads channel and mode from its run name", () => {
  const profile = findProfile(".github/workflows/deploy-runner.yml");
  const prodCheck = buildAlert({
    run: makeRun({
      path: profile.path,
      event: "workflow_dispatch",
      display_title: "Deploy Runner · prod · 1.4.0 · check",
    }),
    jobs: [failedJob("runner", "Check or activate the Runner target")],
    profile,
  });
  assert.equal(prodCheck.environment.key, "production");
  assert.equal(prodCheck.phase.name, "Runner 激活");
  assert.equal(prodCheck.notes.length, 1);

  const stagingApply = buildAlert({
    run: makeRun({ path: profile.path, display_title: "Deploy Runner · staging · 1.4.0 · apply" }),
    jobs: [],
    profile,
  });
  assert.equal(stagingApply.environment.key, "staging");
  assert.deepEqual(stagingApply.notes, []);

  const untitled = buildAlert({
    run: makeRun({ path: profile.path, display_title: "Deploy Runner" }),
    jobs: [],
    profile,
  });
  assert.equal(untitled.environment.key, "unknown");
});

test("buildCard titles the card by environment and keeps untrusted text out of lark_md", () => {
  const profile = findProfile(".github/workflows/deploy-staging.yml");
  const alert = buildAlert({
    run: makeRun({ head_commit: { message: "fix: <at id=all></at> **boom**" } }),
    jobs: [failedJob("Deploy Staging", "Deploy the commit image to CapRover")],
    profile,
  });
  const card = buildCard(alert);
  assert.equal(card.msg_type, "interactive");
  assert.equal(card.card.header.template, "orange");
  assert.equal(card.card.header.title.content, `【预发】OpenTag ${ALERT_KEYWORD}`);

  const larkMarkdown = JSON.stringify(card.card.elements.filter((element) => element.tag === "div" && element.fields));
  assert.doesNotMatch(larkMarkdown, /<at/);
  const plain = card.card.elements.find((element) => element.text?.tag === "plain_text");
  assert.match(plain.text.content, /提交：0123456 fix: <at id=all><\/at> \*\*boom\*\*/);
  const [viewRun] = card.card.elements.at(-1).actions;
  assert.equal(viewRun.url, alert.jobUrl);

  const rehearsal = buildCard({
    ...alert,
    rehearsal: true,
    rootCause: { text: "镜像 <失败>", url: "https://x.test/r" },
  });
  assert.match(rehearsal.card.header.title.content, /^【演练】【预发】/);
  assert.ok(rehearsal.card.elements.some((element) => element.text?.content === "**根因**：镜像 &lt;失败&gt;"));
  assert.equal(rehearsal.card.elements.at(-1).actions.length, 2);
});

test("sendFeishu signs every attempt and retries throttling and server errors", async () => {
  const bodies = [];
  const responses = [
    () => Promise.reject(new TypeError("socket hang up")),
    () => Promise.resolve(jsonResponse({}, 502)),
    () => Promise.resolve(jsonResponse({ code: 11232, msg: "frequency limited" })),
    () => Promise.resolve(jsonResponse({ code: 0, msg: "success" })),
  ];
  const delays = [];
  let clock = 1_700_000_000_000;
  await sendFeishu({
    webhookUrl: WEBHOOK,
    secret: "demo",
    message: { msg_type: "interactive", card: {} },
    fetchImpl: (_url, init) => {
      bodies.push(JSON.parse(init.body));
      return responses[bodies.length - 1]();
    },
    sleepImpl: async (delay) => {
      delays.push(delay);
      clock += delay;
    },
    now: () => clock,
    logger: silentLogger(),
  });
  assert.equal(bodies.length, 4);
  assert.deepEqual(delays, [1000, 2000, 4000]);
  for (const body of bodies) {
    assert.equal(body.sign, signRequest("demo", body.timestamp));
  }
  assert.notEqual(bodies[0].timestamp, bodies[3].timestamp);
});

test("sendFeishu accepts the legacy StatusCode reply and sends unsigned without a secret", async () => {
  let body;
  await sendFeishu({
    webhookUrl: WEBHOOK,
    secret: null,
    message: { msg_type: "interactive" },
    fetchImpl: async (_url, init) => {
      body = JSON.parse(init.body);
      return jsonResponse({ StatusCode: 0, StatusMessage: "success" });
    },
    sleepImpl: async () => {},
    now: () => 0,
    logger: silentLogger(),
  });
  assert.equal(body.sign, undefined);
  assert.equal(body.timestamp, undefined);
});

test("sendFeishu fails fast on configuration errors and gives up after the retry budget", async () => {
  const base = { webhookUrl: WEBHOOK, secret: null, message: {}, sleepImpl: async () => {}, now: () => 0 };
  let calls = 0;
  await assert.rejects(
    sendFeishu({
      ...base,
      logger: silentLogger(),
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse({ code: 19024, msg: "Key Words Not Found" });
      },
    }),
    (error) => error instanceof FeishuDeliveryError && error.code === 19024 && !error.message.includes(WEBHOOK),
  );
  assert.equal(calls, 1);

  calls = 0;
  await assert.rejects(
    sendFeishu({
      ...base,
      logger: silentLogger(),
      fetchImpl: async () => {
        calls += 1;
        return new Response("<html>", { status: 503 });
      },
    }),
    (error) => error instanceof FeishuDeliveryError && error.status === 503,
  );
  assert.equal(calls, 4);

  await assert.rejects(
    sendFeishu({ ...base, logger: silentLogger(), fetchImpl: async () => new Response("not json") }),
    /code missing/,
  );
});

function routedFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    for (const [pattern, respond] of routes) {
      if (pattern.test(String(url))) return respond(init);
    }
    throw new Error(`Unexpected request to ${url}`);
  };
  return { calls, fetchImpl };
}

const ENV = { GITHUB_REPOSITORY: REPOSITORY, GH_TOKEN: "gh-token", FEISHU_WEBHOOK_URL: WEBHOOK };

test("run folds a failed Docker build into the Deploy Staging alert", async () => {
  const { calls, fetchImpl } = routedFetch([
    [/\/actions\/runs\/42$/, () => jsonResponse(makeRun())],
    [
      /\/actions\/runs\/42\/jobs/,
      () => jsonResponse({ jobs: [failedJob("Deploy Staging", "Wait for the commit image")] }),
    ],
    [
      /\/actions\/workflows\/docker\.yml\/runs\?head_sha=0123/,
      () =>
        jsonResponse({ workflow_runs: [{ conclusion: "failure", html_url: "https://github.com/x/actions/runs/7" }] }),
    ],
    [/open\.feishu\.cn/, () => jsonResponse({ code: 0 })],
  ]);
  const code = await run({
    argv: ["--run-id", "42"],
    env: ENV,
    logger: silentLogger(),
    fetchImpl,
    sleepImpl: async () => {},
  });
  assert.equal(code, 0);
  const feishu = calls.find((call) => call.url === WEBHOOK);
  const card = JSON.parse(feishu.init.body);
  assert.ok(card.card.elements.some((element) => /Docker/.test(element.text?.content ?? "")));
  assert.equal(card.card.elements.at(-1).actions[1].url, "https://github.com/x/actions/runs/7");
});

test("run still alerts when the Docker lookup fails or finds no build", async () => {
  for (const docker of [() => jsonResponse({ message: "nope" }, 404), () => jsonResponse({ workflow_runs: [] })]) {
    const { calls, fetchImpl } = routedFetch([
      [/\/actions\/runs\/42$/, () => jsonResponse(makeRun())],
      [
        /\/actions\/runs\/42\/jobs/,
        () => jsonResponse({ jobs: [failedJob("Deploy Staging", "Wait for the commit image")] }),
      ],
      [/\/actions\/workflows\/docker\.yml/, docker],
      [/open\.feishu\.cn/, () => jsonResponse({ code: 0 })],
    ]);
    const code = await run({
      argv: ["--run-id", "42"],
      env: ENV,
      logger: silentLogger(),
      fetchImpl,
      sleepImpl: async () => {},
    });
    assert.equal(code, 0);
    assert.ok(calls.some((call) => call.url === WEBHOOK));
  }
});

test("run skips runs that do not need an alert, unless it is a rehearsal", async () => {
  const routes = () =>
    routedFetch([
      [/\/actions\/runs\/42$/, () => jsonResponse(makeRun({ conclusion: "success" }))],
      [/\/actions\/runs\/42\/jobs/, () => jsonResponse({ jobs: [] })],
      [/open\.feishu\.cn/, () => jsonResponse({ code: 0 })],
    ]);
  const skipped = routes();
  assert.equal(
    await run({ argv: ["--run-id", "42"], env: ENV, logger: silentLogger(), fetchImpl: skipped.fetchImpl }),
    0,
  );
  assert.ok(!skipped.calls.some((call) => call.url === WEBHOOK));

  const rehearsal = routes();
  await run({
    argv: ["--run-id", "42", "--rehearsal"],
    env: ENV,
    logger: silentLogger(),
    fetchImpl: rehearsal.fetchImpl,
  });
  const card = JSON.parse(rehearsal.calls.find((call) => call.url === WEBHOOK).init.body);
  assert.match(card.card.header.title.content, /^【演练】/);
});

test("run rejects workflows it does not watch and skips when the webhook is absent", async () => {
  const { fetchImpl } = routedFetch([
    [/\/actions\/runs\/42$/, () => jsonResponse(makeRun({ path: ".github/workflows/ci.yml" }))],
  ]);
  await assert.rejects(run({ argv: ["--run-id", "42"], env: ENV, logger: silentLogger(), fetchImpl }), /not a watched/);

  const unconfigured = routedFetch([]);
  const logger = silentLogger();
  const code = await run({
    argv: ["--run-id", "42"],
    env: { ...ENV, FEISHU_WEBHOOK_URL: "  " },
    logger,
    fetchImpl: unconfigured.fetchImpl,
  });
  assert.equal(code, 0);
  assert.equal(unconfigured.calls.length, 0);
  assert.ok(logger.entries.some((entry) => entry.level === "warn"));
});

test("run stays silent for a stale staging revision but alerts when main cannot be compared", async () => {
  const publishRun = makeRun({ path: ".github/workflows/publish-npm-package.yml", display_title: "npm Publish" });
  const jobs = {
    jobs: [failedJob("Publish CLI Staging", "Verify staging revision is current main")],
  };
  const cases = [
    { main: () => jsonResponse({ sha: "f".repeat(40) }), alerted: false },
    { main: () => jsonResponse({ sha: SHA }), alerted: true },
    { main: () => jsonResponse({ message: "nope" }, 500), alerted: true },
  ];
  for (const { main, alerted } of cases) {
    const { calls, fetchImpl } = routedFetch([
      [/\/actions\/runs\/42$/, () => jsonResponse(publishRun)],
      [/\/actions\/runs\/42\/jobs/, () => jsonResponse(jobs)],
      [/\/commits\/main$/, main],
      [/open\.feishu\.cn/, () => jsonResponse({ code: 0 })],
    ]);
    const code = await run({
      argv: ["--run-id", "42"],
      env: ENV,
      logger: silentLogger(),
      fetchImpl,
      sleepImpl: async () => {},
    });
    assert.equal(code, 0);
    assert.equal(
      calls.some((call) => call.url === WEBHOOK),
      alerted,
    );
  }
});

test("isSupersededRun ignores other steps and unknown main heads", () => {
  const profile = findProfile(".github/workflows/publish-npm-package.yml");
  const base = { profile, stepName: "Recheck staging revision is current main", runSha: "a", mainSha: "b" };
  assert.equal(isSupersededRun(base), true);
  assert.equal(isSupersededRun({ ...base, stepName: "Build source workspaces" }), false);
  assert.equal(isSupersededRun({ ...base, mainSha: null }), false);
  assert.equal(isSupersededRun({ ...base, mainSha: "a" }), false);
});
