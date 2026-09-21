import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import https from "node:https";
import type { AddressInfo } from "node:net";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mergeEnvironmentManifest } from "../runtime/provider-cli/turn-runner.js";
import {
  type RuntimeProxyAdapterStreamRequest,
  RuntimeProxyLoopbackAdapter,
} from "../runtime/runtime-proxy-loopback-adapter.js";
import {
  buildRuntimeProxyEnvironment,
  providerRoutingEnvironment,
  RUNTIME_PROXY_PROVIDER_CA_KEY,
  RUNTIME_PROXY_PROVIDER_URL_KEY,
  renderRuntimeProxyGitConfig,
  renderRuntimeProxyGitCredentialHelper,
  renderRuntimeProxyProviderLauncher,
} from "../runtime/runtime-proxy-material.js";

const execFileAsync = promisify(execFile);

const GLOBAL_ROUTING_KEYS = [
  "ALL_PROXY",
  "CURL_CA_BUNDLE",
  "GIT_SSL_CAINFO",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "SSL_CERT_FILE",
  "all_proxy",
  "http_proxy",
  "https_proxy",
  "no_proxy",
] as const;

const roots: string[] = [];
const teardowns: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  await Promise.all(teardowns.splice(0).map((teardown) => teardown()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function listen(server: net.Server | https.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve((server.address() as AddressInfo).port);
    });
  });
}

async function closeServer(server: net.Server | https.Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    if (server instanceof https.Server) server.closeAllConnections();
  });
}

/** Real TLS fixture for `fixture.test` signed by a private CA; only this test's curl trusts it. */
async function createHttpsFixture(root: string): Promise<{
  caPath: string;
  hits: number;
  port: number;
  server: https.Server;
}> {
  const caKeyPath = join(root, "fixture-ca-key.pem");
  const caPath = join(root, "fixture-ca.pem");
  const serverKeyPath = join(root, "fixture-server-key.pem");
  const requestPath = join(root, "fixture-server.csr");
  const serverPath = join(root, "fixture-server.pem");
  const extensionPath = join(root, "fixture-server.cnf");
  await execFileAsync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "2",
      "-subj",
      "/CN=OpenTag test fixture CA",
      "-addext",
      "basicConstraints=critical,CA:TRUE",
      "-keyout",
      caKeyPath,
      "-out",
      caPath,
    ],
    { timeout: 30_000 },
  );
  await execFileAsync(
    "openssl",
    [
      "req",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-subj",
      "/CN=fixture.test",
      "-keyout",
      serverKeyPath,
      "-out",
      requestPath,
    ],
    { timeout: 30_000 },
  );
  await writeFile(extensionPath, "subjectAltName=DNS:fixture.test\nbasicConstraints=critical,CA:FALSE\n");
  await execFileAsync(
    "openssl",
    [
      "x509",
      "-req",
      "-in",
      requestPath,
      "-CA",
      caPath,
      "-CAkey",
      caKeyPath,
      "-CAcreateserial",
      "-days",
      "2",
      "-extfile",
      extensionPath,
      "-out",
      serverPath,
    ],
    { timeout: 30_000 },
  );
  const state = { caPath, hits: 0, port: 0 };
  const server = https.createServer(
    { key: await readFile(serverKeyPath), cert: await readFile(serverPath) },
    (_request, response) => {
      state.hits += 1;
      response.end("ok");
    },
  );
  state.port = await listen(server);
  return Object.assign(state, { server });
}

/** Minimal CONNECT proxy that records the first request line and refuses the tunnel. */
async function recordingConnectProxy(): Promise<{ close: () => Promise<void>; port: number; requestLines: string[] }> {
  const requestLines: string[] = [];
  const server = net.createServer((socket) => {
    socket.once("data", (chunk) => {
      requestLines.push(chunk.toString("utf8").split("\r\n", 1)[0] ?? "");
      socket.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n");
    });
    socket.on("error", () => undefined);
  });
  const port = await listen(server);
  return { close: () => closeServer(server), port, requestLines };
}

async function connectionRecordingServer(): Promise<{ close: () => Promise<void>; connections: number; port: number }> {
  const state = { connections: 0, port: 0 };
  const server = net.createServer((socket) => {
    state.connections += 1;
    socket.destroy();
  });
  state.port = await listen(server);
  return Object.assign(state, { close: () => closeServer(server) });
}

function childEnvironment(root: string, extra: Readonly<Record<string, string | undefined>>): NodeJS.ProcessEnv {
  return { HOME: root, PATH: process.env.PATH, ...extra };
}

