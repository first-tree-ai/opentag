import { chmod, mkdir, mkdtemp, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

// Real child-process validation needs headroom under parallel CI load.
vi.setConfig({ testTimeout: 30_000 });

import {
  classifyLarkAuthStatus,
  classifySlackAuthTest,
  computeFileIdentity,
  computeTargetFingerprint,
  deriveProviderCliValidationRequestKey,
  exchangeFeishuTenantToken,
  extractBoundedJson,
  FeishuTokenExchangeError,
  type ProviderCliValidationRequest,
  ProviderCliValidationRunner,
  type ProviderCliValidationRunnerOptions,
} from "../index.js";
import { type RecordedLog, recordingLogger } from "./recording-logger.js";

const slackIdentity = { provider: "slack" as const, teamId: "T1", botUserId: "U1", botId: "B1" };
const feishuIdentity = {
  provider: "feishu" as const,
  appId: "cli_app",
  botOpenId: "ou_bot",
  teamBrand: "feishu" as const,
};
const feishuGrant = {
  provider: "feishu" as const,
  appId: "cli_app",
  appSecret: "secret",
  teamBrand: "feishu" as const,
};

const fence = {
  requestId: "11111111-1111-4111-8111-111111111111",
  provider: "slack" as const,
  agentId: "22222222-2222-4222-8222-222222222222",
  integrationId: "33333333-3333-4333-8333-333333333333",
  credentialGeneration: 1,
};
const feishuFence = { ...fence, provider: "feishu" as const };

function slackValidationRequest() {
  return {
    expectedFingerprint: "v1:test",
    expectedIdentity: slackIdentity,
    expiresAt: new Date(Date.now() + 15_000).toISOString(),
    grant: { provider: "slack" as const, botAccessToken: "xoxb-test-token" },
    requestId: fence.requestId,
    targetPath: "/bin/true",
    version: "4.10.0",
  };
}

function feishuValidationRequest() {
  return {
    expectedFingerprint: "v1:test",
    expectedIdentity: feishuIdentity,
    expiresAt: new Date(Date.now() + 15_000).toISOString(),
    grant: feishuGrant,
    requestId: fence.requestId,
    targetPath: "/bin/true",
    version: "1.0.92",
  };
}

async function fakeCli(home: string, script: string): Promise<string> {
  const path = join(home, "cli");
  await writeFile(path, script, { mode: 0o700 });
  await chmod(path, 0o700);
  return path;
}

describe("provider CLI validation classification", () => {
  it("matches Slack team, bot user, and bot identity without requiring app_id", () => {
    expect(
      classifySlackAuthTest(
        { ok: true, team: "Acme", team_id: "T1", user: "bot", user_id: "U1", bot_id: "B1" },
        slackIdentity,
      ),
    ).toEqual({ status: "ready" });
    expect(
      classifySlackAuthTest({ ok: true, team_id: "T2", user_id: "U1", bot_id: "B1", extra: true }, slackIdentity),
    ).toEqual({ status: "needs_attention", reason: "identity_mismatch" });
    expect(classifySlackAuthTest({ ok: false, error: "invalid_auth" }, slackIdentity)).toEqual({
      status: "needs_attention",
      reason: "credential_rejected",
    });
    expect(classifySlackAuthTest("not-json", slackIdentity)).toEqual({ status: "needs_attention" });
  });

  it("accepts raw v1.0.92 and forward-compatible normalized Feishu bot info", () => {
    expect(classifyLarkAuthStatus({ code: 0, msg: "ok", bot: { open_id: "ou_bot" } }, feishuIdentity)).toEqual({
      status: "ready",
    });
    expect(
      classifyLarkAuthStatus(
        { ok: true, identity: "bot", data: { bot: { open_id: "ou_bot", app_name: "OpenTag" } } },
        feishuIdentity,
      ),
    ).toEqual({ status: "ready" });
    expect(classifyLarkAuthStatus({ code: 0, msg: "ok", bot: { open_id: "ou_other" } }, feishuIdentity)).toEqual({
      status: "needs_attention",
      reason: "identity_mismatch",
    });
    expect(
      classifyLarkAuthStatus({ ok: true, identity: "user", data: { bot: { open_id: "ou_bot" } } }, feishuIdentity),
    ).toEqual({ status: "needs_attention", reason: "identity_mismatch" });
    expect(classifyLarkAuthStatus({ ok: true, identity: "bot", data: {} }, feishuIdentity)).toEqual({
      status: "needs_attention",
    });
    expect(classifyLarkAuthStatus({ code: 0, msg: "ok" }, feishuIdentity)).toEqual({
      status: "needs_attention",
    });
    expect(classifyLarkAuthStatus("not-json", feishuIdentity)).toEqual({ status: "needs_attention" });
  });

  it.each([
    [
      "authentication",
      { ok: false, error: { type: "authentication", subtype: "token_invalid", code: 99991663 } },
      { status: "needs_attention", reason: "credential_rejected" },
    ],
    [
      "authorization",
      { ok: false, error: { type: "authorization", subtype: "permission_denied" } },
      { status: "needs_attention", reason: "scope_missing" },
    ],
    [
      "missing scopes",
      { ok: false, error: { type: "api", missing_scopes: ["im:message"] } },
      { status: "needs_attention", reason: "scope_missing" },
    ],
    [
      "rate limit",
      { ok: false, error: { type: "api", subtype: "rate_limit", code: 429, retryable: true } },
      { status: "retrying", reason: "rate_limited" },
    ],
    [
      "network",
      { ok: false, error: { type: "network", subtype: "timeout", retryable: true } },
      { status: "retrying", reason: "provider_unreachable" },
    ],
    [
      "server",
      { ok: false, error: { type: "api", subtype: "server_error", code: 503, retryable: true } },
      { status: "retrying", reason: "provider_unreachable" },
    ],
    [
      "CLI compatibility",
      { ok: false, error: { type: "validation", subtype: "invalid_argument" } },
      { status: "needs_attention", reason: "upgrade_required" },
    ],
    [
      "unknown",
      { ok: false, error: { type: "api", subtype: "unknown" } },
      { status: "retrying", reason: "provider_unreachable" },
    ],
    [
      "transient Feishu internal error code (99991644)",
      { code: 99991644, msg: "upstream hiccup" },
      { status: "retrying", reason: "provider_unreachable" },
    ],
    [
      "rate limit as lark-cli reports it",
      { ok: false, identity: "bot", error: { type: "api", subtype: "rate_limit", code: 99991400, retryable: true } },
      { status: "retrying", reason: "rate_limited" },
    ],
    [
      "rate limit code without normalization",
      { code: 99991400, msg: "limited" },
      { status: "retrying", reason: "rate_limited" },
    ],
    ["rate limit code as a string", { error: { code: "99991400" } }, { status: "retrying", reason: "rate_limited" }],
    [
      "unreachable proxy as lark-cli reports it",
      { ok: false, identity: "bot", error: { type: "network", subtype: "server_error", code: 503 } },
      { status: "retrying", reason: "provider_unreachable" },
    ],
    [
      "invalid app secret as lark-cli reports it",
      { ok: false, identity: "bot", error: { type: "config", subtype: "invalid_client", code: 10014 } },
      { status: "needs_attention", reason: "credential_rejected" },
    ],
    [
      "explicit Feishu credential rejection code without normalization",
      { code: 10003, msg: "invalid app_id" },
      { status: "needs_attention", reason: "credential_rejected" },
    ],
    [
      "IP allowlist rejection (99991401)",
      { code: 99991401, msg: "ip not in whitelist" },
      { status: "needs_attention", reason: "credential_rejected" },
    ],
    [
      "access-control policy refusal (21001)",
      { code: 21001, msg: "Access denied by access control policy" },
      { status: "needs_attention", reason: "credential_rejected" },
    ],
    ["app id unauthorized (10005)", { code: 10005 }, { status: "needs_attention", reason: "credential_rejected" }],
    [
      "app_id and app_secret mismatch (20002)",
      { code: 20002 },
      { status: "needs_attention", reason: "credential_rejected" },
    ],
    [
      "app_id or app_secret does not exist (99991543)",
      { code: 99991543 },
      { status: "needs_attention", reason: "credential_rejected" },
    ],
    [
      "app not in use / deactivated (99991662)",
      { code: 99991662 },
      { status: "needs_attention", reason: "credential_rejected" },
    ],
    [
      "unauthorized app / not installed (99991673)",
      { code: 99991673 },
      { status: "needs_attention", reason: "credential_rejected" },
    ],
  ])("classifies structured Feishu %s failures", (_case, payload, expected) => {
    expect(classifyLarkAuthStatus(payload, feishuIdentity)).toEqual(expected);
  });

  it("extracts one bounded JSON envelope and rejects oversize input", () => {
    expect(extractBoundedJson('noise {"ok":true} trailing')).toEqual({ ok: true });
    expect(extractBoundedJson("not json")).toBeUndefined();
    expect(extractBoundedJson(`{"ok":true}`, 4)).toBeUndefined();
  });

  it("records distinct diagnostics for structural validation rejections", () => {
    const entries: RecordedLog[] = [];
    const logger = recordingLogger(entries);
    classifySlackAuthTest("not-an-object", slackIdentity, logger);
    classifySlackAuthTest({}, slackIdentity, logger);
    classifySlackAuthTest({ ok: false }, slackIdentity, logger);
    classifySlackAuthTest({ ok: true }, slackIdentity, logger);
    classifyLarkAuthStatus("not-an-object", feishuIdentity, logger);
    classifyLarkAuthStatus({ code: 1 }, feishuIdentity, logger);
    classifyLarkAuthStatus({ ok: true, identity: 1 }, feishuIdentity, logger);
    classifyLarkAuthStatus({ code: 0 }, feishuIdentity, logger);

    expect(entries.map((entry) => entry.fields.code)).toEqual([
      "slack_payload_not_record",
      "slack_ok_field_missing",
      "slack_ok_not_true",
      "slack_identity_unparseable",
      "lark_payload_not_record",
      "lark_success_field_invalid",
      "lark_identity_field_invalid",
      "lark_bot_identity_unparseable",
    ]);
  });

  it("records distinct diagnostics for each bounded JSON rejection", () => {
    const entries: RecordedLog[] = [];
    const logger = recordingLogger(entries);
    extractBoundedJson("", 100, logger);
    extractBoundedJson("no object", 100, logger);
    extractBoundedJson("{malformed}", 100, logger);
    extractBoundedJson("x".repeat(101), 100, logger);

    expect(entries.map((entry) => entry.fields.code)).toEqual([
      "json_output_empty",
      "json_object_bounds_missing",
      "json_output_malformed",
      "json_output_oversize",
    ]);
  });

  it("does not copy provider credentials into diagnostic fields", () => {
    const entries: RecordedLog[] = [];
    const logger = recordingLogger(entries);
    const secret = "appSecret-provider-token";

    classifySlackAuthTest({ ok: false, error: secret, token: secret }, slackIdentity, logger);

    expect(JSON.stringify(entries)).not.toContain(secret);
    expect(entries).toEqual([expect.objectContaining({ level: "debug", fields: { code: "slack_ok_not_true" } })]);
  });
});

describe("Feishu tenant token exchange", () => {
  const grant = feishuGrant;

  it.each([200, 400])("reads the Feishu rate limit code on HTTP %i as rate limited, not rejected", async (status) => {
    await expect(
      exchangeFeishuTenantToken(
        grant,
        undefined,
        (async () => new Response(JSON.stringify({ code: 99991400, msg: "limited" }), { status })) as typeof fetch,
      ),
    ).rejects.toMatchObject({ kind: "rate_limited" });
  });

  it.each([200, 400])("still reads an invalid app secret on HTTP %i as rejected", async (status) => {
    await expect(
      exchangeFeishuTenantToken(
        grant,
        undefined,
        (async () => new Response(JSON.stringify({ code: 10014, msg: "invalid" }), { status })) as typeof fetch,
      ),
    ).rejects.toMatchObject({ kind: "credential_rejected" });
  });

  it("classifies 429, non-JSON 503, HTTP 200 code!=0, oversize, and abort", async () => {
    await expect(
      exchangeFeishuTenantToken(grant, undefined, (async () => new Response("{}", { status: 429 })) as typeof fetch),
    ).rejects.toMatchObject({ kind: "rate_limited" });
    await expect(
      exchangeFeishuTenantToken(
        grant,
        undefined,
        (async () => new Response("not-json", { status: 503 })) as typeof fetch,
      ),
    ).rejects.toMatchObject({ kind: "provider_unreachable" });
    await expect(
      exchangeFeishuTenantToken(
        grant,
        undefined,
        (async () => new Response("not-json", { status: 400 })) as typeof fetch,
      ),
    ).rejects.toMatchObject({ kind: "invalid" });
    for (const rejectedCode of [10005, 10014, 20002, 99991401, 99991543, 99991662, 99991673]) {
      await expect(
        exchangeFeishuTenantToken(
          grant,
          undefined,
          (async () => new Response(JSON.stringify({ code: rejectedCode }), { status: 200 })) as typeof fetch,
        ),
      ).rejects.toMatchObject({ kind: "credential_rejected" });
    }
    await expect(
      exchangeFeishuTenantToken(
        grant,
        undefined,
        (async () => new Response(JSON.stringify({ code: 99991644 }), { status: 200 })) as typeof fetch,
      ),
    ).rejects.toMatchObject({ kind: "provider_unreachable" });
    await expect(
      exchangeFeishuTenantToken(
        grant,
        undefined,
        (async () => new Response(JSON.stringify({ code: 99991644 }), { status: 400 })) as typeof fetch,
      ),
    ).rejects.toMatchObject({ kind: "provider_unreachable" });
    await expect(
      exchangeFeishuTenantToken(
        grant,
        undefined,
        (async () =>
          new Response(JSON.stringify({ code: 0, tenant_access_token: "must-not-be-accepted" }), {
            status: 400,
          })) as typeof fetch,
      ),
    ).rejects.toMatchObject({ kind: "credential_rejected" });
    await expect(
      exchangeFeishuTenantToken(
        grant,
        undefined,
        (async () => new Response(Buffer.alloc(2 * 1024 * 1024), { status: 200 })) as typeof fetch,
      ),
    ).rejects.toMatchObject({ kind: "invalid" });
    const aborted = new AbortController();
    aborted.abort();
    await expect(exchangeFeishuTenantToken(grant, aborted.signal, vi.fn())).rejects.toBeInstanceOf(
      FeishuTokenExchangeError,
    );
  });

  it("enforces an independent timeout when the caller supplies no signal", async () => {
    const hangingFetch = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
            once: true,
          });
        }),
    ) as typeof fetch;
    await expect(exchangeFeishuTenantToken(grant, undefined, hangingFetch, 5)).rejects.toMatchObject({
      kind: "provider_unreachable",
    });
    expect(hangingFetch).toHaveBeenCalledTimes(1);
  });
});

