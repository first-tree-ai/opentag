import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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
import { CLOUD_EXECUTION_MOUNT, CLOUD_SANDBOX_CA_DESTINATION } from "../cloud-runtime/sandbox-entry.js";
import type { RuntimeCredentialRelay } from "../runtime/runtime-credential-relay.js";
import { RuntimeProxyLoopbackAdapter } from "../runtime/runtime-proxy-loopback-adapter.js";
import { buildRuntimeProxyEnvironment, RuntimeProxyMaterialStore } from "../runtime/runtime-proxy-material.js";

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
      const result = await run(
        binary as string,
        ["api", "repos/team/fixture", "-H", "X-Opentag-Provider-Origin: github.com"],
        { cwd: root, env, timeout: 15000 },
      );
      expect(JSON.parse(result.stdout)).toEqual({ name: "fixture" });
      expect(requests).toHaveLength(1);
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
      expect(requests).toHaveLength(4);
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
  it("keeps the socket private and starts other providers when TMPDIR is too long", async () => {
    const root = await mkdtemp(join(tmpdir(), "ot-gh-long-temp-"));
    const longTemp = join(root, "x".repeat(120));
    await mkdir(longTemp);
    vi.stubEnv("TMPDIR", longTemp);
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
    const adapter = await RuntimeProxyLoopbackAdapter.start({
      executionId,
      materialDir: join(root, "private"),
      verifyHandle: (provider, handle) => provider === "github" && handle === "otrh_cloud_fixture",
      logger: { debug() {}, warn() {} },
      openStream: async (request) => {
        expect(request.headers["x-opentag-provider-origin"]).toBe("api.github.com");
        hits++;
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: (async function* () {
            yield Buffer.from(
              request.path.includes("/status")
                ? '{"state":"success","statuses":[{"context":"private-ci","state":"success"}]}'
                : '{"name":"cloud-fixture"}',
            );
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
      await listenBridgeProxySockets(resources, adapter, published);
      expect(adapter.githubApiSocketPath).toBeUndefined();
      // Remap fixed container filesystem locations to the isolated test root only. The stock
      // entry still owns both loopback ports, CA copying, manifest loading and process cleanup.
      const entry = (await readFile(join(published, "entry.mjs"), "utf8"))
        .replaceAll(CLOUD_EXECUTION_MOUNT, published)
        .replaceAll(CLOUD_SANDBOX_CA_DESTINATION, join(root, "sandbox-home", "ca.pem"))
        .replaceAll("/tmp/opentag", join(root, "cli"))
        .replaceAll("/home/runner", join(root, "sandbox-home"));
      const fixtureEntry = join(published, "entry-fixture.mjs");
      await writeFile(fixtureEntry, entry, { mode: 0o444, flag: "wx" });
      expect((await stat(join(published, "entry.mjs"))).mode & 0o777).toBe(0o444);
      const result = await run(
        process.execPath,
        [
          fixtureEntry,
          "sh",
          "-c",
          'PATH="$1:$2:$PATH"; export PATH; gh api repos/team/fixture --jq tojson || exit "$?"; shift 2; for suffix in "$@"; do gh api "repos/team/fixture/$suffix" --jq tojson || exit "$?"; done',
          "fixture",
          join(published, "bin"),
          dirname(binary as string),
          "commits/main/status",
          "commits/feature/topic/statuses",
          "statuses/feature/topic",
        ],
        { cwd: root, env: { PATH: process.env.PATH }, timeout: 20000 },
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
      ]);
      expect(hits).toBe(4);
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
