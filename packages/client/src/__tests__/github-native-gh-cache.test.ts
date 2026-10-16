import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { CODEX_EXECUTION_PERMISSIONS, codexSocketPermissions } from "../providers/codex/socket-permissions.js";
import { RuntimeProxyLoopbackAdapter } from "../runtime/runtime-proxy-loopback-adapter.js";
import { buildRuntimeProxyEnvironment, RuntimeProxyMaterialStore } from "../runtime/runtime-proxy-material.js";
import { nativeGhLogsResponse } from "./support/native-gh-logs-fixture.js";

const binary = process.env.OPENTAG_TEST_GH_BINARY;
const codex = process.platform === "darwin" ? process.env.OPENTAG_TEST_CODEX_BINARY : undefined;
const run = promisify(execFile);

describe.skipIf(!binary)("native gh Local cache through the published launcher", () => {
  it.each([false, true])(
    "keeps native logs in the execution cache, including TMPDIR fallback=%s",
    async (fallback) => {
      const root = await realpath(await mkdtemp(join(tmpdir(), "ot-gh-cache-")));
      const home = join(root, "readonly-home");
      const workspace = join(root, "workspace");
      const realBin = join(root, "real-bin");
      const codexHome = join(root, "codex-home");
      for (const directory of [home, workspace, realBin, codexHome]) await mkdir(directory);
      await symlink(binary as string, join(realBin, "gh"));
      const store = new RuntimeProxyMaterialStore({ home: root });
      const sessionId = randomUUID();
      const downloads: string[] = [];
      let adapter: RuntimeProxyLoopbackAdapter | undefined;
      let previousCache: string | undefined;
      const cacheDirectories: string[] = [];
      try {
        // A second execution in the same Session must use its new temporary directory.
        for (let turn = 0; turn < 2; turn++) {
          const executionId = randomUUID();
          adapter = await startCacheAdapter(
            root,
            store.executionLayout(sessionId, executionId).executionDir,
            executionId,
            downloads,
            fallback,
          );
          const socketPath = adapter.githubApiSocketPath as string;
          if (fallback) expect(socketPath).toMatch(/^\/tmp\/ot-gh-/);
          const cache = join(dirname(socketPath), "cache");
          cacheDirectories.push(cache);
          expect(cache).not.toBe(previousCache);
          const environment = buildRuntimeProxyEnvironment({
            executionId,
            layout: store.executionLayout(sessionId, executionId),
            adapterCaCertPath: adapter.caCertPath,
            connectProxyUrl: adapter.connectProxyUrl,
            handles: new Map([["github", "otrh_cache_fixture"]]),
            cliMetadata: () => undefined,
            slackApiHost: adapter.slackApiHost,
          });
          await store.publish({
            sessionId,
            executionId,
            platform: process.platform,
            adapterCaCertPath: adapter.caCertPath,
            handles: new Map([["github", "otrh_cache_fixture"]]),
            environment,
            githubApiSocketPath: socketPath,
          });
          expect(environment).not.toHaveProperty("XDG_CACHE_HOME");
          expect(await readFile(store.manifestPath(sessionId), "utf8")).not.toContain("CACHE_HOME");
          const configDir = String(environment.GH_CONFIG_DIR);
          const config = await readFile(join(configDir, "config.yml"), "utf8");
          const env = {
            HOME: home,
            CODEX_HOME: codexHome,
            PATH: `${store.shimDir(sessionId)}:${realBin}:${dirname(process.execPath)}:/usr/bin:/bin`,
            ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
          };
          const shim = join(store.shimDir(sessionId), "gh");
          const args = ["run", "view", "7", "-R", "team/fixture", "--log"];
          const commands = await sandboxCommand(codexHome, workspace, home, configDir, socketPath);
          await assertNativeLogs(commands, shim, args, env, [workspace, join(workspace, `nested-${turn}`)]);
          expect(downloads).toHaveLength(turn + 1);
          expect(await readdir(join(cache, "gh"))).toEqual([expect.stringMatching(/^run-log-7-.*\.zip$/)]);
          expect(await readFile(join(configDir, "config.yml"), "utf8")).toBe(config);
          // Newer gh may write best-effort state under .local on unsandboxed Linux.
          // Its log cache must still stay outside HOME; macOS also checks denied HOME writes.
          expect(await readdir(home)).not.toContain(".cache");
          expect(await readdir(workspace)).not.toContain(".cache");
          await assertReadOnly(commands, env, workspace, [join(home, "forbidden"), join(configDir, "config.yml")]);
          await adapter.close();
          await store.cleanupExecution(sessionId, executionId);
          await expect(stat(cache)).rejects.toMatchObject({ code: "ENOENT" });
          await expect(run(shim, args, { env, cwd: workspace, timeout: 10000 })).rejects.toBeDefined();
          await expect(stat(cache)).rejects.toMatchObject({ code: "ENOENT" });
          previousCache = cache;
        }
      } finally {
        vi.unstubAllEnvs();
        await adapter?.close();
        await store.cleanupSession(sessionId);
        await rm(root, { recursive: true, force: true });
      }
      for (const cache of cacheDirectories) await expect(stat(cache)).rejects.toMatchObject({ code: "ENOENT" });
    },
    60000,
  );
});

