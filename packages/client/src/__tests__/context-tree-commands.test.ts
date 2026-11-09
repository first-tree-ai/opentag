import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { contextTreeSelector } from "@opentag/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CONTEXT_TREE_COMMAND_WORKER_SOURCE } from "../runner/context-tree-command-worker.js";
import { resolveContextTreePackage, runContextTreeCli } from "../runtime/context-tree.js";
import {
  CONTEXT_TREE_COMMAND_CLIENT_SOURCE,
  ContextTreeCommandGateway,
  requestContextTreeCommand,
} from "../runtime/context-tree-commands.js";
import { configureContextTrees } from "../runtime/context-tree-connections.js";
import type { RuntimeCredentialRelay } from "../runtime/runtime-credential-relay.js";

const executeFile = promisify(execFile);
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const source = { kind: "git", repository: "acme/project", path: "docs", ref: "main" } as const;
function parent() {
  const controller = new AbortController();
  const close = vi.fn(async () => undefined);
  const child = { localHandleFor: () => "tree-local-handle", close };
  const openContextTree = vi.fn(async () => child);
  return {
    controller,
    close,
    openContextTree,
    relay: { signal: controller.signal, openContextTree } as unknown as RuntimeCredentialRelay,
  };
}
async function directory() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ot-tree-command-test-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return root;
}

