import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareCloudContextTree } from "../runner/cloud-context-tree.js";
import { CONTEXT_TREE_COMMAND_WORKER_SOURCE } from "../runner/context-tree-command-worker.js";
import {
  ContextTreeManager,
  type ContextTreePackage,
  resolveContextTreePackage,
  runContextTreeCli,
} from "../runtime/context-tree.js";
import {
  CONTEXT_TREE_COMMAND_CLIENT_SOURCE,
  ContextTreeCommandGateway,
  requestContextTreeCommand,
} from "../runtime/context-tree-commands.js";
import { configureContextTrees } from "../runtime/context-tree-connections.js";
import { type RuntimeCredentialRelay, RuntimeCredentialRelayError } from "../runtime/runtime-credential-relay.js";

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
  const openContextTree = vi.fn(async (_source: unknown, _signal?: AbortSignal, _mode?: string) => child);
  return {
    controller,
    child,
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

async function recoverCachedTree(
  mode: string,
  root: string,
  workspace: string,
  environment: Record<string, string | undefined>,
  pack: ContextTreePackage,
) {
  if (mode === "cloud") {
    return (
      await prepareCloudContextTree(
        {
          workspace,
          contextTrees: [source],
          environment: environment as Record<string, string>,
          path: environment.PATH ?? "",
          scratch: root,
        },
        { contextTreePackage: pack },
      )
    ).status;
  }
  return new ContextTreeManager({
    home: join(root, "host"),
    environment,
    contextTreePackage: pack,
    managedCredentials: true,
    sessionStartBudgetMs: 20_000,
  }).ensureAgent(workspace, "pi", [source], environment);
}

describe("Context Tree command boundary", () => {
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
    expect(gateway.relay).toBeUndefined();
    owner.controller.abort();
    await expect(gateway.run(["sync"])).rejects.toThrow("unavailable");
  });

  it("uses a credential-free environment for offline commands even when GitHub credentials exist", async () => {
    const root = await directory();
    const owner = parent();
    Object.assign(owner.relay, { services: [{ service: "context-tree", scopes: ["context-tree:local"] }] });
    const execute = vi.fn(
      async (_args: readonly string[], environment: Readonly<Record<string, string | undefined>>) => {
        expect(environment).toMatchObject({ HOME: root, GIT_ALLOW_PROTOCOL: "", GIT_CONFIG_NOSYSTEM: "1" });
        for (const key of [
          "GH_TOKEN",
          "GITHUB_TOKEN",
          "SSH_AUTH_SOCK",
          "OPENTAG_PROVIDER_PROXY_URL",
          "GIT_ASKPASS",
          "GIT_CONFIG_PARAMETERS",
        ]) {
          expect(environment[key]).toBeUndefined();
        }
        return { code: 0, stdout: "{}", stderr: "" };
      },
    );
    const gateway = new ContextTreeCommandGateway({
      parent: owner.relay,
      sources: [source],
      workspace: root,
      stateDirectory: join(root, "routing"),
      environment: () => ({
        HOME: root,
        GH_TOKEN: "ambient",
        GITHUB_TOKEN: "ambient",
        SSH_AUTH_SOCK: "agent",
        OPENTAG_PROVIDER_PROXY_URL: "proxy",
        GIT_ASKPASS: "helper",
        GIT_CONFIG_PARAMETERS: "unsafe",
      }),
      execute,
    });
    await gateway.run(["sync", "--offline"]);
    expect(owner.openContextTree).toHaveBeenCalledWith(source, expect.any(AbortSignal), "local");
    expect(owner.close).toHaveBeenCalledOnce();
    await gateway.close();
  });

  it.each(["local", "cancelled-remote"])("does not turn %s rejection into cache permission", async (mode) => {
    const root = await directory();
    const owner = parent();
    Object.assign(owner.relay, { services: [{ service: "context-tree", scopes: ["context-tree:local"] }] });
    owner.openContextTree.mockImplementation(async () => {
      if (mode === "cancelled-remote") owner.controller.abort();
      throw new RuntimeCredentialRelayError("execution_rejected", "Execution unavailable");
    });
    const execute = vi.fn();
    const gateway = new ContextTreeCommandGateway({
      parent: owner.relay,
      sources: [source],
      workspace: root,
      stateDirectory: join(root, "routing"),
      environment: () => ({}),
      execute,
    });
    await expect(gateway.run(mode === "local" ? ["sync", "--offline"] : ["sync"])).rejects.toThrow(
      "Execution unavailable",
    );
    expect(execute).not.toHaveBeenCalled();
    expect(owner.openContextTree).toHaveBeenCalledOnce();
    await gateway.close();
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

  it.each([
    { mode: "local", version: 1 },
    { mode: "cloud", version: 1 },
    { mode: "local", version: 2 },
    { mode: "cloud", version: 2 },
  ])(
    "runs real CLI sync and publication through the $mode v$version worker, including a later execution",
    async ({ mode, version }) => {
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
      environment.HOME = join(workspace, ".opentag", "context-tree", "home");
      await mkdir(environment.HOME, { recursive: true });
      await configureContextTrees(workspace, [source]);
      const owner = parent();
      if (version === 2)
        Object.assign(owner.relay, { services: [{ service: "context-tree", scopes: ["context-tree:local"] }] });
      let localEnvironment: Readonly<Record<string, string | undefined>> | undefined;
      const makeGateway = () =>
        new ContextTreeCommandGateway({
          parent: owner.relay,
          sources: [source],
          workspace,
          stateDirectory: join(root, "routing"),
          environment: () => environment,
          execute: async (args, privateEnvironment, signal) => {
            if (privateEnvironment.GIT_ALLOW_PROTOCOL === "") localEnvironment = privateEnvironment;
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
      if (version === 2) {
        owner.openContextTree.mockImplementation(async (_source, _signal, childMode) => {
          if (childMode === "remote")
            throw new RuntimeCredentialRelayError(
              "execution_rejected",
              "GitHub unavailable",
              "execution_authority_denied",
            );
          return owner.child;
        });
        const recoveryEnvironment = { ...environment, OPENTAG_CONTEXT_TREE_SOCKET: gateway.socketPath as string };
        const recovered = await recoverCachedTree(mode, root, workspace, recoveryEnvironment, pack);
        expect(recovered).toMatchObject({ status: "configured", connections: [{ status: "stale" }] });
        const committed = await gateway.run(["write", "finish", session.id, "--message", "--publish"]);
        expect(JSON.parse(committed.stdout).outcome).toBe("committed");
        expect((await gateway.run(["write", "abort", session.id])).code).toBe(1);
        expect(await readFile(join(root, "routing", `${session.id}.json`), "utf8")).toContain(session.id);
        expect(localEnvironment?.GH_TOKEN).toBeUndefined();
        await expect(
          executeFile("/usr/bin/git", ["ls-remote", `file://${remote}`], { env: localEnvironment }),
        ).rejects.toMatchObject({ stderr: expect.stringContaining("not allowed") });
        expect(await git("--git-dir", remote, "show", "main:docs/decision.md").catch(() => "absent")).toBe("absent");
      }
      owner.openContextTree.mockImplementation(async () => owner.child);
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
        OPENTAG_CONTEXT_TREE_SOCKET: gateway.socketPath,
        OPENTAG_CONTEXT_TREE_MANIFEST: manifest,
      };
      const finished = await executeFile(
        process.execPath,
        [client, pack.cliPath, "write", "finish", session.id, "--message", "docs: decision", "--publish"],
        { env: providerEnvironment },
      );
      expect(JSON.parse(finished.stdout).outcome).toBe("published");
      if (version === 2) {
        const empty = JSON.parse((await later.run(["write", "prepare"])).stdout) as { id: string };
        expect((await later.run(["write", "abort", empty.id])).code).toBe(0);
        await expect(readFile(join(root, "routing", `${empty.id}.json`))).rejects.toMatchObject({ code: "ENOENT" });
      }
      await later.close();
      await rm(manifest);
      await expect(
        executeFile(process.execPath, [client, pack.cliPath, "sync"], { env: providerEnvironment }),
      ).rejects.toMatchObject({ stderr: expect.stringContaining("Context Tree execution unavailable") });
      expect(await git("--git-dir", remote, "show", "main:docs/decision.md")).toContain("Use MCP for GitHub.");
      await expect(readFile(join(root, "routing", `${session.id}.json`))).rejects.toMatchObject({ code: "ENOENT" });
      expect(owner.openContextTree).toHaveBeenCalledTimes(version === 2 ? 9 : 3);
      expect(owner.close).toHaveBeenCalledTimes(version === 2 ? 8 : 3);
    },
    60_000,
  );
});
