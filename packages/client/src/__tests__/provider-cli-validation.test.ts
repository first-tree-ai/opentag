import { chmod, mkdir, mkdtemp, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  classifyLarkAuthStatus,
  classifySlackAuthTest,
  deriveProviderCliValidationRequestKey,
  exchangeFeishuTenantToken,
  extractBoundedJson,
  FeishuTokenExchangeError,
  ProviderCliValidationRunner,
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
    ["unknown", { ok: false, error: { type: "api", subtype: "unknown" } }, { status: "needs_attention" }],
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
        (async () => new Response(JSON.stringify({ code: 10014 }), { status: 200 })) as typeof fetch,
      ),
    ).rejects.toMatchObject({ kind: "credential_rejected" });
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
        version: "4.7.0",
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
          version: "4.7.0",
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
        version: "4.7.0",
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
          version: "4.7.0",
        },
        fence,
      ),
    ).resolves.toMatchObject({ status: "retrying", reason: "artifact_changed" });
    expect(execFile).not.toHaveBeenCalled();
  });

  it("allows only one process and returns validation_busy to the waiter", async () => {
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
    const request = {
      expectedFingerprint: "v1:test",
      expectedIdentity: slackIdentity,
      expiresAt: new Date(Date.now() + 15_000).toISOString(),
      grant: { provider: "slack" as const, botAccessToken: "xoxb-secret-token" },
      requestId: fence.requestId,
      targetPath: "/bin/true",
      version: "4.7.0",
    };
    const first = runner.run(request, fence);
    await vi.waitFor(() => expect(execFile).toHaveBeenCalledTimes(1));
    await expect(runner.run(request, fence)).resolves.toMatchObject({
      status: "retrying",
      reason: "validation_busy",
    });
    release();
    await expect(first).resolves.toMatchObject({ status: "ready" });
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
          version: "4.7.0",
        },
        fence,
      ),
    ).rejects.toThrow();
    expect(execFile).not.toHaveBeenCalled();
  });

  it("classifies non-JSON without spawning a second process", async () => {
    const home = await mkdtemp(join(tmpdir(), "opentag-validation-"));
    const nonJson = await fakeCli(home, "#!/bin/sh\necho not-json\nexit 1\n");
    const runner = new ProviderCliValidationRunner({ home, verifyTarget: async () => true });
    await expect(
      runner.run(
        {
          expectedFingerprint: "v1:test",
          expectedIdentity: slackIdentity,
          expiresAt: new Date(Date.now() + 15_000).toISOString(),
          grant: { provider: "slack", botAccessToken: "xoxb-secret-token" },
          requestId: fence.requestId,
          targetPath: nonJson,
          version: "4.7.0",
        },
        fence,
      ),
    ).resolves.toMatchObject({ status: "needs_attention" });
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
      version: "4.7.0",
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
});
