import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { SessionControlStore } from "../session-control-store/index.js";
import { ensureControlDirectory } from "../session-control-store/private-files.js";
import {
  GIT_ZERO_SHA,
  GitPublicationError,
  type GitReceiveCommands,
  type GitRefUpdate,
  gitReceiveFailure,
  parseGitReceiveCommands,
} from "./git-packets.js";
import { type GitProcessOptions, runTrustedGit, runTrustedProcess } from "./git-process.js";
import { GitPushRejectedError, type PublicationRemote } from "./git-remote.js";
import { verifyPublishedContextTree } from "./tree-verifier.js";

export interface GitPublicationScope {
  role: "code" | "context_tree";
  exactRef?: string;
  refPrefix?: string;
}
export interface GitPublicationInput {
  sessionId: string;
  executionId: string;
  operationId: string;
  repositoryId: string;
  policyRevision: string;
  scopes: GitPublicationScope[];
  protectedTreeRefs: string[];
  body: AsyncIterable<Uint8Array>;
  signal: AbortSignal;
  remote: PublicationRemote;
  revalidate(): Promise<void>;
}
export interface GitPublicationOptions {
  root: string;
  controlStore: SessionControlStore;
  maxPackBytes?: number;
  maxRepositoryBytes?: number;
  maxObjectBytes?: number;
  maxObjects?: number;
  timeoutMs?: number;
  verifyTree?: typeof verifyPublishedContextTree;
}

