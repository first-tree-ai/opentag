import { execFile } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { DirectImMessageDeliveryRequest, RuntimeImCredentialGrantRequest } from "@opentag/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

// Real child-process credential cases need headroom under parallel CI load.
vi.setConfig({ testTimeout: 30_000 });

import { completionForError } from "../runtime/agent-turn-runner.js";
import { ImCredentialEnvironmentManager, serializeEnvironment } from "../runtime/im-credential-environment-manager.js";
import type { RuntimeBusinessFrame } from "../runtime/runtime-connection.js";
import { generateExecutionCa } from "../runtime/runtime-proxy-loopback-adapter.js";
import { makeTurnPlanHarness, writeExternalTurnSelection } from "./fixtures/provider-cli-turn-plan.js";

const homes: string[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe("ImCredentialEnvironmentManager", () => {
  it.each(["feishu", "slack"] as const)(
    "loads %s credentials through the real Turn launcher without sourcing a file",
    async (provider) => {
      const harness = await makeTurnPlanHarness();
      homes.push(harness.accountHome, harness.openTagHome);
      const target = join(harness.accountHome, provider === "feishu" ? "lark-cli" : "slack");
      const token = provider === "feishu" ? "$LARKSUITE_CLI_TENANT_ACCESS_TOKEN" : "$SLACK_BOT_TOKEN";
      const unwanted = provider === "feishu" ? "$LARKSUITE_CLI_USER_ACCESS_TOKEN" : "$SLACK_USER_TOKEN$SLACK_APP_TOKEN";
      await writeFile(
        target,
        `#!/bin/sh\n[ "${token}" = "fixture-token" ] && [ -z "${unwanted}" ] || exit 2\nprintf 'reply recorded\\n'\n`,
        { mode: 0o700 },
      );
      await writeExternalTurnSelection(harness.layout, provider, await realpath(target));
      const manager = new ImCredentialEnvironmentManager({
        connection: grantConnection((request) => ({
          type: "im:credential:result",
          requestId: request.requestId,
          status: "succeeded",
          credentialGeneration: 1,
          grant:
            provider === "feishu"
              ? { provider, appId: "fixture-app", appSecret: "fixture-secret", teamBrand: "feishu" }
              : { provider, botAccessToken: "fixture-token" },
        })),
        home: harness.openTagHome,
        exchangeFeishuToken: async () => "fixture-token",
        platform: "linux",
      });
      try {
        const credentials = await manager.prepare(delivery("direct"));
        expect((await stat(credentials.environmentManifest)).mode & 0o777).toBe(0o600);
        const plan = await harness.manager.prepare({
          provider,
          sessionId: "session-1",
          runId: "run-1",
          environmentManifest: credentials.environmentManifest,
          ...(credentials.slackConfigDir ? { configDir: credentials.slackConfigDir } : {}),
        });
        const argv =
          provider === "feishu"
            ? ["im", "+messages-reply", "--message-id", "om_fixture", "--text", "hello", "--as", "bot"]
            : ["api", "chat.postMessage", "--json", '{"channel":"C1","text":"hello"}'];
        const result = await execFileAsync(plan.launcherPath, argv, {
          env: {
            PATH: process.env.PATH,
            LARKSUITE_CLI_USER_ACCESS_TOKEN: "ambient-user",
            SLACK_USER_TOKEN: "ambient-user",
            SLACK_APP_TOKEN: "ambient-app",
          },
        });
        expect(result.stdout.trim()).toBe("reply recorded");
        await manager.cleanup("session-1");
        await expect(stat(credentials.environmentManifest)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        await manager.close();
      }
    },
  );

  it.each(["direct", "ambient"] as const)(
    "projects and removes the Slack Bot token for a %s Turn without attention-based authorization",
    async (attention) => {
      const home = await temporaryHome();
      const connection = grantConnection((request) => ({
        type: "im:credential:result",
        requestId: request.requestId,
        status: "succeeded",
        credentialGeneration: 1,
        grant: { provider: "slack", botAccessToken: `xoxb-${attention}` },
      }));
      const manager = new ImCredentialEnvironmentManager({ connection, home, platform: "linux" });
      const request = delivery(attention);

      const prepared = await manager.prepare(request);
      const { path } = prepared;
      const configDir = prepared.slackConfigDir;
      if (!configDir) throw new Error("Slack prepare must return its private config leaf");
      expect(prepared.slackConfigDir).toBe(configDir);
      expect(manager.activeSlackConfigDirForSession(request.sessionId)).toBe(configDir);
      expect(await readFile(path, "utf8")).toBe(
        `export SLACK_BOT_TOKEN='xoxb-${attention}'\nunset SLACK_USER_TOKEN\nunset SLACK_APP_TOKEN\nexport OPENTAG_SLACK_CONFIG_DIR='${configDir}'\nexport OPENTAG_SLACK_DOWNLOAD_CONFIG='${join(configDir, "download.curl")}'\nexport SLACK_CONFIG_DIR='${configDir}'\n`,
      );
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect((await stat(configDir)).mode & 0o777).toBe(0o700);
      expect(await readFile(path, "utf8")).not.toMatch(/xoxp-|xapp-/);
      expect(connection.requests).toEqual([
        expect.objectContaining({
          sessionId: request.sessionId,
          agentId: request.agentId,
          placementGeneration: request.placementGeneration,
        }),
      ]);
      expect(connection.requests[0]).not.toHaveProperty("attention");
      expect(connection.requests[0]).not.toHaveProperty("provider");

      await manager.cleanup(request.sessionId);
      expect(manager.activeSlackConfigDirForSession(request.sessionId)).toBeUndefined();
      await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(configDir)).rejects.toMatchObject({ code: "ENOENT" });
      await manager.close();
    },
  );

  it("downloads original bytes with a private rotating curl config and no token in argv/output", async () => {
    const home = await temporaryHome();
    const ca = await generateExecutionCa(home);
    const bytes = Buffer.from([0, 255, 128, 10, 13, 34, 92]);
    const requests: Array<{ url: string | undefined; authorization: string | undefined }> = [];
    const server = createServer(
      { key: await readFile(ca.keyPath), cert: await readFile(ca.certPath) },
      (request, response) => {
        requests.push({ url: request.url, authorization: request.headers.authorization });
        if (request.url === "/redirect") {
          response.writeHead(302, { location: "/unexpected" }).end();
        } else response.end(bytes);
      },
    );
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture address");
    const token = 'fixture-"quoted\\token';
    let generation = 0;
    const manager = new ImCredentialEnvironmentManager({
      connection: grantConnection((request) => ({
        type: "im:credential:result",
        requestId: request.requestId,
        status: "succeeded",
        credentialGeneration: ++generation,
        grant: { provider: "slack", botAccessToken: `${token}-${generation}` },
      })),
      home,
      platform: "linux",
    });
    try {
      const prepared = await manager.prepare(delivery("direct"));
      const config = join(prepared.slackConfigDir ?? "", "download.curl");
      expect((await stat(config)).mode & 0o777).toBe(0o600);
      const output = join(home, "original.bin");
      const args = [
        "--disable",
        "--config",
        config,
        "--fail",
        "--silent",
        "--show-error",
        "--cacert",
        ca.certPath,
        "--output",
        output,
      ];
      const routing = ["--noproxy", "*", "--resolve", `slack.com:${address.port}:127.0.0.1`];
      for (const expectedGeneration of [1, 2]) {
        if (expectedGeneration === 2) await manager.prepare(delivery("direct"));
        const result = await execFileAsync("curl", [...args, ...routing, `https://slack.com:${address.port}/download`]);
        expect(result.stdout + result.stderr).toBe("");
        expect(args.join(" ")).not.toContain(token);
        expect(requests.at(-1)?.authorization).toBe(`Bearer ${token}-${expectedGeneration}`);
        expect(await readFile(output)).toEqual(bytes);
      }
      await execFileAsync("curl", [...args, ...routing, `https://slack.com:${address.port}/redirect`]);
      expect(requests.map((request) => request.url)).toEqual(["/download", "/download", "/redirect"]);
      await expect(
        execFileAsync("curl", [...args, ...routing, `http://slack.com:${address.port}/download`]),
      ).rejects.toMatchObject({ code: 1 });
      expect(requests).toHaveLength(3);
      await manager.cleanup("session-1");
      await expect(stat(config)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await manager.close();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it.each(["fixture\ninjected", "fixture\rinjected", "fixture\0injected"])(
    "rejects control characters in Slack download authentication without retaining partial files",
    async (botAccessToken) => {
      const home = await temporaryHome();
      const manager = new ImCredentialEnvironmentManager({
        connection: grantConnection((request) => ({
          type: "im:credential:result",
          requestId: request.requestId,
          status: "succeeded",
          credentialGeneration: 1,
          grant: { provider: "slack", botAccessToken },
        })),
        home,
        platform: "linux",
      });
      await expect(manager.prepare(delivery("direct"))).rejects.toMatchObject({ code: "invalid_slack_token" });
      await expect(stat(join(home, "data/runtime/provider-credentials/session-1-slack-config"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await manager.close();
    },
  );

  it("atomically replaces rotated Feishu credentials and removes the config projection on close", async () => {
    const home = await temporaryHome();
    let generation = 0;
    const connection = grantConnection((request) => {
      generation += 1;
      return {
        type: "im:credential:result",
        requestId: request.requestId,
        status: "succeeded",
        credentialGeneration: generation,
        grant: {
          provider: "feishu",
          appId: "cli-app",
          appSecret: `secret-${generation}`,
          teamBrand: "feishu",
        },
      };
    });
    const exchangeFeishuToken = vi.fn(async (grant: { appSecret: string }) => `tenant-${grant.appSecret}`);
    const manager = new ImCredentialEnvironmentManager({
      connection,
      exchangeFeishuToken: exchangeFeishuToken as never,
      home,
      platform: "linux",
    });

    const prepared = await manager.prepare(delivery("ambient"));
    const { path } = prepared;
    expect(prepared.slackConfigDir).toBeUndefined();
    expect(manager.activeSlackConfigDirForSession("session-1")).toBeUndefined();
    expect(await readFile(path, "utf8")).toContain("export LARKSUITE_CLI_APP_SECRET='secret-1'");
    await manager.prepare(delivery("ambient"));
    const rotated = await readFile(path, "utf8");
    expect(rotated).toContain("export LARKSUITE_CLI_APP_SECRET='secret-2'");
    expect(rotated).toContain("export LARKSUITE_CLI_TENANT_ACCESS_TOKEN='tenant-secret-2'");
    expect(rotated).toContain("unset LARKSUITE_CLI_USER_ACCESS_TOKEN");
    expect(rotated).not.toContain("secret-1");

    await manager.close();
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("lets an ambient Turn invoke a fake official Slack CLI with only the temporary environment file", async () => {
    const home = await temporaryHome();
    const fakeSlack = join(home, "slack");
    await writeFile(fakeSlack, '#!/bin/sh\nprintf "%s|%s\\n" "$SLACK_BOT_TOKEN" "$*"\n', "utf8");
    await chmod(fakeSlack, 0o700);
    const connection = grantConnection((request) => ({
      type: "im:credential:result",
      requestId: request.requestId,
      status: "succeeded",
      credentialGeneration: 1,
      grant: { provider: "slack", botAccessToken: "xoxb-ambient-cli" },
    }));
    const manager = new ImCredentialEnvironmentManager({ connection, home, platform: "linux" });
    const { path: environmentPath } = await manager.prepare(delivery("ambient"));

    const result = await execFileAsync(
      "/bin/sh",
      ["-c", '. "$OPENTAG_PROVIDER_ENV_FILE"; "$FAKE_SLACK" api chat.postMessage --data @blocks.json'],
      {
        env: {
          OPENTAG_PROVIDER_ENV_FILE: environmentPath,
          FAKE_SLACK: fakeSlack,
        },
      },
    );
    expect(result.stdout.trim()).toBe("xoxb-ambient-cli|api chat.postMessage --data @blocks.json");
    await manager.close();
  });

  it("lets a direct Turn pass native Feishu message operations to a fake official CLI", async () => {
    const home = await temporaryHome();
    const fakeLark = join(home, "lark-cli");
    await writeFile(
      fakeLark,
      '#!/bin/sh\nprintf "%s|%s|%s\\n" "$LARKSUITE_CLI_APP_ID" "$LARKSUITE_CLI_TENANT_ACCESS_TOKEN" "$*"\n',
      "utf8",
    );
    await chmod(fakeLark, 0o700);
    const connection = grantConnection((request) => ({
      type: "im:credential:result",
      requestId: request.requestId,
      status: "succeeded",
      credentialGeneration: 1,
      grant: { provider: "feishu", appId: "cli-direct", appSecret: "app-secret", teamBrand: "feishu" },
    }));
    const manager = new ImCredentialEnvironmentManager({
      connection,
      exchangeFeishuToken: async () => "tenant-direct",
      home,
      platform: "linux",
    });
    const { path: environmentPath } = await manager.prepare(delivery("direct"));

    const result = await execFileAsync(
      "/bin/sh",
      [
        "-c",
        '. "$OPENTAG_PROVIDER_ENV_FILE"; "$FAKE_LARK" im message send --card @card.json; "$FAKE_LARK" im message reply --message-id message-1 --file @report.pdf; "$FAKE_LARK" im reaction create --message-id message-1 --emoji THUMBSUP',
      ],
      { env: { OPENTAG_PROVIDER_ENV_FILE: environmentPath, FAKE_LARK: fakeLark } },
    );
    expect(result.stdout.trim().split("\n")).toEqual([
      "cli-direct|tenant-direct|im message send --card @card.json",
      "cli-direct|tenant-direct|im message reply --message-id message-1 --file @report.pdf",
      "cli-direct|tenant-direct|im reaction create --message-id message-1 --emoji THUMBSUP",
    ]);
    await manager.close();
  });

  it("removes partial Feishu projections when tenant token exchange fails", async () => {
    const home = await temporaryHome();
    const connection = grantConnection((request) => ({
      type: "im:credential:result",
      requestId: request.requestId,
      status: "succeeded",
      credentialGeneration: 1,
      grant: { provider: "feishu", appId: "cli-failed", appSecret: "secret", teamBrand: "feishu" },
    }));
    const manager = new ImCredentialEnvironmentManager({
      connection,
      exchangeFeishuToken: async () => {
        throw new Error("exchange failed");
      },
      home,
      platform: "linux",
    });
    const request = delivery("direct");

    await expect(manager.prepare(request)).rejects.toMatchObject({
      name: "ImCredentialEnvironmentError",
      code: "credential_materialization_failed",
    });
    await expect(stat(manager.pathForSession(request.sessionId))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      stat(join(home, "data", "runtime", "provider-credentials", `${request.sessionId}-lark-config`)),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await manager.close();
  });

  it("retains failed cleanup work and retries it during Client shutdown", async () => {
    const home = await temporaryHome();
    let failedOnce = false;
    const manager = new ImCredentialEnvironmentManager({
      connection: grantConnection((request) => ({
        type: "im:credential:result",
        requestId: request.requestId,
        status: "succeeded",
        credentialGeneration: 1,
        grant: { provider: "slack", botAccessToken: "xoxb-cleanup" },
      })),
      home,
      platform: "linux",
      removePath: async (path, options) => {
        if (path.endsWith("session-1.sh") && !failedOnce) {
          failedOnce = true;
          throw new Error("simulated unlink failure");
        }
        await rm(path, options);
      },
    });
    const { path } = await manager.prepare(delivery("direct"));

    await expect(manager.cleanup("session-1")).rejects.toMatchObject({ code: "cleanup_failed" });
    await expect(stat(path)).resolves.toBeDefined();
    await manager.close();
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses traversal identities before recursive credential cleanup", async () => {
    const home = await temporaryHome();
    const removed: string[] = [];
    const manager = new ImCredentialEnvironmentManager({
      connection: grantConnection(() => {
        throw new Error("No grant expected");
      }),
      home,
      platform: "linux",
      removePath: async (path) => {
        removed.push(path);
      },
    });

    await expect(manager.cleanup("../../outside")).rejects.toThrow("escaped its root");
    expect(removed).toEqual([]);
    await manager.close();
  });

  it("removes only strictly named stale credential artifacts before preparing a new Turn", async () => {
    const home = await temporaryHome();
    const root = join(home, "data", "runtime", "provider-credentials");
    const staleSession = "123e4567-e89b-42d3-a456-426614174000";
    const staleTemporary = ".123e4567-e89b-42d3-a456-426614174001.tmp";
    await mkdir(join(root, `${staleSession}-lark-config`), { recursive: true });
    await mkdir(join(root, `${staleSession}-slack-config`), { recursive: true });
    await writeFile(join(root, `${staleSession}.sh`), "secret", "utf8");
    await writeFile(join(root, `${staleSession}.json`), "secret manifest", "utf8");
    await writeFile(join(root, staleTemporary), "temporary secret", "utf8");
    await writeFile(join(root, "keep-me.txt"), "not managed", "utf8");
    await writeFile(join(root, "keep-me.tmp"), "not managed", "utf8");
    const manager = new ImCredentialEnvironmentManager({
      connection: grantConnection((request) => ({
        type: "im:credential:result",
        requestId: request.requestId,
        status: "succeeded",
        credentialGeneration: 1,
        grant: { provider: "slack", botAccessToken: "xoxb-new" },
      })),
      home,
      platform: "linux",
    });

    await manager.prepare(delivery("direct"));
    await expect(stat(join(root, `${staleSession}.sh`))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(root, `${staleSession}.json`))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(root, `${staleSession}-lark-config`))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(root, `${staleSession}-slack-config`))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(root, staleTemporary))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(root, "keep-me.txt"), "utf8")).resolves.toBe("not managed");
    await expect(readFile(join(root, "keep-me.tmp"), "utf8")).resolves.toBe("not managed");
    await manager.close();
  });

  it.each([
    ["network rejection", () => Promise.reject(new Error("network down"))],
    ["invalid JSON response", () => Promise.resolve({ ok: true, json: () => Promise.reject(new SyntaxError()) })],
  ])("normalizes Feishu token exchange %s before Provider execution", async (_label, fetchResult) => {
    const home = await temporaryHome();
    vi.stubGlobal("fetch", vi.fn(fetchResult));
    const manager = new ImCredentialEnvironmentManager({
      connection: grantConnection((request) => ({
        type: "im:credential:result",
        requestId: request.requestId,
        status: "succeeded",
        credentialGeneration: 1,
        grant: { provider: "feishu", appId: "cli-app", appSecret: "secret", teamBrand: "feishu" },
      })),
      home,
      platform: "linux",
    });

    const failure = await manager.prepare(delivery("direct")).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      name: "ImCredentialEnvironmentError",
      code: "credential_materialization_failed",
    });
    expect(completionForError(failure, undefined)).toEqual({
      outcome: "failed",
      executionEffects: "not_started",
      errorReason: "credential_unavailable",
    });
    await manager.close();
  });

  it("normalizes credential file write failures before Provider execution", async () => {
    const home = await temporaryHome();
    const manager = new ImCredentialEnvironmentManager({
      connection: grantConnection((request) => ({
        type: "im:credential:result",
        requestId: request.requestId,
        status: "succeeded",
        credentialGeneration: 1,
        grant: { provider: "slack", botAccessToken: "xoxb-write" },
      })),
      home,
      platform: "linux",
      writeEnvironmentFile: async () => {
        throw new Error("disk full");
      },
    });

    const request = delivery("direct");
    const failure = await manager.prepare(request).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      name: "ImCredentialEnvironmentError",
      code: "credential_materialization_failed",
    });
    expect(completionForError(failure, undefined)).toEqual({
      outcome: "failed",
      executionEffects: "not_started",
      errorReason: "credential_unavailable",
    });
    expect(manager.activeSlackConfigDirForSession(request.sessionId)).toBeUndefined();
    await manager.close();
  });

  it("preserves abort as a typed pre-execution failure", async () => {
    const home = await temporaryHome();
    const manager = new ImCredentialEnvironmentManager({
      connection: grantConnection((request) => ({
        type: "im:credential:result",
        requestId: request.requestId,
        status: "succeeded",
        credentialGeneration: 1,
        grant: { provider: "slack", botAccessToken: "xoxb-abort" },
      })),
      home,
      platform: "linux",
    });
    const abort = new AbortController();
    abort.abort("cancelled");

    const failure = await manager.prepare(delivery("direct"), abort.signal).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      name: "ImCredentialEnvironmentError",
      code: "aborted",
    });
    expect(completionForError(failure, undefined)).toEqual({
      outcome: "failed",
      executionEffects: "not_started",
      errorReason: "credential_unavailable",
    });
    await manager.close();
  });

  it("escapes POSIX and PowerShell values without evaluating provider secrets", () => {
    expect(serializeEnvironment({ TOKEN: "a'b", OLD: undefined }, "linux")).toBe(`export TOKEN='a'"'"'b'\nunset OLD\n`);
    expect(serializeEnvironment({ TOKEN: "a'b", OLD: undefined }, "win32")).toBe(
      `$env:TOKEN = 'a''b'\nRemove-Item Env:OLD -ErrorAction SilentlyContinue\n`,
    );
  });
});

