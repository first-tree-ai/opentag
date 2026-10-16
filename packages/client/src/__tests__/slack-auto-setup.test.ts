import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SLACK_SUBSCRIBED_BOT_EVENTS, type SlackAutoSetupCommand } from "@opentag/shared";
import { afterEach, expect, it, vi } from "vitest";
import { SlackAutoSetup } from "../slack-auto-setup.js";
import { slackManagementHome } from "../slack-management.js";
import { writePrivateJson } from "../storage/private-json-file.js";

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "slack-auto-"));
  homes.push(root);
  const environment = { OPENTAG_HOME: root };
  const home = slackManagementHome(environment);
  const agentId = randomUUID();
  const project = `web-${agentId}`;
  const credentials = {
    appId: "A1",
    teamId: "T1",
    botUserId: "U1",
    botAccessToken: "private-bot",
    signingSecret: "private-secret",
  };
  let failDeploy = false;
  let loseCreate = false;
  let createError: string | undefined;
  let failCallbacks = false;
  let approvalStatus: "pending" | "approved" | "denied" | "cancelled" | undefined;
  let requireApproval = false;
  let submittedRequests = 0;
  let linked = false;
  let canSelfApprove = false;
  let remote: unknown = { display_information: { name: "QA" }, settings: { org_deploy_enabled: false } };
  async function auth(args: string[], output: string) {
    if (args.includes("--ticket"))
      await writePrivateJson(home, join(home, "config/credentials.json"), {
        login: { team_id: "T1", team_domain: "local-team", token: "private-native", last_updated: Date.now() },
      });
    else await writeFile(output, "Run /slackauthticket test-ticket");
  }
  async function deploy(requestAppApproval?: boolean) {
    if (requireApproval && approvalStatus !== "approved") {
      if (!requestAppApproval) return 1;
      approvalStatus = "pending";
      submittedRequests++;
      return 0; // Native CLI successfully submitted a request, but did not install or invoke the deploy hook.
    }
    await writePrivateJson(home, join(home, project, "credentials.json"), credentials);
    if (!failDeploy) return 0;
    await writeFile(join(home, project, "last-error.txt"), "private-stderr");
    return 1;
  }
  async function create(output: string) {
    if (loseCreate) {
      await writeFile(output, "");
      return 1;
    }
    if (createError) {
      await writePrivateJson(home, output, { ok: false, error: createError });
      return 1;
    }
    await writePrivateJson(home, output, {
      ok: true,
      app_id: "A1",
      credentials: { signing_secret: "private-secret" },
    });

    return 0;
  }
  const run = vi.fn(
    async (
      args: string[],
      options: Parameters<typeof import("../slack-management.js").runSlackManagement>[1],
    ): Promise<number> => {
      if (!options?.outputFile) throw new Error("Missing private output");
      const output = join(home, options.outputFile);
      await writePrivateJson(home, output, {});
      switch (args[1]) {
        case "login":
          await auth(args, output);
          break;
        case "apps.manifest.create":
          return create(output);
        case "deploy":
          return deploy(options.requestAppApproval);
        case "link":
          if (linked && !args.includes("--force")) {
            await writeFile(join(home, project, "last-error.txt"), "A saved app was found (app_found)");
            return 1;
          }
          linked = true;
          break;
        case "apps.approvals.requests.list":
          await writePrivateJson(home, output, {
            ok: true,
            requests: approvalStatus
              ? [{ id: "R1", team_id: "T1", status: approvalStatus, can_self_approve: canSelfApprove }]
              : [],
          });
          break;
        case "apps.manifest.export":
          await writePrivateJson(home, output, { ok: true, manifest: remote });
          break;
        case "apps.manifest.update":
          if (failCallbacks) return 1;
          remote = JSON.parse(JSON.parse(args[3] ?? "{}").manifest);
          break;
      }
      return 0;
    },
  );
  const request = (input: SlackAutoSetupCommand) => ({
    type: "slack:auto-setup" as const,
    requestId: randomUUID(),
    agentId,
    computerId: randomUUID(),
    input,
  });
  const setup = new SlackAutoSetup({ environment, run, cliEntry: "/trusted/opentag.mjs" });
  const authorize = async () => {
    expect(await setup.run(request({ action: "authorize" }))).toEqual({
      status: "authorization_required",
      ticket: "test-ticket",
    });
  };
  return {
    setup,
    request,
    run,
    authorize,
    home,
    project,
    credentials,
    requireApproval: () => {
      requireApproval = true;
    },
    setApprovalStatus: (status: typeof approvalStatus) => {
      approvalStatus = status;
    },
    submittedRequests: () => submittedRequests,
    allowSelfApproval: () => {
      canSelfApprove = true;
    },
    setFailDeploy: (value: boolean) => {
      failDeploy = value;
    },
    loseCreate: () => {
      loseCreate = true;
    },
    setCreateError: (value: string | undefined) => {
      createError = value;
    },
    failCallbacks: () => {
      failCallbacks = true;
    },
  };
}
function callbacks(appId = "A1"): Extract<SlackAutoSetupCommand, { action: "callbacks" }> {
  return {
    action: "callbacks",
    appId,
    teamId: "T1",
    botUserId: "U1",
    enterpriseId: null,
    eventsUrl: "https://qa.example/events",
    interactionsUrl: "https://qa.example/interactions",
  };
}
it("submits one approval request, waits without another install, and resumes the same App after approval", async () => {
  const f = await fixture();
  await f.authorize();
  f.requireApproval();
  const pending = { status: "approval_pending", appId: "A1", teamId: "T1" };
  expect(await f.setup.run(f.request({ action: "install", displayName: "QA", challenge: "code" }))).toEqual(pending);
  expect(f.submittedRequests()).toBe(1);
  expect(existsSync(join(f.home, f.project, "credentials.json"))).toBe(false);
  expect(await readFile(join(f.home, f.project, "create-response.json"), "utf8")).toContain("private-secret");
  const restarted = new SlackAutoSetup({
    environment: { OPENTAG_HOME: join(f.home, "..") },
    run: f.run,
    cliEntry: "/trusted/opentag.mjs",
  });
  expect(await restarted.run(f.request({ action: "install", displayName: "QA" }))).toEqual(pending);
  expect(f.run.mock.calls.filter(([args]) => args[1] === "deploy")).toHaveLength(1);
  expect(f.submittedRequests()).toBe(1);
  f.setApprovalStatus("approved");
  expect(await restarted.run(f.request({ action: "install", displayName: "QA" }))).toEqual({
    status: "installed",
    credentials: f.credentials,
  });
  expect(await restarted.run(f.request(callbacks()))).toEqual({ status: "connected" });
  expect(f.run.mock.calls.filter(([args]) => args[1] === "apps.manifest.create")).toHaveLength(1);
  expect(f.run.mock.calls.filter(([args]) => args[1] === "login")).toHaveLength(2);
  expect(f.submittedRequests()).toBe(1);
  expect(await readFile(join(f.home, f.project, "create-response.json"), "utf8")).not.toContain("private");
});
it("does not install or resubmit a denied App until an app manager approves it", async () => {
  const f = await fixture();
  await f.authorize();
  f.setApprovalStatus("denied");
  expect(await f.setup.run(f.request({ action: "install", displayName: "QA", challenge: "code" }))).toEqual({
    status: "failed",
    code: "approval_denied",
    appId: "A1",
    teamId: "T1",
  });
  expect(f.run.mock.calls.some(([args]) => args[1] === "deploy")).toBe(false);
  f.setApprovalStatus("approved");
  expect(await f.setup.run(f.request({ action: "install", displayName: "QA" }))).toEqual({
    status: "installed",
    credentials: f.credentials,
  });
  expect(f.run.mock.calls.filter(([args]) => args[1] === "apps.manifest.create")).toHaveLength(1);
});
it("recovers an empty-stdout network EOF without recreating the App or failing on its saved local link", async () => {
  const f = await fixture();
  await f.authorize();
  const original = f.run.getMockImplementation();
  let deployAttempts = 0;
  f.run.mockImplementation(async (args, options) => {
    if (args[1] === "deploy" && deployAttempts++ === 0) {
      await writeFile(join(f.home, f.project, "deploy-output.txt"), "");
      await writeFile(
        join(f.home, f.project, "last-error.txt"),
        'ERROR HTTP request failed (http_request_failed) Post "https://slack.com/api/auth.test": EOF private-native',
      );
      return 1;
    }
    return original?.(args, options) ?? 1;
  });
  const failed = await f.setup.run(f.request({ action: "install", displayName: "QA", challenge: "code" }));
  expect(failed).toEqual({
    status: "failed",
    code: "install_failed",
    errorCode: "http_request_failed",
    appId: "A1",
    teamId: "T1",
  });
  expect(await readFile(join(f.home, f.project, "deploy-output.txt"), "utf8")).toBe("");
  expect(JSON.stringify(failed)).not.toContain("private-native");
  expect(await f.setup.run(f.request({ action: "install", displayName: "QA" }))).toEqual({
    status: "installed",
    credentials: f.credentials,
  });
  expect(f.run.mock.calls.filter(([args]) => args[1] === "apps.manifest.create")).toHaveLength(1);
  const links = f.run.mock.calls.filter(([args]) => args[1] === "link");
  expect(links).toHaveLength(2);
  for (const [args] of links)
    expect(args.slice(2)).toEqual(["--team", "T1", "--app", "A1", "--environment", "deployed", "--force"]);
  expect(await f.setup.run(f.request(callbacks()))).toEqual({ status: "connected" });
});
it.each(["pending", "denied"] as const)(
  "lets an authorized installer proceed despite a historical %s request",
  async (status) => {
    const f = await fixture();
    await f.authorize();
    f.setApprovalStatus(status);
    f.allowSelfApproval();
    expect(await f.setup.run(f.request({ action: "install", displayName: "QA", challenge: "code" }))).toEqual({
      status: "installed",
      credentials: f.credentials,
    });
    expect(f.submittedRequests()).toBe(0);
  },
);
it.each([0, 1])("never claims approval is pending without a Slack request, even with CLI exit %i", async (exit) => {
  const f = await fixture();
  await f.authorize();
  const original = f.run.getMockImplementation();
  f.run.mockImplementation(async (args, options) => {
    if (args[1] !== "deploy") return original?.(args, options) ?? 1;
    await writeFile(join(f.home, f.project, "last-error.txt"), "private-token (comment_required)");
    return exit;
  });
  const result = await f.setup.run(f.request({ action: "install", displayName: "QA", challenge: "code" }));
  expect(result).toEqual({
    status: "failed",
    code: "install_failed",
    appId: "A1",
    teamId: "T1",
    ...(exit ? { errorCode: "comment_required" } : {}),
  });
  expect(JSON.stringify(result)).not.toContain("private");
  expect(existsSync(join(f.home, f.project, "last-error.txt"))).toBe(false);
});
it.each([undefined, { ok: true, app_id: "foreign" }, { ok: false, error: "invalid_manifest" }])(
  "does not authorize, mutate, or adopt a foreign App without a matching successful creation record: %j",
  async (record) => {
    const f = await fixture();
    if (record) await writePrivateJson(f.home, join(f.home, f.project, "create-response.json"), record);
    expect(await f.setup.run(f.request(callbacks()))).toEqual({ status: "failed", code: "manual_required" });
    expect(f.run).not.toHaveBeenCalled();
    const saved = existsSync(join(f.home, f.project, "create-response.json"))
      ? JSON.parse(await readFile(join(f.home, f.project, "create-response.json"), "utf8"))
      : undefined;
    expect(saved).toEqual(record);
  },
);
it("preserves the created App and its secret when callbacks target a different bound App", async () => {
  const f = await fixture();
  await f.authorize();
  await f.setup.run(f.request({ action: "install", displayName: "QA", challenge: "code" }));
  const path = join(f.home, f.project, "create-response.json");
  const before = await readFile(path, "utf8");
  f.run.mockClear();
  expect(await f.setup.run(f.request(callbacks("official")))).toEqual({ status: "failed", code: "manual_required" });
  expect(f.run).not.toHaveBeenCalled();
  expect(await readFile(path, "utf8")).toBe(before);
});
it("directs a later reconnect to manual setup after bind acknowledgement removed local creation credentials", async () => {
  const f = await fixture();
  await f.authorize();
  await f.setup.run(f.request({ action: "install", displayName: "QA", challenge: "code" }));
  expect(await f.setup.run(f.request(callbacks()))).toEqual({ status: "connected" });
  f.run.mockClear();
  for (let attempt = 0; attempt < 2; attempt++)
    expect(await f.setup.run(f.request({ action: "install", displayName: "QA" }))).toEqual({
      status: "failed",
      code: "manual_required",
    });
  expect(f.run).not.toHaveBeenCalled();
  expect(await f.setup.run(f.request(callbacks()))).toEqual({ status: "connected" });
});
it("gets one ticket, resumes installation of the same App, and removes material after verified callbacks", async () => {
  const f = await fixture();
  await f.authorize();
  f.setFailDeploy(true);
  expect(await f.setup.run(f.request({ action: "install", displayName: "QA", challenge: "code" }))).toEqual({
    status: "failed",
    code: "install_failed",
    appId: "A1",
    teamId: "T1",
  });
  expect(existsSync(join(f.home, f.project, "credentials.json"))).toBe(false);
  expect(existsSync(join(f.home, f.project, "last-error.txt"))).toBe(false);
  f.setFailDeploy(false);
  expect(await f.setup.run(f.request({ action: "install", displayName: "QA" }))).toEqual({
    status: "installed",
    credentials: f.credentials,
  });
  expect(existsSync(join(f.home, f.project, "credentials.json"))).toBe(false);
  expect(f.run.mock.calls.filter(([args]) => args[1] === "apps.manifest.create")).toHaveLength(1);
  const result = await f.setup.run(
    f.request({
      action: "callbacks",
      appId: "A1",
      teamId: "T1",
      botUserId: "U1",
      enterpriseId: null,
      eventsUrl: "https://qa.example/events",
      interactionsUrl: "https://qa.example/interactions",
    }),
  );
  expect(result).toEqual({ status: "connected" });
  const update = JSON.parse(await readFile(join(f.home, f.project, "callback-update.json"), "utf8"));
  const manifest = JSON.parse(update.manifest);
  expect(manifest.settings.event_subscriptions).toEqual({
    request_url: "https://qa.example/events",
    bot_events: SLACK_SUBSCRIBED_BOT_EVENTS,
  });
  expect(manifest.settings.org_deploy_enabled).toBe(false);
  expect(manifest.settings.interactivity.request_url).toBe("https://qa.example/interactions");
  expect(existsSync(join(f.home, f.project, "credentials.json"))).toBe(false);
  expect(await readFile(join(f.home, f.project, "create-response.json"), "utf8")).not.toContain("private");
  expect((await stat(join(f.home, f.project))).mode & 0o777).toBe(0o700);
  expect(await f.setup.run(f.request({ action: "authorize" }))).toEqual({
    status: "authorized",
    teamName: "local-team",
  });
});
it("never repeats an uncertain creation, even after the Client process is replaced", async () => {
  const f = await fixture();
  await f.authorize();
  f.loseCreate();
  const input = { action: "install" as const, displayName: "QA", challenge: "code" };
  expect(await f.setup.run(f.request(input))).toEqual({ status: "failed", code: "create_uncertain" });
  const restarted = new SlackAutoSetup({
    environment: { OPENTAG_HOME: join(f.home, "..") },
    run: f.run,
    cliEntry: "/trusted/opentag.mjs",
  });
  expect(await restarted.run(f.request(input))).toEqual({ status: "failed", code: "create_uncertain" });
  expect(f.run.mock.calls.filter(([args]) => args[1] === "apps.manifest.create")).toHaveLength(1);
});
it.each(["invalid_manifest", "managed_app_limit_reached", "ratelimited", "access_denied"])(
  "allows a new attempt after Slack definitely rejects creation with %s",
  async (error) => {
    const f = await fixture();
    await f.authorize();
    f.setCreateError(error);
    expect(await f.setup.run(f.request({ action: "install", displayName: "QA", challenge: "code" }))).toEqual({
      status: "failed",
      code: "create_failed",
    });
    expect(existsSync(join(f.home, f.project, "create-response.json"))).toBe(false);
    f.setCreateError(undefined);
    expect(await f.setup.run(f.request({ action: "install", displayName: "QA" }))).toEqual({
      status: "installed",
      credentials: f.credentials,
    });
    expect(f.run.mock.calls.filter(([args]) => args[1] === "apps.manifest.create")).toHaveLength(2);
  },
);
it.each(["internal_error", "fatal_error", "failed_adding_collaborator", "unknown"])(
  "does not repeat a potentially partial Slack create response: %s",
  async (error) => {
    const f = await fixture();
    await f.authorize();
    f.setCreateError(error);
    expect(await f.setup.run(f.request({ action: "install", displayName: "QA", challenge: "code" }))).toEqual({
      status: "failed",
      code: "create_uncertain",
    });
    expect(await f.setup.run(f.request({ action: "install", displayName: "QA" }))).toEqual({
      status: "failed",
      code: "create_uncertain",
    });
    expect(f.run.mock.calls.filter(([args]) => args[1] === "apps.manifest.create")).toHaveLength(1);
  },
);
it("rejects an embedding without an explicit CLI hook entry before consuming the challenge or creating an App", async () => {
  const f = await fixture();
  await f.authorize();
  const embedded = new SlackAutoSetup({ environment: { OPENTAG_HOME: join(f.home, "..") }, run: f.run });
  expect(await embedded.run(f.request({ action: "authorize" }))).toEqual({
    status: "failed",
    code: "capability_missing",
  });
  expect(await embedded.run(f.request({ action: "install", displayName: "QA", challenge: "code" }))).toEqual({
    status: "failed",
    code: "capability_missing",
  });
  expect(f.run).toHaveBeenCalledTimes(1);
});
it("keeps the creation fence when even a known rejection includes an App ID", async () => {
  const f = await fixture();
  await f.authorize();
  f.loseCreate();
  await f.setup.run(f.request({ action: "install", displayName: "QA", challenge: "code" }));
  await writePrivateJson(f.home, join(f.home, f.project, "create-response.json"), {
    ok: false,
    error: "invalid_manifest",
    app_id: "A1",
  });
  expect(await f.setup.run(f.request({ action: "install", displayName: "QA" }))).toEqual({
    status: "failed",
    code: "create_uncertain",
  });
  expect(f.run.mock.calls.filter(([args]) => args[1] === "apps.manifest.create")).toHaveLength(1);
});
it("removes the creation secret once Server requests callbacks, even when updating callbacks fails", async () => {
  const f = await fixture();
  await f.authorize();
  await f.setup.run(f.request({ action: "install", displayName: "QA", challenge: "code" }));
  expect(await readFile(join(f.home, f.project, "create-response.json"), "utf8")).toContain("private-secret");
  f.failCallbacks();
  expect(
    await f.setup.run(
      f.request({
        action: "callbacks",
        appId: "A1",
        teamId: "T1",
        botUserId: "U1",
        enterpriseId: null,
        eventsUrl: "https://qa.example/events",
        interactionsUrl: "https://qa.example/interactions",
      }),
    ),
  ).toEqual({ status: "failed", code: "callbacks_failed" });
  expect(JSON.parse(await readFile(join(f.home, f.project, "create-response.json"), "utf8"))).toEqual({
    ok: true,
    app_id: "A1",
  });
  for (const name of ["credentials.json", "login-output.txt", "login-complete.txt", "last-error.txt"])
    expect(existsSync(join(f.home, f.project, name))).toBe(false);
});
it("does not accept cached credentials for another App or Team", async () => {
  const f = await fixture();
  await f.authorize();
  await f.setup.run(f.request({ action: "install", displayName: "QA", challenge: "code" }));
  await writePrivateJson(f.home, join(f.home, f.project, "credentials.json"), { ...f.credentials, appId: "other" });
  expect(await f.setup.run(f.request({ action: "install", displayName: "QA" }))).toEqual({
    status: "failed",
    code: "install_failed",
  });
});
it("can replace revoked authorization while keeping the same App and expected Team", async () => {
  const f = await fixture();
  await f.authorize();
  await f.setup.run(f.request({ action: "install", displayName: "QA", challenge: "code" }));
  expect(await f.setup.run(f.request({ action: "authorize", force: true }))).toEqual({
    status: "authorization_required",
    ticket: "test-ticket",
  });
  const auth = JSON.parse(await readFile(join(f.home, f.project, "authorization.json"), "utf8"));
  expect(auth).toEqual({ ticket: "test-ticket", teamId: "T1" });
  expect(
    await f.setup.run(
      f.request({
        action: "callbacks",
        appId: "A1",
        teamId: "wrong-team",
        botUserId: "U1",
        enterpriseId: null,
        challenge: "new-code",
        eventsUrl: "https://qa.example/events",
        interactionsUrl: "https://qa.example/interactions",
      }),
    ),
  ).toEqual({ status: "failed", code: "authorization_failed" });
  expect(f.run.mock.calls.some(([args]) => args[1] === "apps.manifest.update")).toBe(false);
  expect(JSON.parse(await readFile(join(f.home, f.project, "authorization.json"), "utf8"))).toEqual(auth);
  expect(await readFile(join(f.home, f.project, "create-response.json"), "utf8")).toContain("private-secret");
  expect(
    await f.setup.run(
      f.request({
        action: "callbacks",
        appId: "A1",
        teamId: "T1",
        botUserId: "U1",
        enterpriseId: null,
        challenge: "newer-code",
        eventsUrl: "https://qa.example/events",
        interactionsUrl: "https://qa.example/interactions",
      }),
    ),
  ).toEqual({ status: "connected" });
  expect(f.run.mock.calls.filter(([args]) => args[1] === "apps.manifest.create")).toHaveLength(1);
});
it("keeps Web management in the local private home when the Computer uses Turn credential proxying", async () => {
  const f = await fixture();
  const local = new SlackAutoSetup({
    environment: {
      OPENTAG_HOME: join(f.home, ".."),
      OPENTAG_RUNTIME_CREDENTIAL_MODE: "proxy",
      OPENTAG_SESSION_SERVER_URL: "https://turn.example",
    },
    run: f.run,
    cliEntry: "/trusted/opentag.mjs",
  });
  expect(await local.run(f.request({ action: "authorize" }))).toEqual({
    status: "authorization_required",
    ticket: "test-ticket",
  });
  expect(f.run.mock.calls[0]?.[1]?.environment).toMatchObject({
    OPENTAG_RUNTIME_CREDENTIAL_MODE: "legacy",
    OPENTAG_SESSION_SERVER_URL: undefined,
  });
  expect(existsSync(join(f.home, f.project, "authorization.json"))).toBe(true);
});
