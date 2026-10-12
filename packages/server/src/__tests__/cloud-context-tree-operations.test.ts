import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type {
  AgentAdminConfig,
  ContextTreeOperationRequest,
  GitHubConnectionStatus,
  GitHubRepositoryBinding,
} from "@opentag/shared";
import { GITHUB_CONNECTION_ERROR_CODES } from "@opentag/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionRegistry } from "../runtime/connection-registry.js";
import { ContextTreeOperationOwner } from "../runtime/context-tree-operation-owner.js";
import {
  type CloudContextTreeGitHubManagement,
  CloudContextTreeOperations,
  type CloudContextTreeOperationsOptions,
} from "../services/agents/cloud-context-tree-operations.js";
import { ContextTreeOperationService } from "../services/agents/context-tree-operation-service.js";
import { GitHubConnectionServiceError } from "../services/github/errors.js";
import { GitPublicationError } from "../services/github-proxy/git-packets.js";
import { type GitProcessOptions, runTrustedProcess } from "../services/github-proxy/git-process.js";
import type { PublicationRemote } from "../services/github-proxy/git-remote.js";
import { GitWorkspace } from "../services/github-proxy/git-workspace.js";

const exec = promisify(execFile);
const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";
const COMPUTER = "33333333-3333-4333-8333-333333333333";

/* ------------------------------------------------------------------ *
 * Cloud operation unit fixtures (no filesystem, no network, no CLI).
 * ------------------------------------------------------------------ */

function binding(overrides: Partial<GitHubRepositoryBinding> = {}): GitHubRepositoryBinding {
  return {
    bindingId: randomUUID(),
    installationId: "555",
    repositoryId: "777",
    fullNameDisplay: "Acme/Memory",
    agentScopes: [
      { agentId: AGENT, role: "context_tree", access: "write", publish: "direct", branch: "refs/heads/master" },
    ],
    ...overrides,
  };
}

function connection(overrides: Partial<GitHubConnectionStatus> = {}): GitHubConnectionStatus {
  return {
    id: randomUUID(),
    accountId: ACCOUNT,
    githubHost: "github.com",
    appId: "1",
    githubUserId: "42",
    githubLogin: "acme",
    status: "active",
    bindingsSchemaVersion: 1,
    bindings: [binding()],
    authorizationVersion: "1",
    credentialGeneration: "1",
    accessExpiresAt: null,
    refreshExpiresAt: null,
    recheckRequired: false,
    nextRecheckAt: null,
    lastVerifiedAt: null,
    lastErrorCode: null,
    createdAt: "2026-09-16T00:00:00.000Z",
    updatedAt: "2026-09-16T00:00:00.000Z",
    ...overrides,
  };
}

function overview(row: GitHubConnectionStatus | null) {
  return { availability: { available: true as const, githubHost: "github.com" as const, appId: "1" }, connection: row };
}

function management(row: GitHubConnectionStatus | null | (() => GitHubConnectionStatus | null)) {
  const current = () => (typeof row === "function" ? row() : row);
  const stub = {
    getOverview: vi.fn(async () => overview(current())),
    getCurrentUserCredential: vi.fn(async (connectionId: string) => {
      const observed = current();
      if (!observed) return null;
      return {
        connectionId,
        accountId: observed.accountId,
        githubUserId: observed.githubUserId ?? "42",
        accessToken: "gho_test_token",
        refreshToken: "ghr_test_token",
        accessExpiresAt: new Date("2026-09-16T01:00:00.000Z"),
        refreshExpiresAt: new Date("2026-10-16T01:00:00.000Z"),
        authorizationVersion: BigInt(observed.authorizationVersion),
        credentialGeneration: BigInt(observed.credentialGeneration),
      };
    }),
    verifyCurrentRepositoryAdmission: vi.fn(async () => {
      const observed = current();
      return {
        authorizationVersion: BigInt(observed?.authorizationVersion ?? "1"),
        credentialGeneration: BigInt(observed?.credentialGeneration ?? "1"),
      };
    }),
  };
  return stub as unknown as CloudContextTreeGitHubManagement & typeof stub;
}

