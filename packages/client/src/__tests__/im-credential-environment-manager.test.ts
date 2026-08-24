import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { DirectImMessageDeliveryRequest, RuntimeImCredentialGrantRequest } from "@opentag/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { completionForError } from "../runtime/agent-turn-runner.js";
import { ImCredentialEnvironmentManager, serializeEnvironment } from "../runtime/im-credential-environment-manager.js";
import type { RuntimeBusinessFrame } from "../runtime/runtime-connection.js";

const homes: string[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe("ImCredentialEnvironmentManager", () => {
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

      const path = await manager.prepare(request);
      const configDir = join(home, "data", "runtime", "provider-credentials", `${request.sessionId}-slack-config`);
      expect(await readFile(path, "utf8")).toBe(
        `export SLACK_BOT_TOKEN='xoxb-${attention}'\nunset SLACK_USER_TOKEN\nunset SLACK_APP_TOKEN\nexport OPENTAG_SLACK_CONFIG_DIR='${configDir}'\n`,
      );
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect((await stat(configDir)).isDirectory()).toBe(true);
      expect((await stat(configDir)).mode & 0o777).toBe(0o700);
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
      await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(configDir)).rejects.toMatchObject({ code: "ENOENT" });
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

    const path = await manager.prepare(delivery("ambient"));
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
    const environmentPath = await manager.prepare(delivery("ambient"));

    const result = await execFileAsync(
      "/bin/sh",
      [
        "-c",
        '. "$OPENTAG_PROVIDER_ENV_FILE"; printf "%s\\n" "$SLACK_BOT_TOKEN|$OPENTAG_SLACK_CONFIG_DIR"; : > "$OPENTAG_SLACK_CONFIG_DIR/slack-debug.log"; "$FAKE_SLACK" api chat.postMessage --json "{}" --config-dir "$OPENTAG_SLACK_CONFIG_DIR"',
      ],
      {
        env: {
          OPENTAG_PROVIDER_ENV_FILE: environmentPath,
          FAKE_SLACK: fakeSlack,
        },
      },
    );
    const configDir = join(home, "data", "runtime", "provider-credentials", "session-1-slack-config");
    expect(result.stdout.trim().split("\n")).toEqual([
      `xoxb-ambient-cli|${configDir}`,
      `xoxb-ambient-cli|api chat.postMessage --json {} --config-dir ${configDir}`,
    ]);
    expect((await stat(join(configDir, "slack-debug.log"))).isFile()).toBe(true);
    await manager.close();
    await expect(stat(configDir)).rejects.toMatchObject({ code: "ENOENT" });
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
    const environmentPath = await manager.prepare({
      ...delivery("direct"),
      content: {
        kind: "text",
        text: "hello",
        providerRef: {
          provider: "feishu",
          teamBrand: "feishu",
          appId: "cli-direct",
          botOpenId: "bot-1",
          chatId: "chat-1",
          messageId: "message-1",
        },
      },
    });

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
    const path = await manager.prepare(delivery("direct"));
    const configDir = join(home, "data", "runtime", "provider-credentials", "session-1-slack-config");

    await expect(manager.cleanup("session-1")).rejects.toMatchObject({ code: "cleanup_failed" });
    await expect(stat(path)).resolves.toBeDefined();
    await manager.close();
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(configDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes only strictly named stale credential artifacts before preparing a new Turn", async () => {
    const home = await temporaryHome();
    const root = join(home, "data", "runtime", "provider-credentials");
    const staleSession = "123e4567-e89b-42d3-a456-426614174000";
    const staleTemporary = ".123e4567-e89b-42d3-a456-426614174001.tmp";
    await mkdir(join(root, `${staleSession}-lark-config`), { recursive: true });
    await mkdir(join(root, `${staleSession}-slack-config`, "logs"), { recursive: true });
    await writeFile(join(root, `${staleSession}-slack-config`, "credentials.json"), "secret", "utf8");
    await writeFile(join(root, `${staleSession}.sh`), "secret", "utf8");
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
    await expect(
      stat(join(home, "data", "runtime", "provider-credentials", "session-1-slack-config")),
    ).rejects.toMatchObject({ code: "ENOENT" });
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
  const home = await mkdtemp(join(tmpdir(), "opentag-im-credentials-"));
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
        teamId: "team-1",
        botUserId: "bot-1",
        channelId: "channel-1",
        messageTs: "1710000000.000001",
      },
    },
    runtime: {
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