describe("provider CLI validation runner", () => {
  it("runs one live Feishu bot-info probe through lark-cli without projecting the app secret", async () => {
    const home = await mkdtemp(join(tmpdir(), "opentag-validation-feishu-"));
    const execFile = vi.fn(async (_file, args, options) => {
      expect(args).toEqual(["api", "GET", "/open-apis/bot/v3/info", "--as", "bot", "--format", "ndjson"]);
      expect(args[0]).not.toBe("auth");
      expect(options.env.LARKSUITE_CLI_APP_ID).toBe("cli_app");
      expect(options.env.LARKSUITE_CLI_APP_SECRET).toBeUndefined();
      expect(options.env.LARKSUITE_CLI_BRAND).toBe("feishu");
      expect(options.env.LARKSUITE_CLI_TENANT_ACCESS_TOKEN).toBe("tenant-token");
      expect(options.env.LARKSUITE_CLI_USER_ACCESS_TOKEN).toBeUndefined();
      expect(options.env.LARKSUITE_CLI_REMOTE_META).toBe("off");
      return { stdout: '{"code":0,"msg":"ok","bot":{"open_id":"ou_bot"}}', stderr: "" };
    });
    const runner = new ProviderCliValidationRunner({
      home,
      exchangeFeishuToken: async () => "tenant-token",
      execFile,
      verifyTarget: async () => true,
    });

    await expect(runner.run(feishuValidationRequest(), feishuFence)).resolves.toEqual({
      ...feishuFence,
      status: "ready",
    });
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(await readdir(join(home, "data", "runtime", "provider-cli-validation"))).toEqual([]);
  });

  it.each([
    ["app", { ...feishuGrant, appId: "cli_other" }],
    ["brand", { ...feishuGrant, teamBrand: "lark" as const }],
  ])("rejects a Feishu grant with the wrong %s before token exchange or spawn", async (_case, grant) => {
    const exchangeFeishuToken = vi.fn(async () => "tenant-token");
    const execFile = vi.fn();
    const runner = new ProviderCliValidationRunner({
      home: await mkdtemp(join(tmpdir(), "opentag-validation-feishu-identity-")),
      exchangeFeishuToken,
      execFile,
      verifyTarget: async () => true,
    });

    await expect(runner.run({ ...feishuValidationRequest(), grant }, feishuFence)).resolves.toMatchObject({
      status: "needs_attention",
      reason: "identity_mismatch",
    });
    expect(exchangeFeishuToken).not.toHaveBeenCalled();
    expect(execFile).not.toHaveBeenCalled();
  });

  it("classifies a nested lark-cli error returned by a non-zero process", async () => {
    const error = Object.assign(new Error("lark-cli exited with code 3"), {
      stdout: JSON.stringify({
        ok: false,
        identity: "bot",
        error: { type: "authentication", subtype: "token_invalid", code: 99991663 },
      }),
      stderr: "",
    });
    const runner = new ProviderCliValidationRunner({
      home: await mkdtemp(join(tmpdir(), "opentag-validation-feishu-error-")),
      exchangeFeishuToken: async () => "tenant-token",
      execFile: vi.fn(async () => {
        throw error;
      }),
      verifyTarget: async () => true,
    });

    await expect(runner.run(feishuValidationRequest(), feishuFence)).resolves.toMatchObject({
      status: "needs_attention",
      reason: "credential_rejected",
    });
  });

  it("executes the Feishu probe in a real isolated child process", async () => {
    const home = await mkdtemp(join(tmpdir(), "opentag-validation-feishu-process-"));
    const targetPath = await fakeCli(
      home,
      `#!/bin/sh
if [ "$1" = "api" ] && [ "$2" = "GET" ] && [ "$3" = "/open-apis/bot/v3/info" ] && [ "$4" = "--as" ] && [ "$5" = "bot" ] && [ "$6" = "--format" ] && [ "$7" = "ndjson" ] && [ "$LARKSUITE_CLI_APP_ID" = "cli_app" ] && [ "$LARKSUITE_CLI_BRAND" = "feishu" ] && [ "$LARKSUITE_CLI_TENANT_ACCESS_TOKEN" = "tenant-token" ] && [ -z "$LARKSUITE_CLI_APP_SECRET" ] && [ -z "$LARKSUITE_CLI_USER_ACCESS_TOKEN" ]; then
  echo '{"code":0,"msg":"ok","bot":{"open_id":"ou_bot"}}'
  exit 0
fi
exit 1
`,
    );
    const runner = new ProviderCliValidationRunner({
      home,
      exchangeFeishuToken: async () => "tenant-token",
      verifyTarget: async () => true,
    });

    await expect(runner.run({ ...feishuValidationRequest(), targetPath }, feishuFence)).resolves.toMatchObject({
      status: "ready",
    });
  });

  it("cleans up after a Feishu CLI timeout", async () => {
    const home = await mkdtemp(join(tmpdir(), "opentag-validation-feishu-timeout-"));
    const runner = new ProviderCliValidationRunner({
      home,
      exchangeFeishuToken: async () => "tenant-token",
      execFile: vi.fn(async () => {
        throw Object.assign(new Error("timeout"), { killed: true, stdout: "", stderr: "" });
      }),
      verifyTarget: async () => true,
    });

    await expect(runner.run(feishuValidationRequest(), feishuFence)).resolves.toMatchObject({
      status: "retrying",
      reason: "provider_unreachable",
    });
    expect(await readdir(join(home, "data", "runtime", "provider-cli-validation"))).toEqual([]);
  });

  it("runs the Slack auth.test argv in an isolated env and never persists the grant", async () => {
    const home = await mkdtemp(join(tmpdir(), "opentag-validation-"));
    const targetPath = await fakeCli(
      home,
      `#!/bin/sh
if [ "$1" = "--skip-update" ] && [ "$2" = "--config-dir" ] && [ "$4" = "api" ] && [ "$5" = "auth.test" ]; then
  echo '{"ok":true,"team_id":"T1","user_id":"U1","bot_id":"B1"}'
  exit 0
fi
exit 1
`,
    );
    const runner = new ProviderCliValidationRunner({ home, verifyTarget: async () => true });
    const result = await runner.run(
      {
        expectedFingerprint: "v1:test",
        expectedIdentity: slackIdentity,
        expiresAt: new Date(Date.now() + 15_000).toISOString(),
        grant: { provider: "slack", botAccessToken: "xoxb-secret-token" },
        requestId: fence.requestId,
        targetPath,
        version: "4.10.0",
      },
      fence,
    );
    expect(result).toEqual({ ...fence, status: "ready" });
    expect(deriveProviderCliValidationRequestKey(fence.requestId)).toHaveLength(32);
  });

  it("creates only private HOME/XDG directories and runs from the request work directory", async () => {
    const home = await mkdtemp(join(tmpdir(), "opentag-validation-env-"));
    const execFile = vi.fn(async (_file, _args, options) => {
      const env = options.env;
      const cwd = options.cwd;
      if (!cwd) throw new Error("validation cwd is missing");
      expect(env.HOME).toBe(join(cwd, "home"));
      expect(env.XDG_CONFIG_HOME).toBe(join(cwd, "config"));
      expect(env.XDG_CACHE_HOME).toBe(join(cwd, "cache"));
      expect(env.XDG_STATE_HOME).toBe(join(cwd, "state"));
      expect(env.XDG_RUNTIME_DIR).toBe(join(cwd, "runtime"));
      expect(env.TMPDIR).toBe(join(cwd, "tmp"));
      expect(env.SLACK_BOT_TOKEN).toBe("xoxb-secret-token");
      for (const child of [".", "home", "config", "tmp", "cache", "state", "runtime"]) {
        expect((await stat(child === "." ? cwd : join(cwd, child))).mode & 0o777).toBe(0o700);
      }
      return { stdout: '{"ok":true,"team_id":"T1","user_id":"U1","bot_id":"B1"}', stderr: "" };
    });
    const runner = new ProviderCliValidationRunner({ home, execFile, verifyTarget: async () => true });
    await expect(
      runner.run(
        {
          expectedFingerprint: "v1:test",
          expectedIdentity: slackIdentity,
          expiresAt: new Date(Date.now() + 15_000).toISOString(),
          grant: { provider: "slack", botAccessToken: "xoxb-secret-token" },
          requestId: fence.requestId,
          targetPath: "/bin/true",
          version: "4.10.0",
        },
        fence,
      ),
    ).resolves.toMatchObject({ status: "ready" });
  });

  it("rejects expired grants and drifted targets before spawning", async () => {
    const home = await mkdtemp(join(tmpdir(), "opentag-validation-"));
    const execFile = vi.fn();
    const runner = new ProviderCliValidationRunner({
      home,
      execFile,
      now: () => Date.parse("2026-08-31T00:00:16.000Z"),
      verifyTarget: async () => false,
    });
    const expired = await runner.run(
      {
        expectedFingerprint: "v1:test",
        expectedIdentity: slackIdentity,
        expiresAt: "2026-08-31T00:00:15.000Z",
        grant: { provider: "slack", botAccessToken: "xoxb-secret-token" },
        requestId: fence.requestId,
        targetPath: "/bin/true",
        version: "4.10.0",
      },
      fence,
    );
    expect(expired).toMatchObject({ status: "retrying", reason: "validation_expired" });
    expect(execFile).not.toHaveBeenCalled();
    const live = new ProviderCliValidationRunner({
      home,
      execFile,
      now: () => Date.parse("2026-08-31T00:00:10.000Z"),
      verifyTarget: async () => false,
    });
    await expect(
      live.run(
        {
          expectedFingerprint: "v1:test",
          expectedIdentity: slackIdentity,
          expiresAt: "2026-08-31T00:00:15.000Z",
          grant: { provider: "slack", botAccessToken: "xoxb-secret-token" },
          requestId: fence.requestId,
          targetPath: "/bin/true",
          version: "4.10.0",
        },
        fence,
      ),
    ).resolves.toMatchObject({ status: "retrying", reason: "artifact_changed" });
    expect(execFile).not.toHaveBeenCalled();
  });

  it("runs queued Agents, accounts, providers, and credential generations in FIFO order", async () => {
    const home = await mkdtemp(join(tmpdir(), "opentag-validation-"));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const execFile = vi.fn<NonNullable<ProviderCliValidationRunnerOptions["execFile"]>>(
      async (_file, _args, { env }) => {
        if (env.SLACK_BOT_TOKEN === "xoxb-test-token") {
          await gate;
          throw new Error("provider connection failed");
        }
        if (env.SLACK_BOT_TOKEN === "xoxb-other-team") {
          return { stdout: '{"ok":true,"team_id":"T2","user_id":"U2","bot_id":"B2"}', stderr: "" };
        }
        if (env.LARKSUITE_CLI_TENANT_ACCESS_TOKEN === "tenant-test-token") {
          expect(env.SLACK_BOT_TOKEN).toBeUndefined();
          return { stdout: '{"code":0,"msg":"ok","bot":{"open_id":"ou_bot"}}', stderr: "" };
        }
        return { stdout: '{"ok":true,"team_id":"T1","user_id":"U1","bot_id":"B1"}', stderr: "" };
      },
    );
    const runner = new ProviderCliValidationRunner({
      home,
      execFile,
      exchangeFeishuToken: async () => "tenant-test-token",
      verifyTarget: async () => true,
    });
    const first = runner.run(slackValidationRequest(), fence);
    await vi.waitFor(() => expect(execFile).toHaveBeenCalledTimes(1));
    const otherAccount = {
      ...fence,
      requestId: "other-account",
      agentId: "other-agent",
      integrationId: "other-integration",
    };
    const otherProvider = { ...feishuFence, requestId: "feishu-request", integrationId: "feishu-integration" };
    const nextGeneration = { ...fence, requestId: "next-generation", credentialGeneration: 2 };
    const results = Promise.all([
      first,
      runner.run(
        {
          ...slackValidationRequest(),
          requestId: otherAccount.requestId,
          expectedIdentity: { ...slackIdentity, teamId: "T2", botUserId: "U2", botId: "B2" },
          grant: { provider: "slack", botAccessToken: "xoxb-other-team" },
        },
        otherAccount,
      ),
      runner.run({ ...feishuValidationRequest(), requestId: otherProvider.requestId }, otherProvider),
      runner.run(
        {
          ...slackValidationRequest(),
          requestId: nextGeneration.requestId,
          grant: { provider: "slack", botAccessToken: "xoxb-rotated" },
        },
        nextGeneration,
      ),
    ]);
    await Promise.resolve();
    expect(execFile).toHaveBeenCalledTimes(1);
    release();
    await expect(results).resolves.toEqual([
      { ...fence, status: "retrying", reason: "provider_unreachable" },
      { ...otherAccount, status: "ready" },
      { ...otherProvider, status: "ready" },
      { ...nextGeneration, status: "ready" },
    ]);
    expect(
      execFile.mock.calls.map(([, , { env }]) => env.SLACK_BOT_TOKEN ?? env.LARKSUITE_CLI_TENANT_ACCESS_TOKEN),
    ).toEqual(["xoxb-test-token", "xoxb-other-team", "tenant-test-token", "xoxb-rotated"]);
    expect(new Set(execFile.mock.calls.map(([, , { cwd }]) => cwd)).size).toBe(4);
  });

  it("bounds the queue and immediately frees cancelled waiting slots", async () => {
    const home = await mkdtemp(join(tmpdir(), "opentag-validation-"));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const execFile = vi.fn(async () => {
      await gate;
      return { stdout: '{"ok":true,"team_id":"T1","user_id":"U1","bot_id":"B1"}', stderr: "" };
    });
    const runner = new ProviderCliValidationRunner({ home, execFile, verifyTarget: async () => true });
    const active = new AbortController();
    const first = runner.run(slackValidationRequest(), fence, active.signal);
    await vi.waitFor(() => expect(execFile).toHaveBeenCalledTimes(1));
    const cancelled = new AbortController();
    const waiting = Array.from({ length: 8 }, (_, index) => {
      const requestId = `waiting-${index}`;
      return runner.run(
        { ...slackValidationRequest(), requestId },
        { ...fence, requestId },
        index === 0 ? cancelled.signal : undefined,
      );
    });
    const overflowFence = { ...fence, requestId: "overflow" };
    const overflowRequest = { ...slackValidationRequest(), requestId: overflowFence.requestId };
    try {
      await expect(runner.run(overflowRequest, overflowFence)).resolves.toEqual({
        ...overflowFence,
        status: "retrying",
        reason: "validation_busy",
      });
      cancelled.abort();
      await expect(waiting[0]).rejects.toHaveProperty("name", "AbortError");
      await expect(runner.run(overflowRequest, overflowFence, cancelled.signal)).rejects.toHaveProperty(
        "name",
        "AbortError",
      );
      const replacement = runner.run(overflowRequest, overflowFence);
      active.abort();
      const aborted = expect(first).rejects.toHaveProperty("name", "AbortError");
      await Promise.resolve();
      expect(execFile).toHaveBeenCalledTimes(1);
      release();
      await aborted;
      await expect(Promise.all(waiting.slice(1))).resolves.toEqual(
        Array.from({ length: 7 }, (_, index) => ({ ...fence, requestId: `waiting-${index + 1}`, status: "ready" })),
      );
      await expect(replacement).resolves.toEqual({ ...overflowFence, status: "ready" });
      expect(execFile).toHaveBeenCalledTimes(9);
    } finally {
      release();
      await Promise.allSettled([first, ...waiting]);
    }
  });

  it("expires a queued grant before the active probe ends and rechecks the target at execution", async () => {
    const home = await mkdtemp(join(tmpdir(), "opentag-validation-"));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const execFile = vi.fn(async () => {
      await gate;
      return { stdout: '{"ok":true,"team_id":"T1","user_id":"U1","bot_id":"B1"}', stderr: "" };
    });
    let targetChanged = false;
    const verifyTarget = vi.fn(async () => !targetChanged);
    const runner = new ProviderCliValidationRunner({ home, execFile, verifyTarget });
    const active = runner.run(slackValidationRequest(), fence);
    await vi.waitFor(() => expect(execFile).toHaveBeenCalledTimes(1));
    vi.useFakeTimers();
    const expired = { ...fence, requestId: "expired" };
    const drifted = { ...fence, requestId: "drifted" };
    const expiring = runner.run(
      { ...slackValidationRequest(), requestId: expired.requestId, expiresAt: new Date(Date.now() + 25).toISOString() },
      expired,
    );
    const waiting = runner.run({ ...slackValidationRequest(), requestId: drifted.requestId }, drifted);
    try {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(25);
      await expect(expiring).resolves.toEqual({ ...expired, status: "retrying", reason: "validation_expired" });
      expect(verifyTarget).toHaveBeenCalledTimes(1);
      targetChanged = true;
      release();
      await expect(active).resolves.toEqual({ ...fence, status: "ready" });
      await expect(waiting).resolves.toEqual({ ...drifted, status: "retrying", reason: "artifact_changed" });
      expect(execFile).toHaveBeenCalledTimes(1);
      expect(verifyTarget.mock.calls).toHaveLength(2);
    } finally {
      vi.useRealTimers();
      release();
      await Promise.allSettled([active, expiring, waiting]);
    }
  });

  it("fails closed when startup cleanup fails", async () => {
    const home = await mkdtemp(join(tmpdir(), "opentag-validation-fail-"));
    const runtime = join(home, "data", "runtime");
    await mkdir(runtime, { recursive: true });
    await writeFile(join(runtime, "provider-cli-validation"), "not-a-directory");
    const execFile = vi.fn();
    const runner = new ProviderCliValidationRunner({ home, execFile, verifyTarget: async () => true });
    await expect(
      runner.run(
        {
          expectedFingerprint: "v1:test",
          expectedIdentity: slackIdentity,
          expiresAt: new Date(Date.now() + 15_000).toISOString(),
          grant: { provider: "slack", botAccessToken: "xoxb-secret-token" },
          requestId: fence.requestId,
          targetPath: "/bin/true",
          version: "4.10.0",
        },
        fence,
      ),
    ).rejects.toThrow();
    expect(execFile).not.toHaveBeenCalled();
  });

  it("classifies non-JSON without spawning a second process", async () => {
    const home = await mkdtemp(join(tmpdir(), "opentag-validation-"));
    const nonJsonExitOne = await fakeCli(home, "#!/bin/sh\necho not-json\nexit 1\n");
    const runner = new ProviderCliValidationRunner({ home, verifyTarget: async () => true });
    await expect(
      runner.run(
        {
          expectedFingerprint: "v1:test",
          expectedIdentity: slackIdentity,
          expiresAt: new Date(Date.now() + 15_000).toISOString(),
          grant: { provider: "slack", botAccessToken: "xoxb-secret-token" },
          requestId: fence.requestId,
          targetPath: nonJsonExitOne,
          version: "4.10.0",
        },
        fence,
      ),
    ).resolves.toMatchObject({ status: "retrying", reason: "provider_unreachable" });
    const nonJsonExitZero = await fakeCli(home, "#!/bin/sh\necho not-json\nexit 0\n");
    await expect(
      runner.run(
        {
          expectedFingerprint: "v1:test",
          expectedIdentity: slackIdentity,
          expiresAt: new Date(Date.now() + 15_000).toISOString(),
          grant: { provider: "slack", botAccessToken: "xoxb-secret-token" },
          requestId: fence.requestId,
          targetPath: nonJsonExitZero,
          version: "4.10.0",
        },
        fence,
      ),
    ).resolves.toMatchObject({ status: "retrying", reason: "provider_unreachable" });
  });

  it("enforces the combined UTF-8 output bound and classifies child timeout", async () => {
    const home = await mkdtemp(join(tmpdir(), "opentag-validation-output-"));
    const oversized = new ProviderCliValidationRunner({
      home,
      execFile: vi.fn(async () => ({ stdout: "界".repeat(400_000), stderr: "" })),
      verifyTarget: async () => true,
    });
    const request = {
      expectedFingerprint: "v1:test",
      expectedIdentity: slackIdentity,
      expiresAt: new Date(Date.now() + 15_000).toISOString(),
      grant: { provider: "slack" as const, botAccessToken: "xoxb-secret-token" },
      requestId: fence.requestId,
      targetPath: "/bin/true",
      version: "4.10.0",
    };
    await expect(oversized.run(request, fence)).resolves.toMatchObject({ status: "needs_attention" });

    const timedOut = new ProviderCliValidationRunner({
      home: await mkdtemp(join(tmpdir(), "opentag-validation-timeout-")),
      execFile: vi.fn(async () => {
        throw Object.assign(new Error("timeout"), { killed: true, stdout: "", stderr: "" });
      }),
      verifyTarget: async () => true,
    });
    await expect(timedOut.run(request, fence)).resolves.toMatchObject({
      status: "retrying",
      reason: "provider_unreachable",
    });
  });

  it("runs proxy readiness through the Server-authorized validation session and always cleans it up", async () => {
    const home = await mkdtemp(join(tmpdir(), "opentag-validation-proxy-"));
    const cleaned: string[] = [];
    const execFile = vi.fn(async (_file, args, options) => {
      expect(args).toEqual([
        "--skip-update",
        "--config-dir",
        expect.any(String),
        "--apihost",
        "https://127.0.0.1:9",
        "api",
        "auth.test",
      ]);
      expect(options.env.SLACK_BOT_TOKEN).toBe("otrh_local_handle");
      expect(options.env.SLACK_BOT_TOKEN).not.toContain("secret");
      return { stdout: '{"ok":true,"team_id":"T1","user_id":"U1","bot_id":"B1"}', stderr: "" };
    });
    const openProxyValidation = vi.fn(async (_request: ProviderCliValidationRequest) => ({
      arguments: ["--apihost", "https://127.0.0.1:9"],
      environment: { SLACK_BOT_TOKEN: "otrh_local_handle", SLACK_USER_TOKEN: undefined },
      cleanup: async () => {
        cleaned.push("cleanup");
      },
    }));
    const runner = new ProviderCliValidationRunner({
      home,
      execFile,
      openProxyValidation,
      proxyCredentialMode: true,
      verifyTarget: async () => true,
    });
    await expect(
      runner.run(
        {
          expectedFingerprint: "v1:test",
          expectedIdentity: slackIdentity,
          expiresAt: new Date(Date.now() + 15_000).toISOString(),
          requestId: fence.requestId,
          targetPath: "/bin/true",
          version: "4.10.0",
          agentId: fence.agentId,
          validationRunId: "77777777-7777-4777-8777-777777777777",
        },
        fence,
      ),
    ).resolves.toEqual({ ...fence, status: "ready" });
    expect(openProxyValidation.mock.calls[0]?.[0]).toMatchObject({
      agentId: fence.agentId,
      validationRunId: "77777777-7777-4777-8777-777777777777",
    });
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(cleaned).toEqual(["cleanup"]);
  });

  it("clearly rejects proxy readiness without a validation run instead of using raw material", async () => {
    const execFile = vi.fn();
    const runner = new ProviderCliValidationRunner({
      home: await mkdtemp(join(tmpdir(), "opentag-validation-proxy-none-")),
      execFile,
      proxyCredentialMode: true,
      verifyTarget: async () => true,
    });
    await expect(
      runner.run(
        {
          expectedFingerprint: "v1:test",
          expectedIdentity: slackIdentity,
          expiresAt: new Date(Date.now() + 15_000).toISOString(),
          grant: { provider: "slack", botAccessToken: "xoxb-secret-token" },
          requestId: fence.requestId,
          targetPath: "/bin/true",
          version: "4.10.0",
        },
        fence,
      ),
    ).resolves.toEqual({ ...fence, status: "needs_attention" });
    expect(execFile).not.toHaveBeenCalled();
  });

  it("runs proxy Feishu readiness and rejects every pre-open proxy state", async () => {
    const home = await mkdtemp(join(tmpdir(), "opentag-validation-proxy-feishu-"));
    const targetPath = await fakeCli(home, "#!/bin/sh\nexit 0\n");
    const identity = await computeFileIdentity(targetPath);
    const request = {
      expectedFingerprint: computeTargetFingerprint(identity, "1.0.92"),
      expectedIdentity: feishuIdentity,
      expiresAt: new Date(Date.now() + 15_000).toISOString(),
      requestId: fence.requestId,
      targetPath,
      version: "1.0.92",
      agentId: fence.agentId,
      validationRunId: "77777777-7777-4777-8777-777777777777",
    };
    const execFile = vi.fn(async (_file, args, options) => {
      expect(args).toEqual([
        "api",
        "GET",
        "/open-apis/bot/v3/info",
        "--as",
        "bot",
        "--format",
        "ndjson",
        "--apihost",
        "https://127.0.0.1:9",
      ]);
      expect(options.env.LARKSUITE_CLI_TENANT_ACCESS_TOKEN).toBe("otrh_tenant_handle");
      expect(options.env.LARKSUITE_CLI_USER_ACCESS_TOKEN).toBeUndefined();
      expect(options.env.LARKSUITE_CLI_APP_SECRET).toBeUndefined();
      expect(options.env.LARKSUITE_CLI_REMOTE_META).toBe("off");
      return { stdout: '{"code":0,"msg":"ok","bot":{"open_id":"ou_bot"}}', stderr: "" };
    });
    const cleaned: string[] = [];
    const sessionAbort = new AbortController();
    const openProxyValidation = vi.fn(async () => ({
      arguments: ["--apihost", "https://127.0.0.1:9"],
      environment: {
        LARKSUITE_CLI_TENANT_ACCESS_TOKEN: "otrh_tenant_handle",
        LARKSUITE_CLI_USER_ACCESS_TOKEN: undefined,
        LARKSUITE_CLI_REMOTE_META: "on",
      },
      signal: sessionAbort.signal,
      cleanup: async () => {
        cleaned.push("cleanup");
      },
    }));
    const runner = new ProviderCliValidationRunner({
      home,
      execFile,
      openProxyValidation,
      proxyCredentialMode: true,
    });
    const runAbort = new AbortController();
    await expect(runner.run(request, feishuFence, runAbort.signal)).resolves.toEqual({
      ...feishuFence,
      status: "ready",
    });
    expect(cleaned).toEqual(["cleanup"]);
    expect(execFile).toHaveBeenCalledTimes(1);

    const withoutRun = new ProviderCliValidationRunner({
      home,
      execFile,
      openProxyValidation,
      proxyCredentialMode: true,
    });
    await expect(withoutRun.run({ ...request, validationRunId: undefined }, feishuFence)).resolves.toEqual({
      ...feishuFence,
      status: "needs_attention",
    });

    const expired = new ProviderCliValidationRunner({
      home,
      execFile,
      openProxyValidation,
      proxyCredentialMode: true,
      now: () => Date.parse("2026-08-31T00:00:16.000Z"),
    });
    await expect(
      expired.run({ ...request, expiresAt: "2026-08-31T00:00:15.000Z" }, feishuFence),
    ).resolves.toMatchObject({ status: "retrying", reason: "validation_expired" });

    const drifted = new ProviderCliValidationRunner({
      home,
      execFile,
      openProxyValidation,
      proxyCredentialMode: true,
      verifyTarget: async () => false,
    });
    await expect(drifted.run(request, feishuFence)).resolves.toMatchObject({
      status: "retrying",
      reason: "artifact_changed",
    });
  });

  it("opens each queued proxy run with its own authority after the previous session closes", async () => {
    const home = await mkdtemp(join(tmpdir(), "opentag-validation-proxy-queue-"));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const releaseSession = vi.fn(async () => {
      await gate;
    });
    const openProxyValidation = vi.fn(async (request: ProviderCliValidationRequest) => ({
      environment: { SLACK_BOT_TOKEN: `otrh_${request.validationRunId}` },
      cleanup: releaseSession,
    }));
    const execFile = vi.fn<NonNullable<ProviderCliValidationRunnerOptions["execFile"]>>(async () => ({
      stdout: '{"ok":true,"team_id":"T1","user_id":"U1","bot_id":"B1"}',
      stderr: "",
    }));
    const runner = new ProviderCliValidationRunner({
      home,
      execFile,
      openProxyValidation,
      proxyCredentialMode: true,
      verifyTarget: async () => true,
    });
    const first = runner.run({ ...slackValidationRequest(), agentId: fence.agentId, validationRunId: "first" }, fence);
    await vi.waitFor(() => expect(releaseSession).toHaveBeenCalledTimes(1));
    const secondFence = { ...fence, requestId: "second-request", agentId: "second-agent" };
    const second = runner.run(
      {
        ...slackValidationRequest(),
        requestId: secondFence.requestId,
        agentId: secondFence.agentId,
        validationRunId: "second",
      },
      secondFence,
    );
    await Promise.resolve();
    expect(openProxyValidation).toHaveBeenCalledTimes(1);
    release();
    await expect(Promise.all([first, second])).resolves.toEqual([
      { ...fence, status: "ready" },
      { ...secondFence, status: "ready" },
    ]);
    expect(openProxyValidation.mock.calls.map(([request]) => [request.agentId, request.validationRunId])).toEqual([
      [fence.agentId, "first"],
      [secondFence.agentId, "second"],
    ]);
    expect(execFile.mock.calls.map(([, , { env }]) => env.SLACK_BOT_TOKEN)).toEqual(["otrh_first", "otrh_second"]);
    expect(releaseSession).toHaveBeenCalledTimes(2);
  });

  it("releases a failing proxy Feishu session and reports the pre-probe mismatch", async () => {
    const home = await mkdtemp(join(tmpdir(), "opentag-validation-proxy-feishu-failure-"));
    const targetPath = await fakeCli(home, "#!/bin/sh\nexit 1\n");
    const identity = await computeFileIdentity(targetPath);
    const request = {
      expectedFingerprint: computeTargetFingerprint(identity, "1.0.92"),
      expectedIdentity: feishuIdentity,
      expiresAt: new Date(Date.now() + 15_000).toISOString(),
      requestId: fence.requestId,
      targetPath,
      version: "1.0.92",
      agentId: fence.agentId,
      validationRunId: "77777777-7777-4777-8777-777777777777",
    };
    const cleaned: string[] = [];
    const exploding = new ProviderCliValidationRunner({
      home,
      execFile: vi.fn(async () => {
        throw new Error("probe exploded");
      }),
      openProxyValidation: async () => ({
        environment: {},
        cleanup: async () => {
          cleaned.push("attempted");
          throw new Error("release failed");
        },
      }),
      proxyCredentialMode: true,
    });
    await expect(exploding.run(request, feishuFence)).resolves.toMatchObject({
      status: "retrying",
      reason: "provider_unreachable",
    });
    expect(cleaned).toEqual(["attempted"]);

    const execFile = vi.fn();
    const mismatched = new ProviderCliValidationRunner({
      home,
      execFile,
      openProxyValidation: async () => ({ environment: {}, cleanup: async () => undefined }),
      proxyCredentialMode: true,
    });
    await expect(mismatched.run({ ...request, expectedIdentity: slackIdentity }, feishuFence)).resolves.toEqual({
      ...feishuFence,
      status: "needs_attention",
    });
    expect(execFile).not.toHaveBeenCalled();
  });

  it("reports a Feishu grant that faces a non-Feishu identity, and re-checks expiry after the token exchange", async () => {
    const home = await mkdtemp(join(tmpdir(), "opentag-validation-feishu-late-expiry-"));
    const execFile = vi.fn();
    const mismatched = new ProviderCliValidationRunner({
      home,
      execFile,
      exchangeFeishuToken: async () => "tenant-token",
      verifyTarget: async () => true,
    });
    await expect(
      mismatched.run({ ...feishuValidationRequest(), expectedIdentity: slackIdentity }, feishuFence),
    ).resolves.toMatchObject({ status: "needs_attention", reason: "identity_mismatch" });
    expect(execFile).not.toHaveBeenCalled();

    let nowMs = Date.parse("2026-08-31T00:00:10.000Z");
    const expiring = new ProviderCliValidationRunner({
      home,
      execFile,
      exchangeFeishuToken: async () => {
        nowMs = Date.parse("2026-08-31T00:00:16.000Z");
        return "tenant-token";
      },
      now: () => nowMs,
      verifyTarget: async () => true,
    });
    await expect(
      expiring.run({ ...feishuValidationRequest(), expiresAt: "2026-08-31T00:00:15.000Z" }, feishuFence),
    ).resolves.toMatchObject({ status: "retrying", reason: "validation_expired" });
    expect(execFile).not.toHaveBeenCalled();
  });

  it("rejects a non-proxy readiness request that carries no grant instead of falling back", async () => {
    const execFile = vi.fn();
    const runner = new ProviderCliValidationRunner({
      home: await mkdtemp(join(tmpdir(), "opentag-validation-no-grant-")),
      execFile,
      verifyTarget: async () => true,
    });
    await expect(
      runner.run(
        {
          expectedFingerprint: "v1:test",
          expectedIdentity: slackIdentity,
          expiresAt: new Date(Date.now() + 15_000).toISOString(),
          requestId: fence.requestId,
          targetPath: "/bin/true",
          version: "4.10.0",
        },
        fence,
      ),
    ).resolves.toEqual({ ...fence, status: "needs_attention" });
    expect(execFile).not.toHaveBeenCalled();
  });

  it("fails closed when validation cleanup cannot scan or remove work", async () => {
    const slackRequest = {
      expectedFingerprint: "v1:test",
      expectedIdentity: slackIdentity,
      expiresAt: new Date(Date.now() + 15_000).toISOString(),
      grant: { provider: "slack" as const, botAccessToken: "xoxb-secret-token" },
      requestId: fence.requestId,
      targetPath: "/bin/true",
      version: "4.10.0",
    };
    const removeHome = await mkdtemp(join(tmpdir(), "opentag-validation-cleanup-remove-"));
    const removeRunner = new ProviderCliValidationRunner({ home: removeHome });
    const root = join(removeHome, "data", "runtime", "provider-cli-validation");
    await mkdir(join(root, "leftover"), { recursive: true, mode: 0o700 });
    await writeFile(join(root, "leftover", "work.log"), "stale\n", { mode: 0o600 });
    await chmod(join(root, "leftover"), 0o000);
    try {
      await expect(removeRunner.cleanupAll()).rejects.toThrow("Provider CLI validation cleanup failed");
    } finally {
      await chmod(join(root, "leftover"), 0o700).catch(() => undefined);
    }

    const scanHome = await mkdtemp(join(tmpdir(), "opentag-validation-cleanup-scan-"));
    const scanRoot = join(scanHome, "data", "runtime", "provider-cli-validation");
    await mkdir(scanRoot, { recursive: true, mode: 0o700 });
    await chmod(scanRoot, 0o000);
    try {
      const scanRunner = new ProviderCliValidationRunner({ home: scanHome, verifyTarget: async () => true });
      await expect(scanRunner.run(slackRequest, fence)).rejects.toMatchObject({ code: "EACCES" });
    } finally {
      await chmod(scanRoot, 0o700).catch(() => undefined);
    }
  });

  it("uses the injected fetch for the default Feishu tenant token exchange", async () => {
    const home = await mkdtemp(join(tmpdir(), "opentag-validation-fetch-"));
    const targetPath = await fakeCli(home, "#!/bin/sh\nexit 1\n");
    const identity = await computeFileIdentity(targetPath);
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ code: 0, tenant_access_token: "tenant-from-fetch" }), { status: 200 }),
    );
    const execFile = vi.fn(async (_file, _args, options) => {
      expect(options.env.LARKSUITE_CLI_TENANT_ACCESS_TOKEN).toBe("tenant-from-fetch");
      return { stdout: '{"code":0,"msg":"ok","bot":{"open_id":"ou_bot"}}', stderr: "" };
    });
    const runner = new ProviderCliValidationRunner({
      home,
      fetch: fetchMock as unknown as typeof fetch,
      execFile,
      verifyTarget: async () => true,
    });
    await expect(
      runner.run(
        { ...feishuValidationRequest(), targetPath, expectedFingerprint: computeTargetFingerprint(identity, "1.0.92") },
        feishuFence,
      ),
    ).resolves.toEqual({ ...feishuFence, status: "ready" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("logs distinct local spawn and setup diagnostic codes when process spawn fails with ENOENT", async () => {
    const home = await mkdtemp(join(tmpdir(), "opentag-validation-enoent-"));
    const entries: RecordedLog[] = [];
    const logger = recordingLogger(entries);
    const runner = new ProviderCliValidationRunner({
      home,
      logger,
      execFile: async () => {
        throw Object.assign(new Error("spawn /missing ENOENT"), { code: "ENOENT" });
      },
      verifyTarget: async () => true,
    });
    await expect(
      runner.run(
        {
          expectedFingerprint: "v1:test",
          expectedIdentity: slackIdentity,
          expiresAt: new Date(Date.now() + 15_000).toISOString(),
          grant: { provider: "slack", botAccessToken: "xoxb-secret-token" },
          requestId: fence.requestId,
          targetPath: "/bin/true",
          version: "4.10.0",
        },
        fence,
      ),
    ).resolves.toEqual({ ...fence, status: "retrying", reason: "provider_unreachable" });
    expect(entries.map((entry) => entry.fields.code)).toContain("validation_process_spawn_failed");
    expect(entries.map((entry) => entry.fields)).toContainEqual({
      code: "local_validation_error",
      errno: "ENOENT",
    });
  });
});
