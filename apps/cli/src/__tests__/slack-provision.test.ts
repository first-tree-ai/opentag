import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ProviderCliManager, renderProviderCliTurnLauncher } from "@opentag/client";
import { SLACK_SUBSCRIBED_BOT_EVENTS } from "@opentag/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runSlackAgentProvision } from "../core/agent/slack-provision.js";
import {
  captureSlackDeploy,
  prepareSlackCallbackUpdate,
  runSlackManagement,
  slackManagementHome,
} from "../core/slack-management.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function directory() {
  const path = await mkdtemp(join(tmpdir(), "slack-provision-"));
  dirs.push(path);
  return path;
}

describe("Slack provisioning CLI", () => {
  it("prepares the exact callback update while preserving unrelated remote configuration", async () => {
    const home = await directory();
    const environment = { OPENTAG_HOME: home };
    const root = slackManagementHome(environment);
    await mkdir(root);
    const remote = {
      display_information: { name: "Existing App" },
      features: { bot_user: { display_name: "existing-name" } },
      oauth_config: { redirect_urls: ["https://example.com/oauth"], scopes: { bot: ["chat:write"] } },
      settings: {
        socket_mode_enabled: false,
        event_subscriptions: {
          request_url: "https://old.example/events",
          bot_events: ["reaction_added"],
          user_events: ["team_join"],
        },
        interactivity: { is_enabled: false, message_menu_options_url: "https://example.com/options" },
      },
    };
    const provision = {
      ok: true,
      result: {
        agent: { id: randomUUID(), name: "helper" },
        interactionsUrl: "https://server.example/interactions",
        slack: {
          allowedIntent: "reauthorize",
          eventsUrl: "https://server.example/agent/events",
          binding: {
            credentialGeneration: "[REDACTED]",
            identity: {
              provider: "slack",
              appId: "A1",
              teamId: "T1",
              enterpriseId: null,
              botUserId: "U1",
              appIdEvidence: "configured",
            },
          },
        },
      },
    };
    await writeFile(join(root, "remote.json"), `Slack CLI response\n${JSON.stringify({ ok: true, manifest: remote })}`);
    await writeFile(join(root, "provision.json"), JSON.stringify(provision));
    const options = {
      environment,
      manifestFile: "remote.json",
      provisionResultFile: "provision.json",
      outputFile: "update.json",
    };
    await prepareSlackCallbackUpdate(options);
    const request = JSON.parse(await readFile(join(root, "update.json"), "utf8"));
    expect(request.app_id).toBe("A1");
    expect(JSON.parse(request.manifest)).toEqual({
      ...remote,
      settings: {
        ...remote.settings,
        event_subscriptions: {
          ...remote.settings.event_subscriptions,
          request_url: provision.result.slack.eventsUrl,
          bot_events: [...SLACK_SUBSCRIBED_BOT_EVENTS],
        },
        interactivity: {
          ...remote.settings.interactivity,
          is_enabled: true,
          request_url: provision.result.interactionsUrl,
        },
      },
    });
    expect((await stat(join(root, "update.json"))).mode & 0o777).toBe(0o600);
    await writeFile(join(root, "provision.json"), JSON.stringify({ ok: false, error: "failed" }));
    await expect(prepareSlackCallbackUpdate({ ...options, outputFile: "failed.json" })).rejects.toThrow();
    await expect(stat(join(root, "failed.json"))).rejects.toThrow();
    await expect(prepareSlackCallbackUpdate({ ...options, provisionResultFile: "../outside.json" })).rejects.toThrow(
      "private management directory",
    );
  });

  it("prepares the remote Account link locally, then makes exactly one proof-authenticated request without Account login", async () => {
    const home = await directory();
    const agent = {
      creationIntentId: randomUUID(),
      name: "helper",
      displayName: "Helper",
      runtimeProvider: "codex",
    };
    const slack = {
      appId: "A1",
      teamId: "T1",
      botUserId: "U1",
      botAccessToken: "xoxb-test",
      signingSecret: "secret-test",
    };
    const requestFile = join(home, "agent.json"),
      credentialsFile = join(home, "credentials.json"),
      codeFile = join(home, "code");
    await writeFile(requestFile, JSON.stringify(agent));
    await writeFile(credentialsFile, JSON.stringify(slack));
    const api = { provisionSlackAgent: vi.fn().mockResolvedValue({ agent: { id: "created" } }) };
    const runtime = { api, proof: "proof", serverUrl: "https://dev.opentag.build" };
    const prepared = await runSlackAgentProvision({ requestFile, credentialsFile, runtime });
    expect(prepared).toEqual({
      confirmationUrl: "https://dev.opentag.build/account?slackProvision=true",
      agentName: "Helper",
      appId: "A1",
      teamId: "T1",
    });
    expect(JSON.stringify(prepared)).not.toContain(slack.botAccessToken);
    expect(api.provisionSlackAgent).not.toHaveBeenCalled();
    for (const override of [
      { computerId: randomUUID() },
      { runtimeConfig: { permissions: { approvalPolicy: "never", allowCommands: ["sh"] } } },
      { runtimeConfig: { maxDurationMs: 86_400_000 } },
    ]) {
      await writeFile(requestFile, JSON.stringify({ ...agent, ...override }));
      await expect(runSlackAgentProvision({ requestFile, credentialsFile, runtime })).rejects.toThrow();
    }
    expect(api.provisionSlackAgent).not.toHaveBeenCalled();
    await writeFile(requestFile, JSON.stringify(agent));
    await writeFile(codeFile, "slack-provision.one-time-test-code\n");
    await runSlackAgentProvision({ requestFile, credentialsFile, codeFile, runtime });
    expect(api.provisionSlackAgent).toHaveBeenCalledExactlyOnceWith("proof", {
      agent,
      slack,
      code: "slack-provision.one-time-test-code",
    });
    await writeFile(codeFile, "ordinary-account-login-code");
    await expect(runSlackAgentProvision({ requestFile, credentialsFile, codeFile, runtime })).rejects.toThrow();
    expect(api.provisionSlackAgent).toHaveBeenCalledTimes(1);
  });

  it("keeps native Slack management separate from the messaging proxy and saves create responses privately", async () => {
    const home = await directory();
    const nativeBin = join(home, "native"),
      turnBin = join(home, "turn");
    await mkdir(nativeBin);
    await mkdir(turnBin);
    const binary = join(nativeBin, "slack");
    await writeFile(
      binary,
      '#!/usr/bin/env node\nimport {statSync,writeFileSync} from "node:fs";import {join} from "node:path";const args=process.argv.slice(2);if(args.includes("version")){console.log("Using slack v4.10.0");process.exit(0);}if(args.includes("--help")||args.includes("-h")){console.log("Usage: slack api");process.exit(0);}const config=args[args.indexOf("--config-dir")+1];if(args.includes("auth")){if(!statSync(config).isDirectory())process.exit(1);writeFileSync(join(config,"credentials.json"),JSON.stringify({T1:{team_id:"T1",token:"refreshed-management-token"}}));process.exit(0);}process.stdout.write(JSON.stringify({ok:!args.includes("fail"),args,token:process.env.SLACK_BOT_TOKEN,userToken:process.env.SLACK_USER_TOKEN,proxy:process.env.HTTPS_PROXY,ca:process.env.NODE_EXTRA_CA_CERTS,autoApproval:process.env.SLACK_AUTO_REQUEST_AAA,cwd:process.cwd()}));\n',
      { mode: 0o700 },
    );
    const environment = {
      ...process.env,
      OPENTAG_HOME: home,
      SLACK_BOT_TOKEN: "messaging-handle",
      SLACK_CONFIG_DIR: "proxy-config",
      SLACK_AUTO_REQUEST_AAA: "untrusted-inherited-value",
      HTTPS_PROXY: "http://proxy.invalid",
      NODE_EXTRA_CA_CERTS: "proxy-ca",
      PATH: `${nativeBin}:${dirname(process.execPath)}`,
    };
    const selected = await new ProviderCliManager({ accountHome: home, env: environment }).ensure("slack", {
      pathUpdate: false,
    });
    expect(selected.readiness).toBe("ready");
    const turnRunner = join(home, "turn-runner.mjs");
    await writeFile(turnRunner, 'throw new Error("Turn messaging launcher must not handle management commands");\n');
    await writeFile(
      join(turnBin, "slack"),
      renderProviderCliTurnLauncher({
        provider: "slack",
        runId: randomUUID(),
        planPath: join(home, "plan.json"),
        runnerInvocation: [process.execPath, turnRunner],
      }),
      { mode: 0o700 },
    );
    environment.PATH = `${turnBin}:${environment.PATH}`;
    for (const flag of ["--help", "-h"]) {
      expect(await runSlackManagement(["api", flag], { binary, environment })).toBe(0);
      await expect(stat(join(slackManagementHome(environment), "config", "credentials.json"))).rejects.toThrow();
    }
    expect(
      await runSlackManagement(["api", "apps.manifest.create"], {
        accountHome: home,
        environment,
        team: "T1",
        outputFile: "created.json",
        nonInteractive: true,
      }),
    ).toBe(0);
    const root = slackManagementHome(environment);
    const result = JSON.parse(await readFile(join(root, "created.json"), "utf8"));
    expect(result.args).toEqual([
      "--apihost",
      "https://slack.com",
      "--skip-update",
      "--no-color",
      "--config-dir",
      join(root, "config"),
      "--team",
      "T1",
      "api",
      "apps.manifest.create",
    ]);
    expect(result.userToken).toBe("refreshed-management-token");
    expect(result).not.toHaveProperty("token");
    expect(result).not.toHaveProperty("proxy");
    expect(result).not.toHaveProperty("ca");
    expect(result).not.toHaveProperty("autoApproval");
    expect(
      await runSlackManagement(["app", "link", "--team", "T1", "--app", "A1", "--environment", "deployed"], {
        binary,
        environment,
        nonInteractive: true,
        signal: new AbortController().signal,
        outputFile: "linked.json",
      }),
    ).toBe(0);
    const linked = JSON.parse(await readFile(join(root, "linked.json"), "utf8"));
    expect(linked.args).not.toContain("--no-prompt");
    expect(linked.args.slice(-8)).toEqual(["app", "link", "--team", "T1", "--app", "A1", "--environment", "deployed"]);
    expect(
      await runSlackManagement(["platform", "deploy", "--team", "T1", "--app", "A1"], {
        binary,
        environment,
        nonInteractive: true,
        requestAppApproval: true,
        signal: new AbortController().signal,
        outputFile: "deployed.json",
      }),
    ).toBe(0);
    expect(JSON.parse(await readFile(join(root, "deployed.json"), "utf8")).autoApproval).toBe("true");
    expect((await stat(join(root, "created.json"))).mode & 0o777).toBe(0o600);
    expect((await stat(root)).mode & 0o777).toBe(0o700);
    expect((await stat(join(root, "config"))).mode & 0o777).toBe(0o700);
    expect(slackManagementHome({ HOME: "/tmp/turn-one", OPENTAG_SESSION_SERVER_URL: "https://server.example" })).toBe(
      slackManagementHome({ HOME: "/tmp/turn-two", OPENTAG_SESSION_SERVER_URL: "https://server.example" }),
    );
    await expect(runSlackManagement(["api", "apps.manifest.create"], { binary, environment })).rejects.toThrow(
      "--output-file",
    );
    await expect(
      runSlackManagement(["api", "fail"], { binary, environment, team: "T1", outputFile: "failed-api.json" }),
    ).rejects.toThrow("ok=false");
    await expect(
      runSlackManagement(["login", "--apihost=https://other.example"], { binary, environment }),
    ).rejects.toThrow("do not override");
    await expect(runSlackManagement(["version"], { binary, environment, outputFile: "../outside" })).rejects.toThrow(
      "private management directory",
    );
  });

  it("captures full deploy credentials with a verified Bot identity and no public credential result", async () => {
    const home = await directory();
    const environment = { OPENTAG_HOME: home, SLACK_BOT_TOKEN: "xoxb-deploy-token" };
    const root = slackManagementHome(environment);
    const { mkdir } = await import("node:fs/promises");
    await mkdir(root, { recursive: true });
    await writeFile(
      join(root, "created.json"),
      "Slack CLI response\n" +
        JSON.stringify({ ok: true, app_id: "A1", credentials: { signing_secret: "created-signing-secret" } }),
    );
    const fetchImpl = vi.fn(async () =>
      Response.json({ ok: true, team_id: "T1", user_id: "U1", bot_id: "B1", app_id: "A1" }),
    ) as unknown as typeof fetch;
    expect(
      await captureSlackDeploy({
        createResponseFile: "created.json",
        outputFile: "credentials.json",
        environment,
        fetchImpl,
      }),
    ).toBeUndefined();
    expect(JSON.parse(await readFile(join(root, "credentials.json"), "utf8"))).toEqual({
      appId: "A1",
      teamId: "T1",
      botUserId: "U1",
      botAccessToken: "xoxb-deploy-token",
      signingSecret: "created-signing-secret",
    });
    expect((await stat(join(root, "credentials.json"))).mode & 0o777).toBe(0o600);
    const badFetch = vi.fn(async () => Response.json({ ok: false, error: "invalid_auth" })) as unknown as typeof fetch;
    await expect(
      captureSlackDeploy({
        createResponseFile: "created.json",
        outputFile: "failed.json",
        environment,
        fetchImpl: badFetch,
      }),
    ).rejects.toThrow("Bot identity");
    await expect(stat(join(root, "failed.json"))).rejects.toThrow();
  });
});
