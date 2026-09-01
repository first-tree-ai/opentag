import { chmod, mkdir, mkdtemp, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  classifySlackAuthTest,
  deriveProviderCliValidationRequestKey,
  exchangeFeishuTenantToken,
  extractBoundedJson,
  FeishuTokenExchangeError,
  ProviderCliValidationRunner,
} from "../index.js";
import { classifyLarkBotInfo, classifyLarkWhoami } from "../runtime/provider-cli/validation-classify.js";
import { validateFeishuBotIdentity } from "../runtime/provider-cli/validation-runner.js";

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
const feishuWhoami = {
  profile: "external",
  appId: "cli_app",
  brand: "feishu",
  defaultAs: "bot",
  identity: "bot",
  identitySource: "flag",
  available: true,
  tokenStatus: "ready",
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

  it("requires whoami to report the expected bot app, brand, availability, and ready token", () => {
    expect(classifyLarkWhoami(feishuWhoami, feishuIdentity)).toEqual({ status: "ready" });
    expect(classifyLarkWhoami({ ...feishuWhoami, appId: "cli_other" }, feishuIdentity)).toEqual({
      status: "needs_attention",
      reason: "identity_mismatch",
    });
    expect(classifyLarkWhoami({ ...feishuWhoami, brand: "lark" }, feishuIdentity)).toEqual({
      status: "needs_attention",
      reason: "identity_mismatch",
    });
    expect(classifyLarkWhoami({ ...feishuWhoami, available: false, tokenStatus: "missing" }, feishuIdentity)).toEqual({
      status: "needs_attention",
      reason: "credential_rejected",
    });
    expect(classifyLarkWhoami("not-json", feishuIdentity)).toEqual({ status: "needs_attention" });
    expect(classifyLarkWhoami({ error: "rate_limited" }, feishuIdentity)).toEqual({
      status: "retrying",
      reason: "rate_limited",
    });
    expect(classifyLarkWhoami({ error: "internal_error" }, feishuIdentity)).toEqual({
      status: "retrying",
      reason: "provider_unreachable",
    });
  });

  it("matches the live Feishu bot open ID independently of whoami", () => {
    expect(classifyLarkBotInfo({ code: 0, msg: "ok", bot: { open_id: "ou_bot" } }, feishuIdentity)).toEqual({
      status: "ready",
    });
    expect(classifyLarkBotInfo({ code: 0, msg: "ok", bot: { open_id: "ou_other" } }, feishuIdentity)).toEqual({
      status: "needs_attention",
      reason: "identity_mismatch",
    });
    expect(classifyLarkBotInfo({ code: 99991663, msg: "invalid token" }, feishuIdentity)).toEqual({
      status: "needs_attention",
      reason: "credential_rejected",
    });
  });

  it("extracts one bounded JSON envelope and rejects oversize input", () => {
    expect(extractBoundedJson('noise {"ok":true} trailing')).toEqual({ ok: true });
    expect(extractBoundedJson("not json")).toBeUndefined();
    expect(extractBoundedJson(`{"ok":true}`, 4)).toBeUndefined();
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
  it("validates external Feishu credentials with whoami and a separate live bot identity request", async () => {
    const home = await mkdtemp(join(tmpdir(), "opentag-validation-feishu-"));
    const execFile = vi.fn(async (_file, args, options) => {
      expect(args).toEqual(["whoami", "--as", "bot", "--json"]);
      expect(args[0]).not.toBe("auth");
      expect(options.env.LARKSUITE_CLI_APP_ID).toBe("cli_app");
      expect(options.env.LARKSUITE_CLI_APP_SECRET).toBe("secret");
      expect(options.env.LARKSUITE_CLI_BRAND).toBe("feishu");
      expect(options.env.LARKSUITE_CLI_TENANT_ACCESS_TOKEN).toBe("tenant-token");
      expect(options.env.LARKSUITE_CLI_USER_ACCESS_TOKEN).toBeUndefined();
      return { stdout: JSON.stringify(feishuWhoami), stderr: "" };
    });
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/open-apis/auth/v3/tenant_access_token/internal")) {
        expect(init?.method).toBe("POST");
        return new Response(JSON.stringify({ code: 0, tenant_access_token: "tenant-token" }));
      }
      expect(url).toBe("https://open.feishu.cn/open-apis/bot/v3/info");
      expect(init?.method).toBe("GET");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer tenant-token");
      return new Response(JSON.stringify({ code: 0, msg: "ok", bot: { open_id: "ou_bot" } }));
    }) as typeof fetch;
    const runner = new ProviderCliValidationRunner({
      home,
      execFile,
      fetch: fetchImpl,
      verifyTarget: async () => true,
    });

    await expect(runner.run(feishuValidationRequest(), feishuFence)).resolves.toEqual({
      ...feishuFence,
      status: "ready",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(await readdir(join(home, "data", "runtime", "provider-cli-validation"))).toEqual([]);
  });

  it.each([
    ["app", { ...feishuWhoami, appId: "cli_other" }, "identity_mismatch"],
    ["brand", { ...feishuWhoami, brand: "lark" }, "identity_mismatch"],
    ["identity", { ...feishuWhoami, identity: "user" }, "identity_mismatch"],
    ["availability", { ...feishuWhoami, available: false, tokenStatus: "missing" }, "credential_rejected"],
    ["token status", { ...feishuWhoami, tokenStatus: "expired" }, "credential_rejected"],
  ])("fails closed on the wrong Feishu whoami %s", async (_case, payload, reason) => {
    const fetchImpl = vi.fn();
    const runner = new ProviderCliValidationRunner({
      home: await mkdtemp(join(tmpdir(), "opentag-validation-feishu-whoami-")),
      exchangeFeishuToken: async () => "tenant-token",
      execFile: vi.fn(async () => ({ stdout: JSON.stringify(payload), stderr: "" })),
      fetch: fetchImpl,
      verifyTarget: async () => true,
    });
    await expect(runner.run(feishuValidationRequest(), feishuFence)).resolves.toMatchObject({
      status: "needs_attention",
      reason,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    [
      "token",
      new Response(JSON.stringify({ code: 99991663, msg: "invalid token" }), { status: 401 }),
      "credential_rejected",
    ],
    ["bot", new Response(JSON.stringify({ code: 0, msg: "ok", bot: { open_id: "ou_other" } })), "identity_mismatch"],
  ])("rejects a wrong Feishu %s after whoami succeeds", async (_case, response, reason) => {
    const fetchImpl = vi.fn(async () => response) as typeof fetch;
    const runner = new ProviderCliValidationRunner({
      home: await mkdtemp(join(tmpdir(), "opentag-validation-feishu-live-")),
      exchangeFeishuToken: async () => "tenant-token",
      execFile: vi.fn(async () => ({ stdout: JSON.stringify(feishuWhoami), stderr: "" })),
      fetch: fetchImpl,
      verifyTarget: async () => true,
    });
    await expect(runner.run(feishuValidationRequest(), feishuFence)).resolves.toMatchObject({
      status: "needs_attention",
      reason,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("bounds the live Feishu bot request with its own timeout", async () => {
    const hangingFetch = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
            once: true,
          });
        }),
    ) as typeof fetch;
    await expect(
      validateFeishuBotIdentity("tenant-token", feishuIdentity, undefined, hangingFetch, 5),
    ).resolves.toEqual({
      status: "retrying",
      reason: "provider_unreachable",
    });
  });

  it("cleans up the Feishu validation directory after a CLI timeout", async () => {
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