describe("Context Tree command boundary", () => {
  it("returns a TIMEOUT result when a managed sync request is aborted", async () => {
    const root = await directory();
    const owner = parent();
    let started!: () => void;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gateway = new ContextTreeCommandGateway({
      parent: owner.relay,
      sources: [source],
      workspace: root,
      stateDirectory: join(root, "private"),
      environment: () => ({}),
      execute: async (_args, _environment, signal) => {
        started();
        return new Promise<never>((_, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
    });
    await gateway.listen("tcp");
    cleanups.push(() => gateway.close());
    const controller = new AbortController();
    const result = runContextTreeCli({ root, cliPath: "unused", skillsPath: root }, ["sync"], {
      env: { OPENTAG_CONTEXT_TREE_URL: `http://127.0.0.1:${gateway.port}` },
      signal: controller.signal,
    });
    const checked = expect(result).resolves.toEqual({ payload: undefined, failureCode: "TIMEOUT" });
    await running;
    controller.abort();
    await checked;
  });

  it.each(["internal", "visible"])("preserves standalone commands in a legacy %s Session", async (kind) => {
    const root = await directory();
    const client = join(root, "client.mjs");
    const cli = join(root, "standalone.mjs");
    await writeFile(client, CONTEXT_TREE_COMMAND_CLIENT_SOURCE);
    await writeFile(cli, "process.stdout.write(process.argv.slice(2).join(' '));");
    const environment = {
      HOME: root,
      OPENTAG_HOME: root,
      ...(kind === "visible" ? { OPENTAG_PROVIDER_ENV_FILE: join(root, "provider.sh") } : {}),
    };
    for (const args of [
      ["sync", "--offline"],
      ["write", "prepare"],
      ["write", "finish", "retained-session"],
      ["write", "abort", "retained-session"],
    ]) {
      expect((await executeFile(process.execPath, [client, cli, ...args], { env: environment })).stdout).toBe(
        args.join(" "),
      );
    }
  });

  it.each(["absent", "missing", "invalid", "empty"])(
    "does not invoke the standalone CLI in proxy mode with manifest state %s",
    async (manifestState) => {
      const root = await directory();
      const client = join(root, "client.mjs");
      const cli = join(root, "standalone.mjs");
      const marker = join(root, "invoked");
      const manifest = join(root, "current.json");
      await writeFile(client, CONTEXT_TREE_COMMAND_CLIENT_SOURCE);
      await writeFile(
        cli,
        `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'invoked');`,
      );
      if (manifestState === "invalid") await writeFile(manifest, "not JSON");
      if (manifestState === "empty") await writeFile(manifest, JSON.stringify({ environment: {} }));
      for (const args of [
        ["sync", "--offline"],
        ["write", "prepare"],
      ])
        await expect(
          executeFile(process.execPath, [client, cli, ...args], {
            env: {
              OPENTAG_CONTEXT_TREE_MANAGED: "1",
              ...(manifestState === "absent" ? {} : { OPENTAG_CONTEXT_TREE_MANIFEST: manifest }),
            },
          }),
        ).rejects.toMatchObject({ stderr: expect.stringContaining("Context Tree execution unavailable") });
      await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("keeps local reads and verification available during proxy routing loss", async () => {
    const root = await directory();
    const client = join(root, "client.mjs");
    const cli = join(root, "standalone.mjs");
    await writeFile(client, CONTEXT_TREE_COMMAND_CLIENT_SOURCE);
    await writeFile(cli, "process.stdout.write(process.argv.slice(2).join(' '));");
    for (const command of ["read", "verify"])
      expect(
        (
          await executeFile(process.execPath, [client, cli, command], {
            env: { OPENTAG_CONTEXT_TREE_MANAGED: "1", OPENTAG_CONTEXT_TREE_MANIFEST: join(root, "missing.json") },
          })
        ).stdout,
      ).toBe(command);
    for (const args of [
      ["sync", "--offline"],
      ["write", "prepare"],
    ])
      expect((await executeFile(process.execPath, [client, cli, ...args], { env: {} })).stdout).toBe(args.join(" "));
    await expect(
      executeFile(process.execPath, [client, cli, "sync"], {
        env: { OPENTAG_CONTEXT_TREE_MANIFEST: join(root, "missing.json") },
      }),
    ).rejects.toMatchObject({ stderr: expect.stringContaining("Context Tree execution unavailable") });
  });

  it("rejects arbitrary commands, foreign projects and ambiguous selectors before obtaining credentials", async () => {
    const root = await directory();
    const owner = parent();
    const execute = vi.fn();
    const gateway = new ContextTreeCommandGateway({
      parent: owner.relay,
      sources: [source],
      workspace: root,
      stateDirectory: join(root, "state"),
      environment: () => ({}),
      execute,
    });
    for (const args of [
      ["git", "push"],
      ["connect", "other/repo"],
      ["sync", "--project-path", "/foreign"],
      ["sync", "--tree", "foreign/repo"],
      ["write", "finish", "../session"],
    ])
      await expect(gateway.run(args)).rejects.toThrow();
    expect(owner.openContextTree).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("issues a credential only for the selected CLI child and closes it after failure", async () => {
    const root = await directory();
    const owner = parent();
    const execute = vi.fn(
      async (_args: readonly string[], environment: Readonly<Record<string, string | undefined>>) => {
        expect(environment.GH_TOKEN).toBe("tree-local-handle");
        expect(environment.OPENTAG_CONTEXT_TREE_SOCKET).toBeUndefined();
        expect(environment.GITHUB_TOKEN).toBeUndefined();
        throw new Error("interrupted");
      },
    );
    const gateway = new ContextTreeCommandGateway({
      parent: owner.relay,
      sources: [source],
      workspace: root,
      stateDirectory: join(root, "state"),
      environment: () => ({ OPENTAG_CONTEXT_TREE_SOCKET: "parent.sock", GITHUB_TOKEN: "ambient" }),
      execute,
    });
    await expect(gateway.run(["sync"])).rejects.toThrow("interrupted");
    expect(owner.openContextTree).toHaveBeenCalledWith(source, expect.any(AbortSignal));
    expect(owner.close).toHaveBeenCalledOnce();
    expect(gateway.relayFor("github")).toBeUndefined();
    owner.controller.abort();
    await expect(gateway.run(["sync"])).rejects.toThrow("unavailable");
  });

  it.each(["caller", "parent", "close"])(
    "cancels the private CLI on %s loss and releases the child",
    async (reason) => {
      const root = await directory();
      const owner = parent();
      const caller = new AbortController();
      let started!: () => void;
      const ready = new Promise<void>((done) => {
        started = done;
      });
      const gateway = new ContextTreeCommandGateway({
        parent: owner.relay,
        workspace: root,
        sources: [source],
        stateDirectory: join(root, "state"),
        environment: () => ({}),
        execute: async (_args, _environment, signal) => {
          started();
          await new Promise<void>((_done, reject) =>
            signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }),
          );
          return { code: 0, stdout: "{}", stderr: "" };
        },
      });
      const operation = gateway.run(["sync"], caller.signal);
      const rejected = expect(operation).rejects.toThrow("cancelled");
      await ready;
      if (reason === "caller") caller.abort();
      if (reason === "parent") owner.controller.abort();
      if (reason === "close") await gateway.close();
      await rejected;
      expect(owner.close).toHaveBeenCalledOnce();
      await gateway.close();
    },
  );

  describe("multi-source sync", () => {
    const sources = [source, { ...source, path: "notes" }, { ...source, path: "plans" }] as const;
    function multiParent() {
      const controller = new AbortController();
      const children = sources.map((entry) => {
        const handle = `handle-${entry.path}`;
        return {
          handle,
          localHandleFor: () => handle,
          verifyLocalHandle: (_provider: string, candidate: string) => candidate === handle,
          close: vi.fn(async () => undefined),
        };
      });
      const openContextTree = vi.fn(
        async (entry: (typeof sources)[number]) => children[sources.findIndex((item) => item.path === entry.path)],
      );
      return {
        children,
        relay: { signal: controller.signal, openContextTree } as unknown as RuntimeCredentialRelay,
      };
    }
    function deferred() {
      let resolve!: (value: { code: number; stdout: string; stderr: string }) => void;
      const promise = new Promise<{ code: number; stdout: string; stderr: string }>((done) => {
        resolve = done;
      });
      return { promise, resolve };
    }
    const syncOutput = (path: string) =>
      JSON.stringify({ schemaVersion: 3, connections: [{ ok: true, treeRoot: `/snapshots/${path}` }] });

    it("runs one credentialed child per source concurrently and keeps source order", async () => {
      const root = await directory();
      const owner = multiParent();
      const pending = new Map<string, ReturnType<typeof deferred>>();
      const gateway = new ContextTreeCommandGateway({
        parent: owner.relay,
        sources,
        workspace: root,
        stateDirectory: join(root, "state"),
        environment: () => ({}),
        execute: async (_args, environment) => {
          const result = deferred();
          pending.set(environment.GH_TOKEN ?? "", result);
          return result.promise;
        },
      });
      const operation = gateway.run(["sync"]);
      // Every child starts before any finishes.
      await vi.waitFor(() => expect(pending.size).toBe(sources.length));
      for (const child of owner.children) expect(gateway.relayFor("github", child.handle)).toBe(child);
      expect(gateway.relayFor("github")).toBeUndefined();
      expect(gateway.relayFor("github", "foreign-handle")).toBeUndefined();
      for (const entry of [...sources].reverse()) {
        pending.get(`handle-${entry.path}`)?.resolve({ code: 0, stdout: syncOutput(entry.path), stderr: "" });
        await new Promise((done) => setTimeout(done, 1));
      }
      const result = await operation;
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        schemaVersion: 3,
        connections: sources.map((entry) => ({ ok: true, treeRoot: `/snapshots/${entry.path}` })),
      });
      for (const child of owner.children) expect(child.close).toHaveBeenCalledOnce();
      expect(gateway.relayFor("github", owner.children[0]?.handle)).toBeUndefined();
    });

    it("returns the first failing source in source order after every child settles", async () => {
      const root = await directory();
      const owner = multiParent();
      const gateway = new ContextTreeCommandGateway({
        parent: owner.relay,
        sources,
        workspace: root,
        stateDirectory: join(root, "state"),
        environment: () => ({}),
        execute: async (_args, environment) => {
          const path = (environment.GH_TOKEN ?? "").replace("handle-", "");
          // The later source fails first; the earlier source's failure still decides the result.
          if (path === "notes") {
            await new Promise((done) => setTimeout(done, 20));
            return { code: 1, stdout: "{}", stderr: "notes failed" };
          }
          if (path === "plans") return { code: 1, stdout: "{}", stderr: "plans failed" };
          return { code: 0, stdout: syncOutput(path), stderr: "" };
        },
      });
      await expect(gateway.run(["sync"])).resolves.toEqual({ code: 1, stdout: "{}", stderr: "notes failed" });
      for (const child of owner.children) expect(child.close).toHaveBeenCalledOnce();
    });

    it("stops sibling children when one child throws and reports that failure", async () => {
      const root = await directory();
      const owner = multiParent();
      const gateway = new ContextTreeCommandGateway({
        parent: owner.relay,
        sources,
        workspace: root,
        stateDirectory: join(root, "state"),
        environment: () => ({}),
        execute: async (_args, environment, signal) => {
          if (environment.GH_TOKEN === "handle-plans") throw new Error("plans crashed");
          return new Promise<never>((_done, reject) =>
            signal.addEventListener("abort", () => reject(new Error("sibling aborted")), { once: true }),
          );
        },
      });
      await expect(gateway.run(["sync"])).rejects.toThrow("plans crashed");
      for (const child of owner.children) expect(child.close).toHaveBeenCalledOnce();
    });
  });

  it("bounds concurrent operations and does not replay a failed write", async () => {
    const root = await directory();
    const owner = parent();
    let release!: () => void;
    const execute = vi.fn(async () => {
      await new Promise<void>((done) => {
        release = done;
      });
      return { code: 1, stdout: "{}", stderr: "unknown" };
    });
    const gateway = new ContextTreeCommandGateway({
      parent: owner.relay,
      sources: [source],
      workspace: root,
      stateDirectory: join(root, "state"),
      environment: () => ({}),
      execute,
    });
    const first = gateway.run(["sync"]);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    await expect(gateway.run(["sync"])).rejects.toThrow("unavailable");
    release();
    await first;
    expect(execute).toHaveBeenCalledOnce();
  });

  it("aborts in-flight gateway command when the HTTP client times out and recovers offline", async () => {
    const root = await directory();
    const pack = resolveContextTreePackage();
    if (!pack) throw new Error("Missing pinned CLI");
    const owner = parent();
    const calls: string[][] = [];
    let abortedOnline = false;
    const gateway = new ContextTreeCommandGateway({
      parent: owner.relay,
      sources: [source],
      workspace: root,
      stateDirectory: join(root, "state"),
      environment: () => ({}),
      execute: async (args, _environment, signal) => {
        calls.push([...args]);
        if (!args.includes("--offline")) {
          await new Promise<void>((resolve) => {
            signal.addEventListener(
              "abort",
              () => {
                abortedOnline = true;
                resolve();
              },
              { once: true },
            );
          });
          throw new Error("aborted online sync");
        }
        return {
          code: 0,
          stdout: JSON.stringify({ schemaVersion: 3, connections: [] }),
          stderr: "",
        };
      },
    });
    await gateway.listen("tcp");
    cleanups.push(() => gateway.close());
    const env = { OPENTAG_CONTEXT_TREE_URL: `http://127.0.0.1:${gateway.port}` };
    const timedOut = await runContextTreeCli(pack, ["sync"], {
      cwd: root,
      env,
      signal: AbortSignal.timeout(20),
    });
    expect(timedOut).toEqual({ payload: undefined, failureCode: "TIMEOUT" });
    const offline = await runContextTreeCli(pack, ["sync", "--offline"], {
      cwd: root,
      env,
      signal: AbortSignal.timeout(2_000),
    });
    expect(abortedOnline).toBe(true);
    expect(offline).toEqual({ payload: { schemaVersion: 3, connections: [] } });
    expect(calls).toHaveLength(2);
    expect(calls[0]).not.toContain("--offline");
    expect(calls[1]).toContain("--offline");
  });

  it.each(["fresh", "warm"])(
    "syncs two directories of one repository concurrently with the pinned CLI from a %s home",
    async (home) => {
      const root = await directory();
      const pack = resolveContextTreePackage();
      if (!pack) throw new Error("Missing pinned CLI");
      const environment = {
        HOME: root,
        PATH: process.env.PATH,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@example.test",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@example.test",
      };
      const git = async (...args: string[]) => (await executeFile("git", args, { env: environment })).stdout.trim();
      const seed = join(root, "seed");
      await mkdir(seed);
      await git("init", "--initial-branch=main", seed);
      for (const tree of ["docs", "notes"])
        await runContextTreeCli(pack, ["init", join(seed, tree), "--project-path", seed, "--json"], {
          env: environment,
        });
      await git("-C", seed, "add", ".");
      await git("-C", seed, "commit", "-m", "init");
      const remote = join(root, "remote.git");
      await git("clone", "--bare", seed, remote);
      const bin = join(root, "bin");
      await mkdir(bin);
      // Every git call inside the shared bare cache, and its initial clone, runs under the repository
      // lock; slowing them makes the two children hold and wait for that one lock at the same time.
      await writeFile(
        join(bin, "git"),
        `#!/bin/sh\ncase "$PWD" in */repositories/*.git) sleep 1;; esac\ncase " $* " in *" clone "*) sleep 1;; esac\nexec /usr/bin/git -c protocol.file.allow=always -c 'url.file://${remote}.insteadOf=https://github.com/acme/project.git' "$@"\n`,
        { mode: 0o700 },
      );
      environment.PATH = `${bin}:${environment.PATH}`;
      const sources = [source, { ...source, path: "notes" }] as const;
      const workspace = join(root, "workspace");
      await mkdir(workspace);
      const projectPath = await configureContextTrees(workspace, sources);
      if (home === "warm") {
        // Warm the shared repository cache with one source, as an earlier task boundary would.
        const warm = await runContextTreeCli(
          pack,
          ["sync", "--project-path", projectPath, "--tree", contextTreeSelector(source)],
          { env: environment, network: true },
        );
        expect(warm.failureCode).toBeUndefined();
      }
      const owner = parent();
      const gateway = new ContextTreeCommandGateway({
        parent: owner.relay,
        sources,
        workspace,
        stateDirectory: join(root, "routing"),
        environment: () => environment,
        execute: async (args, privateEnvironment, signal) => {
          const result = await runContextTreeCli(pack, args, {
            cwd: workspace,
            network: true,
            env: { ...environment, ...privateEnvironment },
            signal,
          });
          return { code: result.failureCode ? 1 : 0, stdout: JSON.stringify(result.payload), stderr: "" };
        },
      });
      await gateway.listen("socket");
      cleanups.push(() => gateway.close());
      const synced = await requestContextTreeCommand({ socketPath: gateway.socketPath }, ["sync"]);
      expect(synced.code, synced.stdout).toBe(0);
      const { connections } = JSON.parse(synced.stdout) as { connections: { ok: boolean; treeRoot: string }[] };
      expect(
        connections.map((entry) => entry.ok),
        synced.stdout,
      ).toEqual([true, true]);
      expect(connections[0]?.treeRoot).toMatch(/docs$/);
      expect(connections[1]?.treeRoot).toMatch(/notes$/);
      expect(owner.openContextTree).toHaveBeenCalledTimes(2);
    },
    60_000,
  );

  it.each(["local", "cloud"])(
    "runs real CLI sync and publication through the %s worker, including a later execution",
    async (mode) => {
      const root = await directory();
      const pack = resolveContextTreePackage();
      if (!pack) throw new Error("Missing pinned CLI");
      const environment = {
        HOME: root,
        PATH: process.env.PATH,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@example.test",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@example.test",
      };
      const git = async (...args: string[]) => (await executeFile("git", args, { env: environment })).stdout.trim();
      const seed = join(root, "seed");
      await mkdir(seed);
      await git("init", "--initial-branch=main", seed);
      await runContextTreeCli(pack, ["init", join(seed, "docs"), "--project-path", seed, "--json"], {
        env: environment,
      });
      await git("-C", seed, "add", ".");
      await git("-C", seed, "commit", "-m", "init");
      const remote = join(root, "remote.git");
      await git("clone", "--bare", seed, remote);
      const bin = join(root, "bin");
      await mkdir(bin);
      await writeFile(
        join(bin, "git"),
        `#!/bin/sh\nexec /usr/bin/git -c protocol.file.allow=always -c 'url.file://${remote}.insteadOf=https://github.com/acme/project.git' "$@"\n`,
        { mode: 0o700 },
      );
      environment.PATH = `${bin}:${environment.PATH}`;
      const workspace = join(root, "workspace");
      await mkdir(workspace);
      await configureContextTrees(workspace, [source]);
      const owner = parent();
      const makeGateway = () =>
        new ContextTreeCommandGateway({
          parent: owner.relay,
          sources: [source],
          workspace,
          stateDirectory: join(root, "routing"),
          environment: () => environment,
          execute: async (args, privateEnvironment, signal) => {
            if (mode === "cloud") {
              const execution = executeFile(
                process.execPath,
                ["--input-type=module", "-e", CONTEXT_TREE_COMMAND_WORKER_SOURCE],
                { cwd: workspace, signal },
              );
              execution.child.stdin?.end(
                JSON.stringify({ cli: pack.cliPath, args, environment: privateEnvironment, cwd: workspace }),
              );
              return JSON.parse((await execution).stdout);
            }
            const result = await runContextTreeCli(pack, args, {
              cwd: workspace,
              network: true,
              env: { ...environment, ...privateEnvironment },
              signal,
            });
            return { code: result.failureCode ? 1 : 0, stdout: JSON.stringify(result.payload), stderr: "" };
          },
        });
      const gateway = makeGateway();
      await gateway.listen("socket");
      cleanups.push(() => gateway.close());
      const synced = await requestContextTreeCommand({ socketPath: gateway.socketPath }, ["sync"]);
      expect(synced.code).toBe(0);
      const prepared = await gateway.run(["write", "prepare"]);
      const session = JSON.parse(prepared.stdout) as { id: string; treeRoot: string };
      expect(prepared.code, prepared.stdout).toBe(0);
      await writeFile(join(session.treeRoot, "decision.md"), "---\ntitle: Decision\n---\nUse MCP for GitHub.\n");
      expect(await readFile(join(root, "routing", `${session.id}.json`), "utf8")).not.toContain("tree-local-handle");
      await gateway.close();
      const later = makeGateway();
      cleanups.push(() => later.close());
      await later.listen("socket");
      const manifest = join(root, "current.json"),
        client = join(root, "context-tree-client.mjs");
      await writeFile(client, CONTEXT_TREE_COMMAND_CLIENT_SOURCE);
      await writeFile(manifest, JSON.stringify({ environment: { OPENTAG_CONTEXT_TREE_SOCKET: later.socketPath } }));
      const providerEnvironment = {
        ...environment,
        OPENTAG_CONTEXT_TREE_MANAGED: "1",
        OPENTAG_CONTEXT_TREE_SOCKET: gateway.socketPath,
        OPENTAG_CONTEXT_TREE_MANIFEST: manifest,
      };
      const finished = await executeFile(
        process.execPath,
        [client, pack.cliPath, "write", "finish", session.id, "--message", "docs: decision", "--publish"],
        { env: providerEnvironment },
      );
      expect(JSON.parse(finished.stdout).outcome).toBe("published");
      await later.close();
      await rm(manifest);
      await expect(
        executeFile(process.execPath, [client, pack.cliPath, "sync"], { env: providerEnvironment }),
      ).rejects.toMatchObject({ stderr: expect.stringContaining("Context Tree execution unavailable") });
      expect(await git("--git-dir", remote, "show", "main:docs/decision.md")).toContain("Use MCP for GitHub.");
      await expect(readFile(join(root, "routing", `${session.id}.json`))).rejects.toMatchObject({ code: "ENOENT" });
      expect(owner.openContextTree).toHaveBeenCalledTimes(3);
      expect(owner.close).toHaveBeenCalledTimes(3);
    },
    60_000,
  );
});