/** Full pack staging and validation precede every external ref update; no receive-pack passthrough. */
export class GitPublicationGuard {
  readonly #options: Required<GitPublicationOptions>;
  #active = 0;
  constructor(options: GitPublicationOptions) {
    this.#options = {
      maxPackBytes: 64 * 1024 * 1024,
      maxRepositoryBytes: 512 * 1024 * 1024,
      maxObjectBytes: 64 * 1024 * 1024,
      maxObjects: 100_000,
      timeoutMs: 120_000,
      verifyTree: verifyPublishedContextTree,
      ...options,
      root: resolve(options.root),
    };
  }

  async receive(input: GitPublicationInput): Promise<Buffer> {
    if (this.#active >= 4) throw new GitPublicationError("resource_limit");
    this.#active++;
    try {
      return await this.#receive(input);
    } finally {
      this.#active--;
    }
  }

  async #receive(input: GitPublicationInput): Promise<Buffer> {
    await input.revalidate();
    await ensureControlDirectory(this.#options.root);
    const workspace = await mkdtemp(join(this.#options.root, "git-"));
    const abort = new AbortController();
    const signal = AbortSignal.any([input.signal, abort.signal, AbortSignal.timeout(this.#options.timeoutMs)]);
    let commands: GitReceiveCommands | undefined;
    let checking = false;
    const monitor = setInterval(() => {
      if (checking) return;
      checking = true;
      void assertDirectoryBudget(workspace, this.#options.maxRepositoryBytes)
        .catch(() => abort.abort(new GitPublicationError("resource_limit")))
        .finally(() => {
          checking = false;
        });
    }, 500);
    monitor.unref();
    try {
      const request = await this.#spool(input.body, workspace, signal);
      commands = request.commands;
      const roles = commands.updates.map((update) => resolvePublicationRole(update, input));
      const home = join(workspace, "home");
      await mkdir(home, { mode: 0o700 });
      const options: GitProcessOptions = { cwd: workspace, signal, environment: trustedGitEnvironment(home) };
      const repository = join(workspace, "repository.git");
      await runTrustedGit(["-c", "init.templateDir=", "init", "--bare", repository], options);
      await this.#options.controlStore.recordSource({
        sessionId: input.sessionId,
        provider: "github",
        resource: `repository:${input.repositoryId}`,
        policyRevision: input.policyRevision,
        recordedAt: new Date().toISOString(),
      });
      await input.remote.seed(repository, options);
      await input.revalidate();
      await assertDirectoryBudget(workspace, this.#options.maxRepositoryBytes);
      await verifyExpectedRefs(repository, commands.updates, options);
      const accepted = await runTrustedProcess(
        "git",
        [
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "receive.fsckObjects=true",
          "-c",
          "receive.denyNonFastForwards=true",
          "-c",
          "receive.denyDeletes=true",
          "receive-pack",
          "--stateless-rpc",
          repository,
        ],
        { ...options, input: createReadStream(request.path) },
      );
      if (accepted.code !== 0) throw new GitPublicationError("invalid_objects");
      await validateReceivedObjects(repository, commands.updates, options, this.#options);
      for (const [index, update] of commands.updates.entries()) {
        if (roles[index] === "context_tree") await this.#options.verifyTree(repository, update.newSha, options);
      }
      await input.revalidate();
      return await this.#publish(input, commands, repository, options, request.hash, accepted.stdout);
    } catch (error) {
      if (commands) return gitReceiveFailure(commands);
      if (error instanceof GitPublicationError) throw error;
      throw new GitPublicationError("unavailable");
    } finally {
      clearInterval(monitor);
      abort.abort();
      await rm(workspace, { recursive: true, force: true });
    }
  }

  async #spool(body: AsyncIterable<Uint8Array>, workspace: string, signal: AbortSignal) {
    const path = join(workspace, "receive-pack");
    const file = await open(path, "wx", 0o600);
    const hash = createHash("sha256");
    const chunks: Buffer[] = [];
    let headerBytes = 0;
    let bytes = 0;
    try {
      for await (const chunk of body) {
        signal.throwIfAborted();
        bytes += chunk.length;
        if (bytes > this.#options.maxPackBytes) throw new GitPublicationError("resource_limit");
        if (headerBytes < 16384) {
          const part = Buffer.from(chunk.subarray(0, 16384 - headerBytes));
          chunks.push(part);
          headerBytes += part.length;
        }
        hash.update(chunk);
        await file.writeFile(chunk);
      }
    } finally {
      await file.close();
    }
    return { path, hash: hash.digest("hex"), commands: parseGitReceiveCommands(Buffer.concat(chunks)) };
  }

  async #publish(
    input: GitPublicationInput,
    commands: GitReceiveCommands,
    repository: string,
    options: GitProcessOptions,
    hash: string,
    success: Buffer,
  ): Promise<Buffer> {
    const { intentHash } = await this.#options.controlStore.beginWrite({
      sessionId: input.sessionId,
      executionId: input.executionId,
      operationId: input.operationId,
      provider: "github",
      resource: `repository:${input.repositoryId}`,
      operation: "git.push",
      requestHash: hash,
      policyRevision: input.policyRevision,
      createdAt: new Date().toISOString(),
    });
    let sent = false;
    try {
      await input.revalidate();
      options.signal.throwIfAborted();
      sent = true;
      let remoteRejected: readonly string[] | undefined;
      try {
        await input.remote.publish(repository, commands.updates, options);
      } catch (error) {
        // Only git's own complete all-refs rejection report is definitive non-application
        // evidence; every other failure stays ambiguous until the remote refs answer.
        if (error instanceof GitPushRejectedError) remoteRejected = error.rejectedRefs;
        /* Confirm actual refs before classifying an ambiguous Git exit. */
      }
      await input.revalidate();
      const refs = await input.remote.refs(
        repository,
        commands.updates.map((update) => update.ref),
        options,
      );
      const { state, resultCode } = classifyPublication(commands.updates, refs, remoteRejected);
      await this.#options.controlStore.completeWrite(input.sessionId, {
        operationId: input.operationId,
        intentHash,
        state,
        resultCode,
        completedAt: new Date().toISOString(),
      });
      return state === "succeeded" ? success : gitReceiveFailure(commands);
    } catch {
      await this.#options.controlStore.completeWrite(input.sessionId, {
        operationId: input.operationId,
        intentHash,
        state: sent ? "unknown" : "rejected",
        resultCode: sent ? "publication_unconfirmed" : "authorization_changed",
        completedAt: new Date().toISOString(),
      });
      return gitReceiveFailure(commands);
    }
  }
}

/**
 * Terminal classification of one published push from the confirmed remote refs. Only git's own
 * complete all-refs rejection report (typed evidence) proves non-application when another writer
 * has since moved the target refs; every other ambiguous observation stays unknown.
 */
