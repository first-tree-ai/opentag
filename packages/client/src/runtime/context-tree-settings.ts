import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { resolvedTreeSchema, SCHEMA_VERSION } from "@first-tree-ai/context-tree/contracts";
import {
  type ContextTreeOperationFrame,
  type ContextTreeOperationResponse,
  ContextTreeOperationResponseSchema,
  contextTreeIdentity,
} from "@opentag/shared";
import { z } from "zod";
import { ensurePrivateDirectory, readDurableJson, writeDurableFile } from "../storage/durable-file.js";
import {
  type ContextTreeExecFile,
  hasManagedGitHubTransport,
  mergeContextTreeEnvironment,
  resolveContextTreePackage,
  runContextTreeCli,
  runContextTreeProcess,
} from "./context-tree.js";

const RecordSchema = z.object({ fingerprint: z.string(), result: ContextTreeOperationResponseSchema }).strict();
type Result = ContextTreeOperationResponse;
type Run = (args: readonly string[], signal?: AbortSignal) => Promise<{ payload: unknown; failureCode?: string }>;

/** Stable staging location for interrupted repository creation. */
function contextTreeStagingName(repository: string): string {
  const identity = repository.toLowerCase();
  const readable = identity.replace(/[^a-z0-9.-]+/g, "-").slice(0, 27);
  return `${readable}-${createHash("sha256").update(identity).digest("hex").slice(0, 12)}`;
}

function fingerprint(frame: ContextTreeOperationFrame): string {
  const input = frame.input;
  return JSON.stringify([
    frame.agentId,
    input.action,
    input.path,
    input.ref,
    input.repository.toLowerCase(),
    input.expectedRevision,
    input.expectedRuntimeConfigRevision,
  ]);
}

/** Publication intent survives lost responses, timeouts, and Computer restarts. */
export class ContextTreeSettings {
  #active: { identity: string; promise: Promise<Result>; controller: AbortController } | undefined;
  #closed = false;
  constructor(
    readonly options: {
      home: string;
      environment: NodeJS.ProcessEnv;
      hasAgentSessions: (agentId: string) => boolean;
      exclusive: <T>(operation: () => Promise<T>) => Promise<T>;
      run?: Run;
      process?: ContextTreeExecFile;
      budgetMs?: number;
      /**
       * Trusted credential mode. Settings operations never fall back to ambient host credentials:
       * network actions require `managedEnvironment` and otherwise fail with
       * `authentication_required`. Repository creation always requires managed GitHub transport.
       */
      managedCredentials?: boolean;
      /** Host-side execution environment for managed settings operations, when one is available. */
      managedEnvironment?: () => NodeJS.ProcessEnv | undefined;
    },
  ) {}

  run(frame: ContextTreeOperationFrame): Promise<Result> {
    if (this.#closed) return Promise.resolve(failed("computer_unavailable"));
    const identity = fingerprint(frame);
    if (this.#active)
      return this.#active.identity === identity ? this.#active.promise : Promise.resolve(failed("busy"));
    const controller = new AbortController();
    const promise = this.#run(frame, controller).finally(() => {
      this.#active = undefined;
    });
    this.#active = { identity, promise, controller };
    return promise;
  }

  close(): void {
    this.#closed = true;
    this.#active?.controller.abort();
  }