async function assertNativeLogs(
  commands: { file?: string; args: string[] },
  shim: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  directories: string[],
) {
  for (const cwd of directories) {
    await mkdir(cwd, { recursive: true });
    const result = await run(commands.file ?? shim, [...commands.args, ...(commands.file ? [shim] : []), ...args], {
      cwd,
      env,
      timeout: 15000,
    });
    expect(result.stdout).toContain("native-gh-cache-ok");
  }
}

async function startCacheAdapter(
  root: string,
  materialDir: string,
  executionId: string,
  downloads: string[],
  fallback: boolean,
) {
  if (fallback) vi.stubEnv("TMPDIR", join(root, "x".repeat(120)));
  try {
    return await RuntimeProxyLoopbackAdapter.start({
      githubApiSocket: true,
      executionId,
      materialDir,
      verifyHandle: (provider, handle) => provider === "github" && handle === "otrh_cache_fixture",
      openStream: async (request) => {
        if (request.path.endsWith("/runs/7/logs")) downloads.push(request.path);
        const response = nativeGhLogsResponse(request.path);
        if (!response) throw new Error(`Unexpected fixture path: ${request.path}`);
        return response;
      },
      logger: { debug() {}, warn() {} },
    });
  } finally {
    vi.unstubAllEnvs();
  }
}

async function assertReadOnly(
  commands: { file?: string; args: string[] },
  env: NodeJS.ProcessEnv,
  cwd: string,
  paths: string[],
) {
  if (!commands.file) return;
  for (const path of paths) {
    await expect(
      run(commands.file, [...commands.args, "/bin/sh", "-c", 'printf bad >> "$1"', "check", path], {
        cwd,
        env,
        timeout: 10000,
      }),
    ).rejects.toBeDefined();
  }
}

async function sandboxCommand(
  codexHome: string,
  workspace: string,
  home: string,
  config: string,
  socket: string,
): Promise<{ file?: string; args: string[] }> {
  if (codex) {
    const settings = codexSocketPermissions(
      [socket],
      { cwd: workspace },
      {
        fileSystem: "workspace-write",
        network: "disabled",
        approvals: "on-request",
        tools: { mode: "provider-default" },
      },
    ) as { permissions: Record<string, { filesystem: Record<string, string> }> };
    const profile = settings.permissions[CODEX_EXECUTION_PERMISSIONS];
    if (!profile) throw new Error("Missing native Codex profile");
    profile.filesystem[home] = "read";
    profile.filesystem[config] = "read";
    await writeFile(
      join(codexHome, "config.toml"),
      `features={network_proxy=true}\npermissions=${toml(settings.permissions)}\n`,
    );
    return { file: codex, args: ["sandbox", "--permission-profile", CODEX_EXECUTION_PERMISSIONS, "--"] };
  }
  if (process.platform === "darwin") {
    return {
      file: "/usr/bin/sandbox-exec",
      args: [
        "-p",
        `(version 1)(allow default)(deny file-write* (subpath ${JSON.stringify(home)}) (subpath ${JSON.stringify(config)}))`,
      ],
    };
  }
  return { args: [] };
}

function toml(value: unknown): string {
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .map(([key, item]) => `${JSON.stringify(key)}=${toml(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