function classifyPublication(
  updates: GitRefUpdate[],
  refs: Map<string, string>,
  remoteRejected: readonly string[] | undefined,
): { state: "succeeded" | "rejected" | "unknown"; resultCode: string } {
  const published = updates.every((update) => refs.get(update.ref) === update.newSha);
  const unchanged = updates.every((update) => (refs.get(update.ref) ?? GIT_ZERO_SHA) === update.oldSha);
  const evidenceRejected =
    remoteRejected !== undefined &&
    updates.every((update) => remoteRejected.includes(update.ref)) &&
    updates.every((update) => refs.get(update.ref) !== update.newSha);
  if (published) return { state: "succeeded", resultCode: "remote_sha_confirmed" };
  if (unchanged || evidenceRejected)
    return {
      state: "rejected",
      resultCode: evidenceRejected && !unchanged ? "remote_push_rejected" : "remote_conflict",
    };
  return { state: "unknown", resultCode: "remote_conflict" };
}

function trustedGitEnvironment(home: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    XDG_CONFIG_HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ATTR_NOSYSTEM: "1",
    LC_ALL: "C",
    GIT_OPTIONAL_LOCKS: "0",
  };
}

function resolvePublicationRole(update: GitRefUpdate, input: GitPublicationInput): GitPublicationScope["role"] {
  if (update.newSha === GIT_ZERO_SHA) throw new GitPublicationError("scope_denied");
  const candidates = input.scopes.filter(
    (scope) =>
      (scope.exactRef === update.ref || (scope.refPrefix && update.ref.startsWith(scope.refPrefix))) &&
      (scope.role === "context_tree" || !input.protectedTreeRefs.includes(update.ref)),
  );
  if (candidates.length !== 1) throw new GitPublicationError("scope_denied");
  return candidates[0]?.role ?? "code";
}

async function verifyExpectedRefs(
  repository: string,
  updates: GitRefUpdate[],
  options: GitProcessOptions,
): Promise<void> {
  for (const update of updates) {
    const result = await runTrustedProcess(
      "git",
      ["-C", repository, "show-ref", "--verify", "--hash", update.ref],
      options,
    );
    const sha = result.code === 0 ? result.stdout.toString("utf8").trim() : GIT_ZERO_SHA;
    if (sha !== update.oldSha) throw new GitPublicationError("remote_conflict");
  }
}

async function validateReceivedObjects(
  repository: string,
  updates: GitRefUpdate[],
  options: GitProcessOptions,
  limits: Required<GitPublicationOptions>,
): Promise<void> {
  for (const update of updates) {
    const ref = await runTrustedGit(["-C", repository, "rev-parse", "--verify", `${update.ref}^{commit}`], options);
    if (ref.toString("utf8").trim() !== update.newSha) throw new GitPublicationError("invalid_objects");
    if (update.oldSha !== GIT_ZERO_SHA)
      await runTrustedGit(["-C", repository, "merge-base", "--is-ancestor", update.oldSha, update.newSha], options);
  }
  await runTrustedGit(["-C", repository, "fsck", "--strict", "--no-reflogs"], options);
  const objects = await runTrustedGit(
    ["-C", repository, "cat-file", "--batch-all-objects", "--batch-check=%(objectsize)"],
    { ...options, maxOutputBytes: limits.maxObjects * 24 },
  );
  const sizes = objects.toString("utf8").trim().split("\n");
  if (
    sizes.length > limits.maxObjects ||
    sizes.some((size) => !/^\d+$/.test(size) || Number(size) > limits.maxObjectBytes) ||
    sizes.reduce((sum, size) => sum + Number(size), 0) > limits.maxRepositoryBytes
  )
    throw new GitPublicationError("resource_limit");
}

export async function assertDirectoryBudget(path: string, maximum: number): Promise<void> {
  let total = 0;
  const pending = [path];
  while (pending.length) {
    const directory = pending.pop() as string;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const child = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(child);
      else {
        total += (await lstat(child)).size;
        if (total > maximum) throw new GitPublicationError("resource_limit");
      }
    }
  }
}