  async #run(frame: ContextTreeOperationFrame, controller: AbortController): Promise<Result> {
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(this.options.budgetMs ?? 240_000)]);
    try {
      return await this.#execute(frame, signal);
    } catch {
      return failed("failed");
    }
  }

  #runner(
    frame: ContextTreeOperationFrame,
    signal: AbortSignal,
    managedEnvironment?: NodeJS.ProcessEnv,
  ): Run | undefined {
    const assets = resolveContextTreePackage();
    if (!assets && !this.options.run) return undefined;
    const environment = mergeContextTreeEnvironment(this.options.environment, managedEnvironment);
    const run: Run =
      this.options.run ??
      ((args, cancellation) => {
        if (!assets) throw new Error("Context Tree package missing");
        return runContextTreeCli(assets, args, { env: environment, network: true, signal: cancellation });
      });
    return (args, cancellation = signal) => {
      const execute = async () => {
        cancellation.throwIfAborted();
        if (frame.requireStopped && this.options.hasAgentSessions(frame.agentId))
          throw new Error("Agent runtime resumed");
        return await run(args, cancellation);
      };
      // The same queue protects runtime preparation and settings calls. Verification is read-only.
      if (args[0] === "verify") return execute();
      const queued = this.options.exclusive(execute);
      // The caller can time out while this remains queued. Observe the later rejection too.
      void queued.catch(() => undefined);
      return abortable(queued, cancellation);
    };
  }

  async #execute(frame: ContextTreeOperationFrame, signal: AbortSignal): Promise<Result> {
    if (frame.requireStopped && this.options.hasAgentSessions(frame.agentId)) return failed("busy");
    const input = frame.input;
    const managedEnvironment = input.action === "disconnect" ? undefined : this.options.managedEnvironment?.();
    if (this.options.managedCredentials && input.action !== "disconnect" && !managedEnvironment) {
      // No managed GitHub authority is available for this Computer; never fall back to ambient
      // host credentials (`gh auth login`, user git config) in proxy mode.
      return failed("authentication_required");
    }
    if (managedEnvironment && input.action === "connect" && !hasManagedGitHubTransport(managedEnvironment)) {
      // Require the execution transport; repository admission is authoritative on the Server.
      return failed("permission_denied");
    }
    const run = this.#runner(frame, signal, managedEnvironment);
    if (!run) return failed("capability_missing");
    return this.#executeRecorded(
      frame,
      run,
      signal,
      mergeContextTreeEnvironment(this.options.environment, managedEnvironment),
    );
  }

  async #executeRecorded(
    frame: ContextTreeOperationFrame,
    run: Run,
    signal: AbortSignal,
    environment: NodeJS.ProcessEnv,
  ): Promise<Result> {
    const input = frame.input;
    const directory = join(this.options.home, "state", "context-tree-operations");
    await ensurePrivateDirectory(this.options.home, directory);
    const recordFile = join(directory, `${input.operationId}.json`);
    const previous = await readDurableJson(recordFile, RecordSchema.parse);
    if (previous) {
      if (previous.fingerprint !== fingerprint(frame)) return failed("stale_configuration");
      if (previous.result.status !== "failed" || previous.result.code !== "publication_uncertain")
        return previous.result;
    }
    const identity = fingerprint(frame);
    if (input.action === "disconnect")
      return this.#save(recordFile, identity, { status: "completed", repository: null });
    const setup = join(directory, contextTreeStagingName(input.repository));
    await ensurePrivateDirectory(this.options.home, setup);
    const project = ["--project-path", setup, "--json"];
    const execute = this.#processRunner(frame, setup, signal, environment);
    const publication =
      input.action === "create" ? await this.#publish(frame, setup, run, execute, environment) : undefined;
    if (publication && typeof publication !== "string") return this.#save(recordFile, identity, publication);
    const ref =
      typeof publication === "string"
        ? publication
        : input.ref === "HEAD"
          ? await remoteDefaultBranch(input.repository, execute)
          : input.ref;
    const result = await verifyRepository({ ...input, ref }, project, run);
    return this.#save(
      recordFile,
      identity,
      result.status === "completed" && input.ref === "HEAD" ? { ...result, ref } : result,
    );
  }

  async #save(recordFile: string, identity: string, result: Result): Promise<Result> {
    await writeDurableFile(recordFile, JSON.stringify({ fingerprint: identity, result }));
    return result;
  }

  #processRunner(
    frame: ContextTreeOperationFrame,
    setup: string,
    signal: AbortSignal,
    environment: NodeJS.ProcessEnv,
  ): ProcessRun {
    const processRun = this.options.process ?? runContextTreeProcess;
    const processEnvironment = { ...environment };
    for (const key of [
      "GIT_DIR",
      "GIT_WORK_TREE",
      "GIT_INDEX_FILE",
      "GIT_COMMON_DIR",
      "GIT_OBJECT_DIRECTORY",
      "GIT_ALTERNATE_OBJECT_DIRECTORIES",
      "GIT_PREFIX",
      "GIT_SHALLOW_FILE",
      "GIT_NAMESPACE",
      "GIT_CONFIG",
    ])
      delete processEnvironment[key];
    const execute = async (file: string, args: string[], cwd = setup) => {
      signal.throwIfAborted();
      if (frame.requireStopped && this.options.hasAgentSessions(frame.agentId))
        throw new Error("Agent runtime resumed");
      return (
        await processRun(file, args, {
          cwd,
          env: {
            ...processEnvironment,
            GIT_AUTHOR_NAME: "OpenTag",
            GIT_AUTHOR_EMAIL: "opentag@localhost",
            GIT_COMMITTER_NAME: "OpenTag",
            GIT_COMMITTER_EMAIL: "opentag@localhost",
          },
          signal,
          timeout: 120_000,
          maxBuffer: 1024 * 1024,
          windowsHide: true,
        })
      ).stdout.trim();
    };
    return execute;
  }

  async #publish(
    frame: ContextTreeOperationFrame,
    setup: string,
    run: Run,
    execute: ProcessRun,
    environment: NodeJS.ProcessEnv,
  ): Promise<Result | string> {
    const input = frame.input;
    if (input.path !== ".") return failed("invalid_tree");
    if (!hasManagedGitHubTransport(environment)) return failed("authentication_required");
    const publicationFile = join(setup, "publication.json");
    const tree = join(setup, "tree");
    const previous = await readDurableJson(publicationFile, PublicationSchema.parse);
    const remote = `https://github.com/${input.repository}.git`;
    if (previous) return recoverPublication(previous, input.ref, remote, execute, publicationFile);
    const sha = await stageTree(input, setup, run, execute);
    if (typeof sha !== "string") return sha;
    const ref = input.ref === "HEAD" ? await execute("git", ["symbolic-ref", "--short", "HEAD"], tree) : input.ref;
    // Persist intent before the first remote mutation. Never blindly recreate after a lost response.
    await writeDurableFile(publicationFile, JSON.stringify({ sha, ref, complete: false }));
    try {
      await execute("gh", ["repo", "create", input.repository, "--private"]);
      await execute("git", ["push", remote, `HEAD:refs/heads/${ref}`], tree);
      await writeDurableFile(publicationFile, JSON.stringify({ sha, ref, complete: true }));
      return ref;
    } catch {
      return failed("publication_uncertain");
    }
  }
}
type ProcessRun = (file: string, args: string[], cwd?: string) => Promise<string>;
async function stageTree(
  input: ContextTreeOperationFrame["input"],
  setup: string,
  run: Run,
  execute: ProcessRun,
): Promise<string | Result> {
  const tree = join(setup, "tree");
  const existing = await lstat(join(tree, "NODE.md")).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  });
  const initialized = await run(
    existing ? ["verify", "--tree-path", tree, "--json"] : ["init", tree, "--project-path", setup, "--json"],
  );
  if (initialized.failureCode) return classify(initialized.failureCode);
  await execute("git", [
    "-c",
    "init.templateDir=",
    "init",
    ...(input.ref === "HEAD" ? [] : ["--initial-branch", input.ref]),
    tree,
  ]);
  let sha: string;
  try {
    sha = await execute("git", ["rev-parse", "--verify", "HEAD"], tree);
  } catch {
    await execute("git", ["add", "--", "NODE.md"], tree);
    await execute(
      "git",
      ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "commit", "-m", "docs: initialize context tree"],
      tree,
    );
    sha = await execute("git", ["rev-parse", "HEAD"], tree);
  }
  return /^[a-f0-9]{40}$/.test(sha) ? sha : failed("failed");
}