/** A verifier stub that mirrors the real verifier's recheck before and after the remote read. */
function verifier(
  result: (input: { recheck(): Promise<void> }) => Promise<string> = async (input) => {
    await input.recheck();
    await input.recheck();
    return "a".repeat(40);
  },
) {
  return { verify: vi.fn(result) };
}

function operations(
  managementStub: CloudContextTreeGitHubManagement,
  options: Partial<CloudContextTreeOperationsOptions> = {},
) {
  return new CloudContextTreeOperations({
    management: managementStub,
    computerKind: vi.fn(async () => "cloud" as const),
    workspace: { close: vi.fn(async () => undefined) } as unknown as GitWorkspace,
    treeHeads: verifier(),
    remoteFactory: vi.fn(() => ({}) as PublicationRemote),
    ...options,
  });
}

function runInput(overrides: Partial<Parameters<CloudContextTreeOperations["run"]>[0]> = {}) {
  return {
    alias: "memory",
    accountId: ACCOUNT,
    agentId: AGENT,
    action: "connect" as const,
    repository: "Acme/Memory",
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("Cloud Context Tree connect", () => {
  it("verifies the Agent's authorized binding on the live remote and returns its exact repository", async () => {
    const row = connection();
    const github = management(row);
    const verify = vi.fn(async (input: { recheck(): Promise<void> }) => {
      await input.recheck();
      return "a".repeat(40);
    });
    const remoteFactory = vi.fn(() => ({}) as PublicationRemote);
    const cloud = operations(github, { treeHeads: { verify }, remoteFactory });

    expect(await cloud.run(runInput({ repository: "acme/memory" }))).toEqual({
      status: "completed",
      repository: "acme/memory",
    });
    expect(github.getOverview).toHaveBeenCalledWith(ACCOUNT);
    expect(verify).toHaveBeenCalledWith(
      expect.objectContaining({ repositoryId: "777", ref: "refs/heads/master", signal: expect.any(AbortSignal) }),
    );
    expect(remoteFactory).toHaveBeenCalledWith("acme/memory", "gho_test_token");
    expect(github.verifyCurrentRepositoryAdmission).toHaveBeenCalledWith({
      connectionId: row.id,
      installationId: "555",
      repositoryId: "777",
      access: "write",
      publish: "direct",
    });
  });

  it("rejects a repository that is only readable or not bound to this Agent", async () => {
    const github = management(
      connection({
        bindings: [
          binding({ agentScopes: [{ agentId: AGENT, role: "code", access: "write" }] }),
          binding({ fullNameDisplay: "acme/other" }),
          binding({ agentScopes: [{ agentId: randomUUID(), role: "context_tree", access: "write" }] }),
        ],
      }),
    );
    const cloud = operations(github);
    expect(await cloud.run(runInput())).toEqual({ status: "failed", code: "permission_denied" });
    expect(github.getCurrentUserCredential).not.toHaveBeenCalled();
  });

  it("requires an active connection, an Account-owned credential, and an unchanged fencing state", async () => {
    expect(await operations(management(null)).run(runInput())).toEqual({
      status: "failed",
      code: "authentication_required",
    });
    expect(await operations(management(connection({ status: "reauthorization_required" }))).run(runInput())).toEqual({
      status: "failed",
      code: "authentication_required",
    });

    const foreign = management(connection({ accountId: randomUUID() }));
    expect(await operations(foreign).run(runInput())).toEqual({
      status: "failed",
      code: "authentication_required",
    });

    // The credential row moved between the overview read and the credential read.
    const versions = ["1", "2"];
    const racing = management(() => connection({ authorizationVersion: versions.shift() ?? "2" }));
    expect(await operations(racing).run(runInput())).toEqual({ status: "failed", code: "stale_configuration" });
  });

  it("never commits a result whose admission or auth was revoked during the remote read", async () => {
    const row = connection();
    const versions = ["1", "2"];
    const racing = management(row);
    racing.verifyCurrentRepositoryAdmission.mockImplementation(async () => ({
      authorizationVersion: BigInt(versions.shift() ?? "2"),
      credentialGeneration: 1n,
    }));
    expect(await operations(racing).run(runInput())).toEqual({ status: "failed", code: "stale_configuration" });

    const revoked = management(row);
    revoked.getOverview.mockResolvedValueOnce(overview(row)).mockResolvedValueOnce(overview(null));
    expect(await operations(revoked).run(runInput())).toEqual({
      status: "failed",
      code: "authentication_required",
    });

    const denied = management(row);
    denied.verifyCurrentRepositoryAdmission.mockRejectedValueOnce(
      new GitHubConnectionServiceError(GITHUB_CONNECTION_ERROR_CODES.ADMISSION_PERMISSION_INSUFFICIENT, 409, "denied"),
    );
    expect(await operations(denied).run(runInput())).toEqual({ status: "failed", code: "permission_denied" });
  });

  it("classifies a malformed remote Tree as invalid_tree and a missing branch as failed", async () => {
    const malformed = operations(management(connection()), {
      treeHeads: { verify: vi.fn(async () => Promise.reject(new GitPublicationError("tree_invalid"))) },
    });
    expect(await malformed.run(runInput())).toEqual({ status: "failed", code: "invalid_tree" });

    const branchless = management(
      connection({ bindings: [binding({ agentScopes: [{ agentId: AGENT, role: "context_tree", access: "write" }] })] }),
    );
    expect(await operations(branchless).run(runInput())).toEqual({ status: "failed", code: "failed" });
  });

  it("returns capability_missing for create without touching GitHub or allocating anything", async () => {
    const github = management(connection());
    const cloud = operations(github);
    expect(await cloud.run(runInput({ action: "create" }))).toEqual({
      status: "failed",
      code: "capability_missing",
    });
    expect(await cloud.run(runInput({ action: "create" }))).toEqual({
      status: "failed",
      code: "capability_missing",
    });
    expect(github.getOverview).not.toHaveBeenCalled();
    expect(github.getCurrentUserCredential).not.toHaveBeenCalled();
  });

  it("joins an identical in-flight replay, refuses a different one, and releases admission on failure", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const github = management(connection());
    const cloud = operations(github, {
      treeHeads: {
        verify: vi.fn(async (input: { recheck(): Promise<void> }) => {
          await gate;
          await input.recheck();
          return "a".repeat(40);
        }),
      },
    });
    const first = cloud.run(runInput());
    expect(cloud.run(runInput({ repository: "acme/Memory" }))).toBe(first);
    expect(await cloud.run(runInput({ repository: "acme/Other" }))).toEqual({ status: "failed", code: "busy" });
    release();
    expect(await first).toEqual({ status: "completed", repository: "Acme/Memory" });

    const next = cloud.run(runInput());
    expect(await next).toMatchObject({ status: "completed" });
  });

  it("aborts in-flight verification and removes the ephemeral workspace on close", async () => {
    const github = management(connection());
    const workspace = { close: vi.fn(async () => undefined) } as unknown as GitWorkspace;
    const cloud = operations(github, {
      workspace,
      treeHeads: {
        verify: vi.fn(
          (input: { signal: AbortSignal }): Promise<string> =>
            new Promise((_resolve, reject) => {
              const abort = () => reject(new GitPublicationError("unavailable"));
              if (input.signal.aborted) return abort();
              input.signal.addEventListener("abort", abort, { once: true });
            }),
        ),
      },
    });
    const pending = cloud.run(runInput());
    await cloud.close();
    expect(await pending).toEqual({ status: "failed", code: "failed" });
    expect(workspace.close).toHaveBeenCalledTimes(1);
    expect(await cloud.run(runInput())).toEqual({ status: "failed", code: "failed" });
  });
});

/* ------------------------------------------------------------------ *
 * Dispatch through the shared operation service (Local path unchanged).
 * ------------------------------------------------------------------ */

function agentConfig(overrides: Partial<AgentAdminConfig> = {}): AgentAdminConfig {
  return {
    id: AGENT,
    createdByUserId: ACCOUNT,
    computerId: COMPUTER,
    revision: 3,
    status: "suspended",
    runtimeConfig: { revision: 7, contextTrees: [] },
    ...overrides,
  } as AgentAdminConfig;
}

function request(overrides: Partial<ContextTreeOperationRequest> = {}): ContextTreeOperationRequest {
  return {
    alias: "memory",
    operationId: randomUUID(),
    expectedRevision: 3,
    expectedRuntimeConfigRevision: 7,
    action: "connect",
    repository: "Acme/Memory",
    ...overrides,
  };
}

function dispatchFixture(kind: "local" | "cloud" | undefined, config = agentConfig()) {
  const registry = {
    currentInstanceId: vi.fn(() => randomUUID()),
    supportsCapability: vi.fn(() => true),
    send: vi.fn(async () => undefined),
  };
  const owner = new ContextTreeOperationOwner(registry as unknown as ConnectionRegistry);
  const ownerStart = vi.spyOn(owner, "start").mockResolvedValue({ status: "completed", repository: "acme/memory" });
  const agents = {
    getConfigById: vi.fn(async () => config),
    updateContextTreeSelection: vi.fn(async () => config),
  };
  const cloud = {
    computerKind: vi.fn(async () => kind),
    run: vi.fn(async () => ({ status: "completed", repository: "acme/memory" }) as const),
  };
  const service = new ContextTreeOperationService(agents, owner, cloud);
  return { agents, cloud, owner, ownerStart, service };
}

describe("ContextTreeOperationService Cloud dispatch", () => {
  it("runs Cloud connect Server-side and never through the Local WebSocket owner", async () => {
    const f = dispatchFixture("cloud");
    expect(await f.service.run(ACCOUNT, AGENT, request())).toEqual({
      status: "completed",
      repository: "acme/memory",
    });
    expect(f.cloud.run).toHaveBeenCalledWith({
      accountId: ACCOUNT,
      agentId: AGENT,
      action: "connect",
      alias: "memory",
      repository: "Acme/Memory",
    });
    expect(f.ownerStart).not.toHaveBeenCalled();
    // The Agent revision CAS commits the exact pre-dispatch fences.
    expect(f.agents.updateContextTreeSelection).toHaveBeenCalledWith(
      ACCOUNT,
      AGENT,
      { revision: 3, runtimeConfigRevision: 7, computerId: COMPUTER, status: "suspended" },
      [{ alias: "memory", repository: "Acme/Memory" }],
    );
  });

  it("keeps the Local owner path byte-for-byte unchanged", async () => {
    const f = dispatchFixture("local");
    const input = request();
    expect(await f.service.run(ACCOUNT, AGENT, input)).toEqual({ status: "completed", repository: "acme/memory" });
    expect(f.cloud.run).not.toHaveBeenCalled();
    expect(f.ownerStart).toHaveBeenCalledWith({
      agentId: AGENT,
      computerId: COMPUTER,
      requireStopped: false,
      input,
    });
  });

  it("falls back to the Local path when the Computer kind is unknown", async () => {
    const f = dispatchFixture(undefined);
    await f.service.run(ACCOUNT, AGENT, request());
    expect(f.ownerStart).toHaveBeenCalledTimes(1);
    expect(f.cloud.run).not.toHaveBeenCalled();
  });

  it("disconnects a Cloud Agent without any Cloud resource", async () => {
    const f = dispatchFixture(
      "cloud",
      agentConfig({
        runtimeConfig: {
          ...agentConfig().runtimeConfig,
          contextTrees: [{ alias: "memory", repository: "acme/memory" }],
        },
      }),
    );
    expect(await f.service.run(ACCOUNT, AGENT, request({ action: "disconnect", repository: null }))).toEqual({
      status: "completed",
      repository: null,
    });
    expect(f.cloud.run).not.toHaveBeenCalled();
    expect(f.ownerStart).not.toHaveBeenCalled();
    expect(f.agents.updateContextTreeSelection).toHaveBeenCalledWith(
      ACCOUNT,
      AGENT,
      { revision: 3, runtimeConfigRevision: 7, computerId: COMPUTER, status: "suspended" },
      [],
    );
  });

  it("requires pausing before a Cloud selection change and reports a lost revision race", async () => {
    const paused = dispatchFixture(
      "cloud",
      agentConfig({
        status: "active",
        runtimeConfig: { ...agentConfig().runtimeConfig, contextTrees: [{ alias: "old", repository: "acme/old" }] },
      }),
    );
    expect(await paused.service.run(ACCOUNT, AGENT, request())).toEqual({ status: "failed", code: "pause_required" });
    expect(paused.cloud.run).not.toHaveBeenCalled();

    const raced = dispatchFixture("cloud");
    raced.agents.updateContextTreeSelection.mockRejectedValue(
      Object.assign(new Error("changed"), { code: "AGENT_REVISION_CONFLICT" }),
    );
    expect(await raced.service.run(ACCOUNT, AGENT, request())).toEqual({
      status: "failed",
      code: "stale_configuration",
    });
  });

  it("surfaces the Cloud create capability failure without a Session or Sandbox allocation", async () => {
    const f = dispatchFixture("cloud");
    f.cloud.run.mockResolvedValue({ status: "failed", code: "capability_missing" } as never);
    expect(await f.service.run(ACCOUNT, AGENT, request({ action: "create" }))).toEqual({
      status: "failed",
      code: "capability_missing",
    });
    expect(f.ownerStart).not.toHaveBeenCalled();
    expect(f.agents.updateContextTreeSelection).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ *
 * Real pinned-CLI verification against a local repository (no network).
 * ------------------------------------------------------------------ */

describe("Cloud Context Tree verification with the pinned CLI", () => {
  let root: string;
  let tree: string;
  let environment: NodeJS.ProcessEnv;

  async function git(cwd: string, args: string[]) {
    return (await exec("git", args, { cwd, env: environment })).stdout.trim();
  }

  /** Reads the commit named by `refs` straight from the local origin, like a GitHub remote would. */
  function localRemote(origin: string): PublicationRemote {
    return {
      async seed(repository, options: GitProcessOptions, allowedRefs?: readonly string[]) {
        const refs = allowedRefs ?? ["refs/heads/master"];
        await runTrustedProcess(
          "git",
          ["-C", repository, "fetch", "--no-tags", origin, ...refs.map((ref) => `+${ref}:${ref}`)],
          options,
        );
      },
      async publish() {
        throw new Error("Cloud connect never publishes");
      },
      async refs(repository, refs, options) {
        const resolved = new Map<string, string>();
        for (const ref of refs) {
          const result = await runTrustedProcess(
            "git",
            ["-C", repository, "rev-parse", "--verify", `${ref}^{commit}`],
            options,
          );
          resolved.set(ref, result.stdout.toString("utf8").trim());
        }
        return resolved;
      },
    };
  }

  function connected(origin: string, name = "memory") {
    const workspace = new GitWorkspace();
    const github = management(connection({ bindings: [binding({ fullNameDisplay: `acme/${name}` })] }));
    const cloud = new CloudContextTreeOperations({
      management: github,
      computerKind: async () => "cloud",
      workspace,
      remoteFactory: () => localRemote(origin),
    });
    return { cloud, workspace };
  }

  beforeEach(async () => {
    root = await mkdtemp(join(await realpath(tmpdir()), "opentag-cloud-tree-"));
    const home = join(root, "home");
    await mkdir(home);
    environment = {
      PATH: process.env.PATH,
      HOME: home,
      XDG_CONFIG_HOME: home,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    };
    const project = join(root, "project");
    await mkdir(project);
    await git(project, ["init"]);
    const cli = join(
      dirname(createRequire(import.meta.url).resolve("@first-tree-ai/context-tree/package.json")),
      "dist/cli/index.mjs",
    );
    tree = JSON.parse(
      (await exec(process.execPath, [cli, "create", "--project-path", project, "--json"], { env: environment })).stdout,
    ).treePath;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("completes a real pinned-CLI verification and cleans the ephemeral root", async () => {
    const { cloud, workspace } = connected(tree);
    expect(await cloud.run(runInput({ repository: "acme/memory" }))).toEqual({
      status: "completed",
      repository: "acme/memory",
    });
    const stagingRoot = workspace.root;
    expect(stagingRoot).toBeDefined();
    await cloud.close();
    expect(existsSync(stagingRoot as string)).toBe(false);
  });

  it("rejects a repository whose pinned head is not a valid Context Tree", async () => {
    await writeFile(join(tree, "unindexed.md"), "# Unindexed\n");
    await git(tree, ["add", "."]);
    await git(tree, ["commit", "-m", "invalid"]);
    const { cloud } = connected(tree);
    expect(await cloud.run(runInput({ repository: "acme/memory" }))).toEqual({
      status: "failed",
      code: "invalid_tree",
    });
    await cloud.close();
  });

  it("ignores ambient Git config and hooks outside the trusted staging environment", async () => {
    const marker = join(root, "ambient-hook-ran");
    const ambientHome = join(root, "ambient-home");
    const hooks = join(ambientHome, "hooks");
    await mkdir(hooks, { recursive: true });
    await writeFile(join(ambientHome, ".gitconfig"), `[core]\n\thooksPath = ${hooks}\n`);
    await writeFile(join(hooks, "reference-transaction"), `#!/bin/sh\necho ran >> "${marker}"\n`, { mode: 0o755 });
    vi.stubEnv("HOME", ambientHome);

    const { cloud } = connected(tree);
    expect(await cloud.run(runInput({ repository: "acme/memory" }))).toEqual({
      status: "completed",
      repository: "acme/memory",
    });
    expect(existsSync(marker)).toBe(false);
    await cloud.close();
  });
});

it("selects the exact requested binding among multiple Context Tree grants and rechecks it", async () => {
  const row = connection({
    bindings: [
      binding(),
      binding({
        repositoryId: "888",
        fullNameDisplay: "acme/product",
        agentScopes: [{ agentId: AGENT, role: "context_tree", access: "read", branch: "refs/heads/main" }],
      }),
    ],
  });
  const github = management(row);
  const treeHeads = verifier();
  const cloud = operations(github, { treeHeads });
  expect(await cloud.run(runInput({ alias: "product", repository: "acme/product" }))).toEqual({
    status: "completed",
    repository: "acme/product",
  });
  expect(treeHeads.verify).toHaveBeenCalledWith(
    expect.objectContaining({ repositoryId: "888", ref: "refs/heads/main" }),
  );
  expect(github.verifyCurrentRepositoryAdmission).toHaveBeenCalledWith(
    expect.objectContaining({ repositoryId: "888", access: "read" }),
  );
});
it("does not accept another remaining Tree binding when the requested grant is revoked during verification", async () => {
  const row = connection({ bindings: [binding(), binding({ repositoryId: "888", fullNameDisplay: "acme/product" })] });
  const github = management(row);
  const treeHeads = verifier(async () => {
    row.bindings = row.bindings.filter((entry) => entry.repositoryId !== "888");
    return "a".repeat(40);
  });
  const cloud = operations(github, { treeHeads });
  expect(await cloud.run(runInput({ alias: "product", repository: "acme/product" }))).toEqual({
    status: "failed",
    code: "permission_denied",
  });
});
