import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, chown, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import {
  closeBridgeSockets,
  createBridgeSocketResources,
  listenBridgeProxySockets,
  publishExecutionMaterial,
} from "../cloud-runtime/bridge-material.js";
import { CodexAppServerProcess } from "../providers/codex/app-server-wire.js";
import { CODEX_EXECUTION_PERMISSIONS, codexSocketPermissions } from "../providers/codex/socket-permissions.js";
import type { RuntimeCredentialRelay } from "../runtime/runtime-credential-relay.js";
import { RuntimeProxyDataError } from "../runtime/runtime-proxy-data-client.js";
import { RuntimeProxyLoopbackAdapter } from "../runtime/runtime-proxy-loopback-adapter.js";
import { buildRuntimeProxyEnvironment, RuntimeProxyMaterialStore } from "../runtime/runtime-proxy-material.js";
import { cloudEntryFixture } from "./support/cloud-entry-fixture.js";

const binary = process.env.OPENTAG_TEST_GH_BINARY;
const run = promisify(execFile);

describe.skipIf(!binary)("native gh execution-local transport (offline, no provider credentials)", () => {
  it("uses the published private socket on macOS/Linux and rejects foreign authority or handles", async () => {
    const root = await mkdtemp(join(tmpdir(), "ot-gh-test-"));
    const sessionId = randomUUID(),
      executionId = randomUUID();
    const store = new RuntimeProxyMaterialStore({ home: root });
    const requests: { path: string; headers: Readonly<Record<string, string>> }[] = [];
    const adapter = await RuntimeProxyLoopbackAdapter.start({
      githubApiSocket: true,
      executionId,
      materialDir: store.executionLayout(sessionId, executionId).executionDir,
      verifyHandle: (provider, handle) => provider === "github" && handle === "otrh_fixture",
      openStream: async (request) => {
        requests.push({ path: request.path, headers: request.headers });
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: (async function* () {
            yield Buffer.from(
              request.path.includes("/status")
                ? '{"state":"success","statuses":[{"context":"private-ci","state":"success"}]}'
                : '{"name":"fixture"}',
            );
          })(),
        };
      },
      logger: { debug() {}, warn() {} },
    });
    const socketPath = adapter.githubApiSocketPath;
    try {
      expect(socketPath).toBeDefined();
      const layout = store.executionLayout(sessionId, executionId);
      const environment = buildRuntimeProxyEnvironment({
        layout,
        executionId,
        adapterCaCertPath: adapter.caCertPath,
        connectProxyUrl: adapter.connectProxyUrl,
        slackApiHost: adapter.slackApiHost,
        handles: new Map([["github", "otrh_fixture"]]),
        cliMetadata: () => undefined,
      });
      await store.publish({
        sessionId,
        executionId,
        platform: process.platform,
        adapterCaCertPath: adapter.caCertPath,
        handles: new Map([["github", "otrh_fixture"]]),
        environment,
        githubApiSocketPath: socketPath,
      });
      const config = await readFile(join(String(environment.GH_CONFIG_DIR), "config.yml"), "utf8");
      expect(config).toContain(JSON.stringify(socketPath));
      await chmod(join(String(environment.GH_CONFIG_DIR), "config.yml"), 0o444);
      expect((await stat(socketPath as string)).mode & 0o777).toBe(0o600);
      const env = Object.fromEntries(
        Object.entries({ HOME: root, PATH: process.env.PATH, GH_HOST: "ambient.invalid", ...environment }).filter(
          ([, value]) => value !== undefined,
        ),
      );
      // No CA or global proxy settings are needed for native gh's authenticated IPC transport.
      expect(env.SSL_CERT_FILE).toBeUndefined();
      expect(env.HTTPS_PROXY).toBeUndefined();
      expect(env.GH_HOST).toBe("github.com");
      // macOS must enforce the same execution-material write denial as the real model sandbox.
      // Resolve /var -> /private/var: Seatbelt subpath rules use canonical filesystem paths.
      const configDir = await realpath(String(environment.GH_CONFIG_DIR));
      const runReadonlyGh = (args: string[]) =>
        run(
          process.platform === "darwin" ? "/usr/bin/sandbox-exec" : (binary as string),
          process.platform === "darwin"
            ? [
                "-p",
                `(version 1)(allow default)(deny file-write* (subpath ${JSON.stringify(configDir)}))`,
                binary as string,
                ...args,
              ]
            : args,
          { cwd: root, env, timeout: 15000 },
        );
      expect((await runReadonlyGh(["--version"])).stdout).toContain("gh version");
      const result = await runReadonlyGh(["api", "repos/team/fixture", "-H", "X-Opentag-Provider-Origin: github.com"]);
      expect(JSON.parse(result.stdout)).toEqual({ name: "fixture" });
      const sandboxed = await verifyCodexSandbox(root, env, configDir, config, socketPath as string);
      expect(requests).toHaveLength(sandboxed ? 2 : 1);
      expect(requests[0]?.headers["x-opentag-provider-origin"]).toBe("api.github.com");
      for (const suffix of ["commits/main/status", "commits/feature/topic/statuses", "statuses/feature/topic"]) {
        const status = await run(binary as string, ["api", `repos/team/fixture/${suffix}`], {
          cwd: root,
          env,
          timeout: 15000,
        });
        expect(JSON.parse(status.stdout).statuses).toEqual([{ context: "private-ci", state: "success" }]);
        expect(requests.at(-1)?.path).toBe(`/repos/team/fixture/${suffix}`);
      }
      await expect(
        run(binary as string, ["api", "--hostname", "foreign.invalid", "repos/team/fixture"], {
          cwd: root,
          env,
          timeout: 15000,
        }),
      ).rejects.toMatchObject({ code: 1 });
      await expect(
        run(binary as string, ["api", "repos/team/fixture"], {
          cwd: root,
          env: { ...env, GH_TOKEN: "otrh_wrong" },
          timeout: 15000,
        }),
      ).rejects.toMatchObject({ code: 1 });
      expect(requests).toHaveLength(sandboxed ? 5 : 4);
      expect(await readFile(join(configDir, "config.yml"), "utf8")).toBe(config);
      expect(await readdir(configDir)).toEqual(["config.yml"]);
      await adapter.close();
      await expect(stat(socketPath as string)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        run(binary as string, ["api", "repos/team/fixture"], { cwd: root, env, timeout: 15000 }),
      ).rejects.toBeDefined();
    } finally {
      await adapter.close();
      await store.cleanupSession(sessionId);
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);
});

// Always-run framing control; an HTTP caller cannot use the gh IPC entry as an open proxy.
describe("GitHub IPC authority boundary", () => {
  it.each(["x".repeat(120), "space #@", "relative"])(
    "keeps both sockets private with an unsuitable TMPDIR %s",
    async (segment) => {
      const root = await mkdtemp(join(tmpdir(), "ot-gh-long-temp-"));
      const longTemp = join(root, segment);
      await mkdir(longTemp);
      vi.stubEnv("TMPDIR", segment === "relative" ? segment : longTemp);
      let adapter: RuntimeProxyLoopbackAdapter | undefined;
      let socketPath: string | undefined;
      try {
        adapter = await RuntimeProxyLoopbackAdapter.start({
          githubApiSocket: true,
          executionId: randomUUID(),
          materialDir: root,
          verifyHandle: () => true,
          openStream: async () => {
            throw new Error("Must not dispatch");
          },
          logger: { debug() {}, warn() {} },
        });
        socketPath = adapter.githubApiSocketPath;
        expect(socketPath).toMatch(/^\/tmp\/ot-gh-/);
        expect(Buffer.byteLength(socketPath as string)).toBeLessThanOrEqual(100);
        expect(adapter.githubGitSocketPath).toMatch(/^\/tmp\/ot-gh-.*\/git\.sock$/);
        expect(Buffer.byteLength(adapter.githubGitSocketPath as string)).toBeLessThanOrEqual(100);
        expect((await stat(adapter.githubGitSocketPath as string)).mode & 0o777).toBe(0o600);
        expect((await stat(dirname(socketPath as string))).mode & 0o777).toBe(0o700);
        expect((await stat(socketPath as string)).mode & 0o777).toBe(0o600);
        expect(adapter.connectProxyUrl).toMatch(/^http:\/\/127\.0\.0\.1:/);
        expect(adapter.slackApiHost).toMatch(/^https:\/\/127\.0\.0\.1:/);
      } finally {
        vi.unstubAllEnvs();
        await adapter?.close();
        await rm(root, { recursive: true, force: true });
      }
      await expect(stat(socketPath as string)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("returns a bounded JSON permission failure through the Local gh socket", async () => {
    const root = await mkdtemp(join(tmpdir(), "ot-gh-error-"));
    const adapter = await RuntimeProxyLoopbackAdapter.start({
      githubApiSocket: true,
      executionId: randomUUID(),
      materialDir: root,
      verifyHandle: () => true,
      logger: { debug() {}, warn() {} },
      openStream: async () => {
        throw new RuntimeProxyDataError("stream_error", "credential must stay private", undefined, "scope_denied");
      },
    });
    try {
      const result = await new Promise<{ status?: number; headers: http.IncomingHttpHeaders; body: string }>(
        (resolve, reject) => {
          const req = http.request(
            {
              socketPath: adapter.githubApiSocketPath,
              path: "/repos/team/fixture",
              headers: { host: "api.github.com", authorization: "token otrh_fixture" },
            },
            (res) => {
              const chunks: Buffer[] = [];
              res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
              res.on("end", () =>
                resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }),
              );
            },
          );
          req.on("error", reject);
          req.end();
        },
      );
      expect(result.status).toBe(403);
      expect(result.headers["content-type"]).toBe("application/json");
      expect(JSON.parse(result.body)).toEqual({ message: "scope_denied", code: "scope_denied" });
      expect(result.body).not.toContain("credential");
    } finally {
      await adapter.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects absolute URLs before opening a relay stream", async () => {
    const root = await mkdtemp(join(tmpdir(), "ot-gh-boundary-"));
    let hits = 0;
    const adapter = await RuntimeProxyLoopbackAdapter.start({
      githubApiSocket: true,
      executionId: randomUUID(),
      materialDir: root,
      verifyHandle: () => true,
      openStream: async () => {
        hits++;
        throw new Error("Must not dispatch");
      },
      logger: { debug() {}, warn() {} },
    });
    try {
      const status = await new Promise<number | undefined>((resolve, reject) => {
        const request = http.request(
          {
            socketPath: adapter.githubApiSocketPath,
            method: "GET",
            path: "https://foreign.invalid/secret",
            headers: { host: "api.github.com", authorization: "token otrh_fixture" },
          },
          (response) => {
            response.resume();
            response.on("end", () => resolve(response.statusCode));
          },
        );
        request.on("error", reject);
        request.end();
      });
      expect(status).toBe(403);
      expect(hits).toBe(0);
    } finally {
      await adapter.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

// Linux Cloud retains its sandbox CONNECT bridge: parent-local IPC paths must never enter its manifest.
describe.skipIf(!binary || process.platform !== "linux")("native gh Cloud published transport", () => {
  it("uses the generated sandbox entry, public CA and provider launcher through the Cloud bridge", async () => {
    const root = await mkdtemp(join(tmpdir(), "ot-cloud-"));
    const resources = createBridgeSocketResources();
    const executionId = randomUUID();
    let hits = 0;
    const paths: string[] = [];
    const adapter = await RuntimeProxyLoopbackAdapter.start({
      executionId,
      materialDir: join(root, "private"),
      verifyHandle: (provider, handle) => provider === "github" && handle === "otrh_cloud_fixture",
      logger: { debug() {}, warn() {} },
      openStream: async (request) => {
        expect(request.headers["x-opentag-provider-origin"]).toBe("api.github.com");
        hits++;
        paths.push(request.path);
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: (async function* () {
            yield Buffer.from(cloudGhResponse(request.path));
          })(),
        };
      },
    });
    const relay = {
      executionId,
      providers: [{ provider: "github" }],
      localHandleFor: () => "otrh_cloud_fixture",
      cliMetadataFor: () => undefined,
    } as unknown as RuntimeCredentialRelay;
    try {
      const published = join(root, "public");
      await publishExecutionMaterial({ adapter, relay }, published, {
        includeEntryPrograms: true,
        publicMountPath: published,
      });
      const ghConfig = join(published, "gh-config", "config.yml");
      const initialConfig = await readFile(ghConfig, "utf8");
      expect((await stat(ghConfig)).mode & 0o777).toBe(0o444);
      await listenBridgeProxySockets(resources, adapter, published);
      expect(adapter.githubApiSocketPath).toBeUndefined();
      // Remap the container namespace while keeping CA copying, manifest loading and cleanup.
      const entry = await cloudEntryFixture(published, root);
      const fixtureEntry = join(published, "entry-fixture.mjs");
      await writeFile(fixtureEntry, entry, { mode: 0o444, flag: "wx" });
      expect((await stat(join(published, "entry.mjs"))).mode & 0o777).toBe(0o444);
      const childIdentity = process.getuid?.() === 0 ? { uid: 65534, gid: 65534 } : {};
      if (process.getuid?.() === 0) await chown(root, 65534, 65534);
      const result = await run(
        process.execPath,
        [
          fixtureEntry,
          "sh",
          "-c",
          'PATH="$1:$2:$PATH"; export PATH; test ! -w "$GH_CONFIG_DIR/config.yml" || exit 97; gh api repos/team/fixture --jq tojson || exit "$?"; shift 2; for suffix in "$@"; do gh api "repos/team/fixture/$suffix" --jq tojson || exit "$?"; done; gh run list -R team/fixture --branch main --commit 1111111111111111111111111111111111111111 --limit 1 --json databaseId,headSha,workflowName --jq tojson',
          "fixture",
          join(published, "bin"),
          dirname(binary as string),
          "commits/main/status",
          "commits/feature/topic/statuses",
          "statuses/feature/topic",
        ],
        { cwd: root, env: { PATH: process.env.PATH }, ...childIdentity, timeout: 20000 },
      );
      const responses = result.stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(responses).toEqual([
        { name: "cloud-fixture" },
        ...Array.from({ length: 3 }, () => ({
          state: "success",
          statuses: [{ context: "private-ci", state: "success" }],
        })),
        [{ databaseId: 7, headSha: "1".repeat(40), workflowName: "Fixture CI" }],
      ]);
      expect(hits).toBe(6);
      expect(paths.some((path) => path.startsWith("/repos/team/fixture/actions/workflows?"))).toBe(true);
      expect(
        paths.some((path) => new URL(path, "https://api.github.com").searchParams.get("head_sha") === "1".repeat(40)),
      ).toBe(true);
      expect(await readFile(ghConfig, "utf8")).toBe(initialConfig);
      expect(await readdir(dirname(ghConfig))).toEqual(["config.yml"]);
      const manifest = await readFile(join(published, "environment.json"), "utf8");
      expect(manifest).not.toContain(join(root, "private"));
      expect(manifest).not.toContain("http_unix_socket");
    } finally {
      await closeBridgeSockets(resources);
      await adapter.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);
});

function cloudGhResponse(path: string): string {
  if (path.includes("/actions/workflows"))
    return JSON.stringify({
      workflows: [{ id: 42, name: "Fixture CI", state: "active", path: ".github/workflows/ci.yml" }],
    });
  if (path.includes("/actions/runs"))
    return JSON.stringify({
      workflow_runs: [
        {
          id: 7,
          workflow_id: 42,
          head_sha: "1".repeat(40),
          head_branch: "main",
          status: "completed",
          conclusion: "success",
          event: "push",
          created_at: "2026-10-14T01:00:00Z",
        },
      ],
    });
  if (path.includes("/status")) return '{"state":"success","statuses":[{"context":"private-ci","state":"success"}]}';
  return '{"name":"cloud-fixture"}';
}

function inlineToml(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(inlineToml).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .map(([key, item]) => `${JSON.stringify(key)}=${inlineToml(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

async function verifyCodexSandbox(
  root: string,
  env: NodeJS.ProcessEnv,
  configDir: string,
  config: string,
  socketPath: string,
): Promise<boolean> {
  if (!process.env.OPENTAG_TEST_CODEX_BINARY || process.platform !== "darwin") return false;
  const codexHome = join(root, "codex-home");
  await mkdir(codexHome);
  const socketConfig = codexSocketPermissions(
    [socketPath],
    { cwd: root },
    {
      fileSystem: "workspace-write",
      network: "disabled",
      approvals: "on-request",
      tools: { mode: "provider-default" },
    },
  ) as { permissions: Record<string, { filesystem: Record<string, string> }> };
  const profile = socketConfig.permissions[CODEX_EXECUTION_PERMISSIONS];
  if (!profile) throw Error("Missing execution profile");
  profile.filesystem[configDir] = "read";
  const wire = new CodexAppServerProcess({
    command: process.env.OPENTAG_TEST_CODEX_BINARY,
    cwd: root,
    env: { ...env, CODEX_HOME: codexHome },
  });
  try {
    await wire.initialize("0.0.1-test");
    const loaded = (await wire.request("thread/start", {
      cwd: root,
      ephemeral: true,
      approvalPolicy: "on-request",
      permissions: CODEX_EXECUTION_PERMISSIONS,
      config: socketConfig,
    })) as { activePermissionProfile?: { id: string } };
    expect(loaded.activePermissionProfile?.id).toBe(CODEX_EXECUTION_PERMISSIONS);
  } finally {
    await wire.close();
  }
  await writeFile(
    join(codexHome, "config.toml"),
    `features={network_proxy=true}\npermissions=${inlineToml(socketConfig.permissions)}\n`,
  );
  const native = await run(
    process.env.OPENTAG_TEST_CODEX_BINARY,
    [
      "sandbox",
      "--permission-profile",
      CODEX_EXECUTION_PERMISSIONS,
      "--",
      binary as string,
      "api",
      "repos/team/fixture",
    ],
    { cwd: root, env: { ...env, CODEX_HOME: codexHome }, timeout: 15000 },
  );
  expect(JSON.parse(native.stdout)).toEqual({ name: "fixture" });
  expect(await readFile(join(configDir, "config.yml"), "utf8")).toBe(config);
  // An unrelated private socket remains blocked while direct TCP egress stays disabled.
  const foreign = await RuntimeProxyLoopbackAdapter.start({
    githubApiSocket: true,
    executionId: randomUUID(),
    materialDir: join(root, "foreign"),
    verifyHandle: () => true,
    openStream: async () => {
      throw Error("Foreign socket reached");
    },
    logger: { debug() {}, warn() {} },
  });
  try {
    await expect(
      run(
        process.env.OPENTAG_TEST_CODEX_BINARY,
        [
          "sandbox",
          "--permission-profile",
          CODEX_EXECUTION_PERMISSIONS,
          "--",
          "/usr/bin/curl",
          "--silent",
          "--show-error",
          "--max-time",
          "2",
          "--unix-socket",
          foreign.githubApiSocketPath as string,
          "http://api.github.com",
        ],
        { cwd: root, env: { ...env, CODEX_HOME: codexHome }, timeout: 10000 },
      ),
    ).rejects.toMatchObject({ code: 7 });
  } finally {
    await foreign.close();
  }
  const tcp = http.createServer((_req, res) => res.end("must not reach direct TCP"));
  await new Promise<void>((resolve) => tcp.listen(0, "127.0.0.1", resolve));
  const address = tcp.address();
  if (!address || typeof address === "string") throw Error("Missing TCP fixture port");
  try {
    await expect(
      run(
        process.env.OPENTAG_TEST_CODEX_BINARY,
        [
          "sandbox",
          "--permission-profile",
          CODEX_EXECUTION_PERMISSIONS,
          "--",
          "/usr/bin/curl",
          "--noproxy",
          "*",
          "--silent",
          "--show-error",
          "--max-time",
          "2",
          `http://127.0.0.1:${address.port}`,
        ],
        { cwd: root, env: { ...env, CODEX_HOME: codexHome }, timeout: 10000 },
      ),
    ).rejects.toMatchObject({ code: 7 });
  } finally {
    await new Promise<void>((resolve) => tcp.close(() => resolve()));
  }
  return true;
}