async function remoteDefaultBranch(repository: string, execute: ProcessRun): Promise<string> {
  const head = await execute("git", ["ls-remote", "--symref", `https://github.com/${repository}.git`, "HEAD"]);
  const ref = /^ref: refs\/heads\/(.+)\s+HEAD$/mu.exec(head)?.[1];
  if (!ref) throw new Error("Repository has no default branch");
  return ref;
}

async function recoverPublication(
  previous: z.infer<typeof PublicationSchema>,
  requestedRef: string,
  remote: string,
  execute: ProcessRun,
  publicationFile: string,
): Promise<Result | string> {
  if (requestedRef !== "HEAD" && previous.ref !== requestedRef) return failed("stale_configuration");
  if (previous.complete) return previous.ref;
  try {
    const head = await execute("git", ["ls-remote", "--exit-code", remote, `refs/heads/${previous.ref}`]);
    if (head.split(/\s/u)[0] !== previous.sha) return failed("publication_uncertain");
    await writeDurableFile(publicationFile, JSON.stringify({ ...previous, complete: true }));
    return previous.ref;
  } catch {
    return failed("publication_uncertain");
  }
}

const PublicationSchema = z
  .object({ sha: z.string().regex(/^[a-f0-9]{40}$/), ref: z.string(), complete: z.boolean() })
  .strict();

async function verifyRepository(
  input: ContextTreeOperationFrame["input"],
  project: string[],
  run: Run,
): Promise<Result> {
  const connected = await run(["connect", input.repository, "--path", input.path, "--ref", input.ref, ...project]);
  if (connected.failureCode) return classify(connected.failureCode);
  const parsed = resolvedTreeSchema.extend({ schemaVersion: z.literal(SCHEMA_VERSION) }).safeParse(connected.payload);
  if (
    !parsed.success ||
    parsed.data.connection.source.kind !== "git" ||
    contextTreeIdentity(parsed.data.connection.source) !== contextTreeIdentity(input)
  )
    return failed("invalid_tree");
  return { status: "completed", repository: input.repository };
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error("Context Tree operation cancelled"));
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function failed(code: Extract<Result, { status: "failed" }>["code"]): Result {
  return { status: "failed", code };
}
function classify(code: string): Result {
  if (code === "BUSY") return failed("busy");
  if (["INVALID_TREE", "DIRTY_TREE", "NO_CONNECTION"].includes(code)) return failed("invalid_tree");
  return failed("failed");
}
