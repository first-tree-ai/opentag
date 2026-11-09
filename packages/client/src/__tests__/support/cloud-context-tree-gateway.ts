import { execFile } from "node:child_process";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { vi } from "vitest";
import { CONTEXT_TREE_COMMAND_WORKER_SOURCE } from "../../runner/context-tree-command-worker.js";
import { createSandboxContextTreeSessionHints } from "../../runner/context-tree-session-hints.js";
import { resolveContextTreePackage, runContextTreeCli } from "../../runtime/context-tree.js";
import { ContextTreeCommandGateway, type ContextTreeCommandOptions } from "../../runtime/context-tree-commands.js";
import { configureContextTrees } from "../../runtime/context-tree-connections.js";
import type { RuntimeCredentialRelay } from "../../runtime/runtime-credential-relay.js";

const executeFile = promisify(execFile);

export async function cloudContextTreeGatewayFixture(root: string, workspace: string) {
  await mkdir(root, { recursive: true });
  await mkdir(workspace, { recursive: true });
  root = await realpath(root);
  workspace = await realpath(workspace);
  const pack = resolveContextTreePackage();
  if (!pack) throw new Error("Missing pinned Context Tree CLI");
  const sources = [
    { kind: "git", repository: "acme/project", path: "docs", ref: "main" },
    { kind: "git", repository: "acme/project", path: "other-docs", ref: "main" },
  ] as const;
  const environment = {
    HOME: join(workspace, ".opentag/context-tree/home"),
    PATH: process.env.PATH,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.test",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.test",
  };
  const git = async (...args: string[]) =>
    (await executeFile("/usr/bin/git", args, { env: environment })).stdout.trim();
  const seed = join(root, "seed"),
    bin = join(root, "bin"),
    remote = join(root, "remote.git");
  await mkdir(seed, { recursive: true });
  await mkdir(bin, { recursive: true });
  await git("init", "--initial-branch=main", seed);
  for (const source of sources) {
    const result = await runContextTreeCli(pack, ["init", join(seed, source.path), "--project-path", seed, "--json"], {
      env: { ...environment, HOME: join(root, "seed-home") },
    });
    if (result.failureCode) throw new Error("Context Tree fixture seed failed");
  }
  await git("-C", seed, "add", ".");
  await git("-C", seed, "commit", "-m", "init");
  await git("clone", "--bare", seed, remote);
  const dropAck = join(root, "drop-ack"),
    pushes = join(root, "pushes");
  await writeFile(
    join(bin, "git"),
    `#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = push ]; then
    printf 'push\\n' >> '${pushes}'
    /usr/bin/git -c protocol.file.allow=always -c 'url.file://${remote}.insteadOf=https://github.com/acme/project.git' "$@"
    code=$?
    if [ -f '${dropAck}' ] && [ "$code" -eq 0 ]; then rm -f '${dropAck}'; exit 1; fi
    exit "$code"
  fi
done
exec /usr/bin/git -c protocol.file.allow=always -c 'url.file://${remote}.insteadOf=https://github.com/acme/project.git' "$@"
`,
    { mode: 0o700 },
  );
  environment.PATH = `${bin}:${environment.PATH}`;
  await mkdir(workspace, { recursive: true });
  await configureContextTrees(workspace, sources);
  await mkdir(environment.HOME, { recursive: true });
  const hints = createSandboxContextTreeSessionHints(
    {
      exec: async (_binary, args, options) => {
        const execution = executeFile(process.execPath, [...args], {
          cwd: workspace,
          signal: options.signal,
          timeout: options.timeoutMs,
        });
        execution.child.stdin?.end(options.stdin);
        try {
          const result = await execution;
          return { code: 0, stdout: result.stdout, stderr: result.stderr };
        } catch (error) {
          const result = error as { code?: number; stdout?: string; stderr?: string };
          return {
            code: typeof result.code === "number" ? result.code : 1,
            stdout: result.stdout ?? "",
            stderr: result.stderr ?? "",
          };
        }
      },
    },
    workspace,
  );
  const execute: ContextTreeCommandOptions["execute"] = async (args, privateEnvironment, signal) => {
    const execution = executeFile(process.execPath, ["--input-type=module", "-e", CONTEXT_TREE_COMMAND_WORKER_SOURCE], {
      cwd: workspace,
      signal,
    });
    execution.child.stdin?.end(
      JSON.stringify({ cli: pack.cliPath, args, environment: privateEnvironment, cwd: workspace }),
    );
    return JSON.parse((await execution).stdout);
  };
  const gateways: ContextTreeCommandGateway[] = [];
  const requested: unknown[] = [];
  const gateway = (overrides: Partial<ContextTreeCommandOptions> = {}) => {
    const relay = {
      signal: new AbortController().signal,
      openContextTree: vi.fn(async (source: unknown) => {
        requested.push(source);
        return { localHandleFor: () => "tree-local-handle", close: async () => undefined };
      }),
    } as unknown as RuntimeCredentialRelay;
    const result = new ContextTreeCommandGateway({
      parent: relay,
      sources,
      workspace,
      stateDirectory: join(root, "host-routing"),
      environment: () => environment,
      sessionHints: hints,
      execute,
      ...overrides,
    });
    gateways.push(result);
    return result;
  };
  return {
    sources,
    workspace,
    root,
    remote,
    dropAck,
    pushes,
    environment,
    git,
    hints,
    execute,
    gateway,
    requested,
    hintPath: (id: string) => join(workspace, ".opentag/context-tree/command-sessions", `${id}.json`),
    close: async () => {
      await Promise.all(gateways.map((g) => g.close()));
    },
  };
}
