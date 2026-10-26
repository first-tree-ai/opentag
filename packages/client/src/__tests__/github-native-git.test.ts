import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chown, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, type TestContext } from "vitest";
import {
  closeBridgeSockets,
  createBridgeSocketResources,
  listenBridgeProxySockets,
  publishExecutionMaterial,
} from "../cloud-runtime/bridge-material.js";
import { CodexAppServerProcess } from "../providers/codex/app-server-wire.js";
import { CODEX_EXECUTION_PERMISSIONS, codexSocketPermissions } from "../providers/codex/socket-permissions.js";
import type { RuntimeCredentialRelay } from "../runtime/runtime-credential-relay.js";
import { RuntimeProxyLoopbackAdapter } from "../runtime/runtime-proxy-loopback-adapter.js";
import { buildRuntimeProxyEnvironment, RuntimeProxyMaterialStore } from "../runtime/runtime-proxy-material.js";
import { cloudEntryFixture } from "./support/cloud-entry-fixture.js";
import { nativeGitFixture } from "./support/native-git-fixture.js";
import { skipUnsupportedNativeTls } from "./support/native-tls-probe.js";

const run = promisify(execFile);
const codex = process.env.OPENTAG_TEST_CODEX_BINARY;
const policy = {
  fileSystem: "workspace-write",
  network: "disabled",
  approvals: "on-request",
  tools: { mode: "provider-default" },
} as const;
function toml(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(toml).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .map(([key, item]) => `${JSON.stringify(key)}=${toml(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

async function legacyGit(env: NodeJS.ProcessEnv): Promise<boolean> {
  const version = (await run("git", ["--version"], { env })).stdout.match(/git version (\d+)\.(\d+)/);
  return version?.[1] === "2" && Number(version[2]) < 47;
}
function foreignProxy(legacy: boolean, adapter: RuntimeProxyLoopbackAdapter): string {
  return legacy ? adapter.connectProxyUrl : `socks5h://localhost${adapter.githubGitSocketPath}`;
}
async function checkLegacyTls(context: TestContext, root: string, legacy: boolean): Promise<void> {
  // Modern IPC and restricted old-Git denial never depend on this HTTPS baseline.
  if (legacy && !codex) await skipUnsupportedNativeTls(context, root);
}

describe.skipIf(process.platform === "win32")("native Git execution-local transport (offline)", () => {
  it("preserves real Git commits and sandbox boundaries, with CONNECT compatibility for older Git", async (context) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "ot-git-")));
    const fixture = await nativeGitFixture(root);
    const store = new RuntimeProxyMaterialStore({ home: root });
    const sessionId = randomUUID(),
      executionId = randomUUID();
    let active = true;
    const adapter = await RuntimeProxyLoopbackAdapter.start({
      githubApiSocket: true,
      executionId,
      materialDir: store.executionLayout(sessionId, executionId).executionDir,
      verifyHandle: (provider, handle) => active && provider === "github" && handle === "otrh_fixture",
      openStream: fixture.openStream,
      logger: { debug() {}, warn() {} },
    });
    try {
      const legacy = await legacyGit(fixture.env);
      await checkLegacyTls(context, root, legacy);
      const layout = store.executionLayout(sessionId, executionId);
      const routing = buildRuntimeProxyEnvironment({
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
        environment: routing,
        githubApiSocketPath: adapter.githubApiSocketPath,
        githubGitSocketPath: adapter.githubGitSocketPath,
      });
      const env = Object.fromEntries(
        Object.entries({ ...fixture.env, ...routing }).filter(([, value]) => value !== undefined),
      );
      const config = await readFile(layout.gitConfigPath, "utf8");
      expect(config).toContain(`socks5h://localhost${adapter.githubGitSocketPath}`);
      expect((await stat(adapter.githubGitSocketPath as string)).mode & 0o777).toBe(0o600);
      const sandboxed = !!codex && process.platform === "darwin";
      if (sandboxed) {
        const home = join(root, "codex-home");
        await mkdir(home);
        env.CODEX_HOME = home;
        const config = codexSocketPermissions(
          [adapter.githubApiSocketPath as string, adapter.githubGitSocketPath as string],
          { cwd: root },
          policy,
        ) as { permissions: Record<string, { filesystem: Record<string, string> }> };
        const profile = config.permissions[CODEX_EXECUTION_PERMISSIONS];
        if (!profile) throw Error("Missing execution profile");
        profile.filesystem[await realpath(layout.executionDir)] = "read";
        const wire = new CodexAppServerProcess({ command: codex as string, cwd: root, env });
        try {
          await wire.initialize("0.0.1-test");
          const loaded = (await wire.request("thread/start", {
            cwd: root,
            ephemeral: true,
            approvalPolicy: "on-request",
            permissions: CODEX_EXECUTION_PERMISSIONS,
            config,
          })) as { activePermissionProfile?: { id: string } };
          expect(loaded.activePermissionProfile?.id).toBe(CODEX_EXECUTION_PERMISSIONS);
        } finally {
          await wire.close();
        }
        await writeFile(
          join(home, "config.toml"),
          `features={network_proxy=true}\npermissions=${toml(config.permissions)}\n`,
        );
      }
      const execute = (command: string, args: string[], cwd = root, patch = {}) =>
        run(
          sandboxed ? (codex as string) : command,
          sandboxed ? ["sandbox", "--permission-profile", CODEX_EXECUTION_PERMISSIONS, "--", command, ...args] : args,
          { cwd, env: { ...env, ...patch }, timeout: 20000 },
        );
      const git = async (args: string[], cwd = root, patch = {}) =>
        (await execute(join(store.shimDir(sessionId), "git"), args, cwd, patch)).stdout.trim();
      const url = "https://github.com/team/fixture.git",
        checkout = join(root, "checkout");
      if (legacy && sandboxed) {
        await expect(git(["ls-remote", url])).rejects.toBeDefined();
        expect(fixture.requests).toEqual([]);
        return;
      }
      expect(await git(["ls-remote", url])).toContain("refs/heads/main");
      await git(["clone", url, checkout]);
      expect(await git(["config", "--get", "remote.origin.url"], checkout)).toBe(url);
      expect(await readFile(join(checkout, "file.txt"), "utf8")).toBe(fixture.initial);
      await git(["checkout", "-b", "opentag/task"], checkout);
      await writeFile(join(checkout, "file.txt"), "updated\n");
      await git(["commit", "-am", "preserve metadata"], checkout);
      const raw = await git(["cat-file", "commit", "HEAD"], checkout);
      expect(raw).toContain("author Original Author <author@example.invalid>");
      expect(raw).toContain("committer Original Committer <committer@example.invalid>");
      await git(["push", "origin", "HEAD"], checkout);
      const sha = await git(["rev-parse", "HEAD"], checkout);
      expect(await fixture.git(fixture.repository, ["rev-parse", "opentag/task"])).toBe(sha);
      expect(await fixture.git(fixture.repository, ["cat-file", "commit", sha])).toBe(raw);
      await git(["fetch", "origin"], checkout);
      expect(fixture.requests.some((path) => path.endsWith("git-upload-pack"))).toBe(true);
      expect(fixture.requests.some((path) => path.endsWith("git-receive-pack"))).toBe(true);
      const hits = fixture.requests.length;
      await expect(
        git([
          "-c",
          `http.https://foreign.invalid.proxy=${foreignProxy(legacy, adapter)}`,
          "ls-remote",
          "https://foreign.invalid/team/fixture.git",
        ]),
      ).rejects.toBeDefined();
      const helper = await readFile(layout.gitCredentialHelperPath, "utf8");
      await writeFile(layout.gitCredentialHelperPath, helper.replaceAll("otrh_fixture", "otrh_wrong"));
      await expect(git(["ls-remote", url])).rejects.toBeDefined();
      await writeFile(layout.gitCredentialHelperPath, helper);
      expect(fixture.requests).toHaveLength(hits);
      if (sandboxed) {
        // Exact Unix grants do not authorize another execution or even the existing loopback proxy.
        await expect(
          git(["-c", `http.http://github.com.proxy=${adapter.connectProxyUrl}`, "ls-remote", url]),
        ).rejects.toBeDefined();
        await expect(git(["ls-remote", "https://github.com:443/team/fixture.git"])).rejects.toBeDefined();
        let foreignHits = 0;
        const foreign = await RuntimeProxyLoopbackAdapter.start({
          githubApiSocket: true,
          executionId: randomUUID(),
          materialDir: join(root, "foreign"),
          verifyHandle: () => true,
          openStream: async () => {
            foreignHits++;
            throw Error("Foreign socket reached");
          },
          logger: { debug() {}, warn() {} },
        });
        try {
          await expect(
            git([
              "-c",
              `http.http://github.com.proxy=socks5h://localhost${foreign.githubGitSocketPath}`,
              "ls-remote",
              url,
            ]),
          ).rejects.toBeDefined();
          expect(foreignHits).toBe(0);
        } finally {
          await foreign.close();
        }
        await expect(execute("sh", ["-c", 'echo overwritten > "$GIT_CONFIG_GLOBAL"'])).rejects.toBeDefined();
        expect(fixture.requests).toHaveLength(hits);
      }
      active = false;
      await expect(git(["ls-remote", url])).rejects.toBeDefined();
      expect(fixture.requests).toHaveLength(hits);
      expect(await readFile(layout.gitConfigPath, "utf8")).toBe(config);
      await adapter.close();
      await expect(stat(adapter.githubGitSocketPath as string)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(git(["ls-remote", url])).rejects.toBeDefined();
    } finally {
      await adapter.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 120000);
});