function bytesOf(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

describe("runtime proxy network scope", () => {
  it("publishes provider routing as scoped inputs instead of global proxy and CA variables", () => {
    const environment = buildRuntimeProxyEnvironment({
      adapterCaCertPath: "/run/opentag-execution/ca.pem",
      cliMetadata: () => undefined,
      connectProxyUrl: "http://127.0.0.1:18080",
      handles: new Map([
        ["github", "otrh_github"],
        ["slack", "otrh_slack"],
      ]),
      layout: {
        adapterCaCertPath: "/run/opentag-execution/ca.pem",
        executionDir: "/run/opentag-execution",
        gitConfigPath: "/run/opentag-execution/gitconfig",
        gitCredentialHelperPath: "/run/opentag-execution/git-credential-helper",
        larkConfigDir: "/run/opentag-execution/lark",
        slackConfigDir: "/run/opentag-execution/slack",
      },
      slackApiHost: "https://127.0.0.1:18443",
    });
    for (const key of GLOBAL_ROUTING_KEYS) expect(environment).not.toHaveProperty(key);
    expect(environment[RUNTIME_PROXY_PROVIDER_URL_KEY]).toBe("http://127.0.0.1:18080");
    expect(environment[RUNTIME_PROXY_PROVIDER_CA_KEY]).toBe("/run/opentag-execution/ca.pem");
    expect(environment.GH_TOKEN).toBe("otrh_github");
    expect(environment.SLACK_BOT_TOKEN).toBe("otrh_slack");
    expect(environment.GIT_CONFIG_GLOBAL).toBe("/run/opentag-execution/gitconfig");
    expect(providerRoutingEnvironment(environment)).toEqual({
      CURL_CA_BUNDLE: "/run/opentag-execution/ca.pem",
      HTTPS_PROXY: "http://127.0.0.1:18080",
      NO_PROXY: "127.0.0.1,localhost",
      SSL_CERT_FILE: "/run/opentag-execution/ca.pem",
      https_proxy: "http://127.0.0.1:18080",
      no_proxy: "127.0.0.1,localhost",
    });
    // A stale or foreign environment without both scoped inputs never derives routing.
    expect(providerRoutingEnvironment({ GH_TOKEN: "otrh_only", HTTPS_PROXY: "http://stale.invalid" })).toEqual({});
  });

  it("derives the provider CLI routing scope from the execution manifest only", async () => {
    const root = await temporaryRoot("opentag-manifest-");
    const manifestPath = join(root, "manifest.json");
    await writeFile(
      manifestPath,
      JSON.stringify({
        executionId: randomUUID(),
        schemaVersion: 1,
        environment: {
          [RUNTIME_PROXY_PROVIDER_CA_KEY]: "/run/opentag-execution/ca.pem",
          [RUNTIME_PROXY_PROVIDER_URL_KEY]: "http://127.0.0.1:18080",
          GITHUB_TOKEN: null,
          SLACK_BOT_TOKEN: "otrh_slack",
        },
      }),
    );
    const environment: NodeJS.ProcessEnv = { GITHUB_TOKEN: "ambient", SLACK_APP_TOKEN: "ambient" };
    await mergeEnvironmentManifest(environment, manifestPath);
    // The manifest null marker unsets an inherited credential; the handle is applied.
    expect(environment.GITHUB_TOKEN).toBeUndefined();
    expect(environment.SLACK_BOT_TOKEN).toBe("otrh_slack");
    // Routing is derived for the provider CLI process, not injected into any ambient caller.
    expect(environment.HTTPS_PROXY).toBe("http://127.0.0.1:18080");
    expect(environment.SSL_CERT_FILE).toBe("/run/opentag-execution/ca.pem");
    expect(environment.NO_PROXY).toBe("127.0.0.1,localhost");
  });

  it("keeps ordinary public HTTPS direct with the public trust store, never credential-proxied", async () => {
    const root = await temporaryRoot("opentag-network-");
    const fixture = await createHttpsFixture(root);
    teardowns.push(() => closeServer(fixture.server));
    const openStream = vi.fn(async () => {
      throw new Error("Ordinary HTTPS traffic must never reach the credential proxy");
    });
    const adapter = await RuntimeProxyLoopbackAdapter.start({
      executionId: randomUUID(),
      materialDir: join(root, "adapter"),
      openStream,
      verifyHandle: () => true,
    });
    teardowns.push(() => adapter.close());
    const environment = buildRuntimeProxyEnvironment({
      adapterCaCertPath: adapter.caCertPath,
      cliMetadata: () => undefined,
      connectProxyUrl: adapter.connectProxyUrl,
      handles: new Map([
        ["github", "otrh_github"],
        ["slack", "otrh_slack"],
      ]),
      layout: {
        adapterCaCertPath: adapter.caCertPath,
        executionDir: root,
        gitConfigPath: join(root, "gitconfig"),
        gitCredentialHelperPath: join(root, "git-credential-helper"),
        larkConfigDir: join(root, "lark"),
        slackConfigDir: join(root, "slack"),
      },
      slackApiHost: adapter.slackApiHost,
    });
    const curl = (extra: Readonly<Record<string, string | undefined>>) =>
      execFileAsync(
        "curl",
        [
          "--max-time",
          "5",
          "--silent",
          "--show-error",
          "--output",
          "/dev/null",
          "--resolve",
          `fixture.test:${fixture.port}:127.0.0.1`,
          "--cacert",
          fixture.caPath,
          `https://fixture.test:${fixture.port}/`,
        ],
        { env: childEnvironment(root, extra) },
      );

    // The Agent runtime environment reaches the fixture directly and never opens a relay stream.
    await expect(curl(environment)).resolves.toBeDefined();
    expect(fixture.hits).toBe(1);
    expect(openStream).not.toHaveBeenCalled();

    // Negative control: applying the provider scope ambiently is exactly the audited failure.
    // The adapter refuses to CONNECT to a non-platform destination, so the platform proxy can
    // never be a generic forwarding proxy.
    await expect(curl({ ...environment, ...providerRoutingEnvironment(environment) })).rejects.toMatchObject({
      code: 56,
      stderr: expect.stringContaining("403"),
    });
    expect(fixture.hits).toBe(1);
    expect(openStream).not.toHaveBeenCalled();
  });

  it("writes host-scoped Git routing that disables ambient proxies", async () => {
    const root = await temporaryRoot("opentag-gitconfig-");
    const gitConfigPath = join(root, "gitconfig");
    await writeFile(
      gitConfigPath,
      renderRuntimeProxyGitConfig({
        caCertPath: "/run/opentag-execution/ca.pem",
        connectProxyUrl: "http://127.0.0.1:18080",
      }),
    );
    const environment = childEnvironment(root, { GIT_CONFIG_GLOBAL: gitConfigPath, GIT_CONFIG_NOSYSTEM: "1" });
    const gitConfigValue = async (key: string, url: string): Promise<string | undefined> => {
      try {
        const { stdout } = await execFileAsync("git", ["config", "--get-urlmatch", key, url], { env: environment });
        return stdout.trim();
      } catch {
        return undefined;
      }
    };
    expect(await gitConfigValue("http.proxy", "https://github.com/acme/repo.git")).toBe("http://127.0.0.1:18080");
    expect(await gitConfigValue("http.sslCAInfo", "https://github.com/acme/repo.git")).toBe(
      "/run/opentag-execution/ca.pem",
    );
    expect(await gitConfigValue("http.proxy", "https://gitlab.com/acme/repo.git")).toBe("");
    expect(await gitConfigValue("http.sslCAInfo", "https://gitlab.com/acme/repo.git")).toBeUndefined();
  });

  it("routes GitHub Git through the provider proxy while other hosts stay direct", async () => {
    const root = await temporaryRoot("opentag-gitroute-");
    const providerProxy = await recordingConnectProxy();
    teardowns.push(providerProxy.close);
    const ambientProxy = await recordingConnectProxy();
    teardowns.push(ambientProxy.close);
    const direct = await connectionRecordingServer();
    teardowns.push(direct.close);
    const gitConfigPath = join(root, "gitconfig");
    await writeFile(
      gitConfigPath,
      renderRuntimeProxyGitConfig({
        caCertPath: join(root, "ca.pem"),
        connectProxyUrl: `http://127.0.0.1:${providerProxy.port}`,
      }),
    );
    const environment = childEnvironment(root, {
      GIT_CONFIG_GLOBAL: gitConfigPath,
      GIT_CONFIG_NOSYSTEM: "1",
      HTTPS_PROXY: `http://127.0.0.1:${ambientProxy.port}`,
      https_proxy: `http://127.0.0.1:${ambientProxy.port}`,
    });
    const runGit = (url: string) =>
      execFileAsync("git", ["ls-remote", url], { env: environment, timeout: 10_000 }).catch(() => undefined);

    // The per-host entry wins over the ambient proxy variable for github.com.
    await runGit("https://github.com/acme/fixture.git");
    expect(providerProxy.requestLines.some((line) => line.startsWith("CONNECT github.com:443"))).toBe(true);
    expect(ambientProxy.requestLines).toEqual([]);

    // Every other host ignores ambient proxy variables and connects directly.
    await runGit(`https://127.0.0.1:${direct.port}/acme/fixture.git`);
    expect(direct.connections).toBeGreaterThan(0);
    expect(ambientProxy.requestLines).toEqual([]);
  });

  it("keeps provider GitHub Git on the credential proxy with the execution CA", async () => {
    const root = await temporaryRoot("opentag-gitprovider-");
    const requests: RuntimeProxyAdapterStreamRequest[] = [];
    const adapter = await RuntimeProxyLoopbackAdapter.start({
      executionId: randomUUID(),
      materialDir: join(root, "adapter"),
      openStream: async (request) => {
        requests.push(request);
        return {
          status: 200,
          headers: { "content-type": "application/x-git-upload-pack-advertisement" },
          body: (async function* () {
            yield bytesOf("001e# service=git-upload-pack\n00000000");
          })(),
        };
      },
      verifyHandle: (_provider, handle) => handle === "otrh_handle",
    });
    teardowns.push(() => adapter.close());
    const layout = {
      adapterCaCertPath: adapter.caCertPath,
      executionDir: root,
      gitConfigPath: join(root, "gitconfig"),
      gitCredentialHelperPath: join(root, "git-credential-helper"),
      larkConfigDir: join(root, "lark"),
      slackConfigDir: join(root, "slack"),
    };
    const environment = buildRuntimeProxyEnvironment({
      adapterCaCertPath: adapter.caCertPath,
      cliMetadata: () => undefined,
      connectProxyUrl: adapter.connectProxyUrl,
      handles: new Map([["github", "otrh_handle"]]),
      layout,
      slackApiHost: adapter.slackApiHost,
    });
    await writeFile(
      layout.gitConfigPath,
      renderRuntimeProxyGitConfig({ caCertPath: adapter.caCertPath, connectProxyUrl: adapter.connectProxyUrl }),
    );
    await writeFile(layout.gitCredentialHelperPath, renderRuntimeProxyGitCredentialHelper("otrh_handle"), {
      mode: 0o700,
    });

    // Real Git: the host-scoped config routes github.com to the adapter, the execution CA is
    // trusted, and the credential helper supplies the execution-local handle after the 401.
    const result = await execFileAsync("git", ["ls-remote", "https://github.com/acme/fixture.git"], {
      // actions/checkout adds a repository-local Authorization extraheader. Run outside that
      // checkout so the fixture tests only its own credential helper and never inherits CI auth.
      cwd: root,
      env: childEnvironment(root, environment),
      timeout: 15_000,
    });
    expect(result.stdout).toBe("");
    expect(requests.length).toBeGreaterThan(0);
    expect(requests[0]).toMatchObject({
      path: "/acme/fixture.git/info/refs?service=git-upload-pack",
      provider: "github",
    });
    expect(requests[0]?.headers["x-opentag-provider-origin"]).toBe("github.com");
  });

  it("scopes routing to a provider launcher process without touching the caller environment", async () => {
    const root = await temporaryRoot("opentag-launcher-");
    const realBin = join(root, "real-bin");
    const launcherDir = join(root, "bin");
    await mkdir(realBin, { recursive: true, mode: 0o700 });
    await mkdir(launcherDir, { recursive: true, mode: 0o700 });
    await writeFile(
      join(realBin, "gh"),
      `#!/bin/sh\nprintf '%s\\n' "$HTTPS_PROXY" "$SSL_CERT_FILE" "$NO_PROXY" "$*"\n`,
      { mode: 0o700 },
    );
    await writeFile(join(launcherDir, "gh"), renderRuntimeProxyProviderLauncher("gh"), { mode: 0o700 });
    const path = `${launcherDir}:${realBin}:/usr/bin:/bin`;

    const scoped = await execFileAsync(join(launcherDir, "gh"), ["--version"], {
      env: childEnvironment(root, {
        OPENTAG_PROVIDER_CA_PATH: "/run/opentag-execution/ca.pem",
        OPENTAG_PROVIDER_PROXY_URL: "http://127.0.0.1:18080",
        PATH: path,
      }),
    });
    expect(scoped.stdout.split("\n").slice(0, 3)).toEqual([
      "http://127.0.0.1:18080",
      "/run/opentag-execution/ca.pem",
      "127.0.0.1,localhost",
    ]);
    expect(scoped.stdout).toContain("--version");

    // Without the scoped inputs the launcher leaves routing to the caller (no global injection).
    const plain = await execFileAsync(join(launcherDir, "gh"), ["--version"], {
      env: childEnvironment(root, { PATH: path }),
    });
    expect(plain.stdout.split("\n").slice(0, 3)).toEqual(["", "", ""]);
  });
});