async function temporaryHome(): Promise<string> {
  // Temp roots are symlinked on macOS, so canonicalize to match the paths the code under test resolves.
  const home = await realpath(await mkdtemp(join(tmpdir(), "opentag-im-credentials-")));
  homes.push(home);
  return home;
}

function grantConnection(result: (request: RuntimeImCredentialGrantRequest) => RuntimeBusinessFrame): {
  requests: RuntimeImCredentialGrantRequest[];
  send(frame: RuntimeImCredentialGrantRequest): Promise<void>;
  subscribeBusinessFrames(listener: (frame: RuntimeBusinessFrame) => void): () => void;
} {
  let listener: ((frame: RuntimeBusinessFrame) => void) | undefined;
  const requests: RuntimeImCredentialGrantRequest[] = [];
  return {
    requests,
    async send(frame) {
      requests.push(frame);
      queueMicrotask(() => listener?.(result(frame)));
    },
    subscribeBusinessFrames(next) {
      listener = next;
      return () => {
        listener = undefined;
      };
    },
  };
}

function delivery(attention: "direct" | "ambient"): DirectImMessageDeliveryRequest {
  return {
    type: "im:deliver",
    requestId: crypto.randomUUID(),
    deliveryId: crypto.randomUUID(),
    imMessageId: crypto.randomUUID(),
    sessionId: "session-1",
    agentId: "agent-1",
    placementGeneration: 1,
    attention,
    content: {
      kind: "text",
      text: "hello",
      providerRef: {
        provider: "slack",
        appId: "app-1",
        teamId: "workspace-1",
        botUserId: "bot-1",
        channelId: "channel-1",
        messageTs: "1710000000.000001",
      },
    },
    runtime: {
      contextTrees: [],
      revision: {
        agent: { sequence: 1, id: "agent-revision-1" },
        session: { sequence: 1, id: "session-revision-1" },
      },
      agentId: "agent-1",
      provider: "codex",
      instructions: { platform: "platform", agent: "agent" },
      execution: { approvalPolicy: "never", networkAccess: true },
      workspace: { workspaceId: "workspace-1", mode: "empty_on_create", sharing: "agent" },
    },
  };
}