describe.skipIf(process.platform !== "linux")("native Git Cloud published transport", () => {
  it("clones, fetches and pushes through the generated entry without publishing parent sockets", async () => {
    const root = await mkdtemp(join(tmpdir(), "ot-cloud-git-"));
    const fixture = await nativeGitFixture(root);
    const resources = createBridgeSocketResources(),
      executionId = randomUUID();
    const adapter = await RuntimeProxyLoopbackAdapter.start({
      githubApiSocket: true,
      executionId,
      materialDir: join(root, "private"),
      verifyHandle: (provider, handle) => provider === "github" && handle === "otrh_fixture",
      openStream: fixture.openStream,
      logger: { debug() {}, warn() {} },
    });
    const relay = {
      executionId,
      contextTreeExecution: true,
      providers: [{ provider: "github" }],
      localHandleFor: () => "otrh_fixture",
      cliMetadataFor: () => undefined,
    } as unknown as RuntimeCredentialRelay;
    try {
      const published = join(root, "public");
      await publishExecutionMaterial({ adapter, relay }, published, {
        includeEntryPrograms: true,
        publicMountPath: published,
      });
      await listenBridgeProxySockets(resources, adapter, published);
      const originalGitConfig = await readFile(join(published, "gitconfig"), "utf8");
      const entry = await cloudEntryFixture(published, root);
      const path = join(published, "fixture-entry.mjs");
      await writeFile(path, entry, { mode: 0o444 });
      const identity = process.getuid?.() === 0 ? { uid: 65534, gid: 65534 } : {};
      if (process.getuid?.() === 0) await chown(root, 65534, 65534);
      await run(
        process.execPath,
        [
          path,
          "sh",
          "-ec",
          'PATH="$1:$PATH"; export PATH; test ! -w "$GIT_CONFIG_GLOBAL"; GIT_SSL_CAINFO=/untrusted/injected.pem; export GIT_SSL_CAINFO; git clone https://github.com/team/fixture.git checkout; cd checkout; git config user.name "Original Committer"; git config user.email committer@example.invalid; git checkout -b opentag/cloud; echo cloud >> file.txt; git commit --author="Original Author <author@example.invalid>" -am cloud; git push origin HEAD; git fetch origin',
          "fixture",
          join(published, "bin"),
        ],
        { cwd: root, env: fixture.env, ...identity, timeout: 30000 },
      );
      const sha = await fixture.git(fixture.repository, ["rev-parse", "opentag/cloud"]);
      const raw = (
        await run("git", ["cat-file", "commit", "HEAD"], { cwd: join(root, "checkout"), env: fixture.env, ...identity })
      ).stdout.trim();
      expect(await fixture.git(fixture.repository, ["cat-file", "commit", sha])).toBe(raw);
      expect(raw).toContain("author Original Author <author@example.invalid>");
      expect(raw).toContain("committer Original Committer <committer@example.invalid>");
      expect(await readFile(join(published, "gitconfig"), "utf8")).toBe(originalGitConfig);
      for (const filename of ["gitconfig", "environment.json"]) {
        const material = await readFile(join(published, filename), "utf8");
        expect(material).not.toContain(adapter.githubGitSocketPath);
        expect(material).not.toContain("socks5h:");
        expect(material).not.toContain(join(root, "private"));
      }
    } finally {
      await closeBridgeSockets(resources);
      await adapter.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 60000);
});
