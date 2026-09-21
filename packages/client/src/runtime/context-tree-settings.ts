import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  type ContextTreeOperationFrame,
  type ContextTreeOperationResponse,
  ContextTreeOperationResponseSchema,
} from "@opentag/shared";
import { z } from "zod";
import { ensurePrivateDirectory, readDurableJson, writeDurableFile } from "../storage/durable-file.js";
import {
  managedRepositoryAllowed,
  mergeContextTreeEnvironment,
  resolveContextTreePackage,
  runContextTreeCli,
} from "./context-tree.js";

const RecordSchema = z.object({ fingerprint: z.string(), result: ContextTreeOperationResponseSchema }).strict();
type Result = ContextTreeOperationResponse;
type Run = (args: readonly string[], signal?: AbortSignal) => Promise<{ payload: unknown; failureCode?: string }>;
const TREE_PATH = z.object({ tree: z.object({ path: z.string().min(1) }) });

/** Keep the hash inside the CLI's 40-character project-name limit. */
export function contextTreeStagingName(repository: string): string {
  const identity = repository.toLowerCase();
  const readable = identity.replace(/[^a-z0-9.-]+/g, "-").slice(0, 27);
  return `${readable}-${createHash("sha256").update(identity).digest("hex").slice(0, 12)}`;
}

function fingerprint(frame: ContextTreeOperationFrame): string {
  const input = frame.input;
  return JSON.stringify([
    frame.agentId,
    input.action,
    input.alias,
    input.repository?.toLowerCase() ?? null,
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
      budgetMs?: number;
      /**
       * Trusted credential mode. Settings operations never fall back to ambient host credentials:
       * network actions require `managedEnvironment` and otherwise fail with
       * `authentication_required`. Legacy Local settings keep the existing behavior.
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
    const budget = this.options.budgetMs ?? 240_000;
    const work = new AbortController();
    const totalTimer = setTimeout(() => controller.abort(), budget);
    const workTimer = setTimeout(() => work.abort(), Math.max(1, budget - Math.min(10_000, budget / 10)));
    const signal = AbortSignal.any([controller.signal, work.signal]);
    try {
      return await this.#execute(frame, signal, controller.signal);
    } catch {
      return failed("failed");
    } finally {
      clearTimeout(totalTimer);
      clearTimeout(workTimer);
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
        return await abortable(run(args, cancellation), cancellation);
      };
      // The same queue protects runtime preparation and settings calls. Verification is read-only.
      if (args[0] === "verify") return execute();
      const queued = this.options.exclusive(execute);
      // The caller can time out while this remains queued. Observe the later rejection too.
      void queued.catch(() => undefined);
      return abortable(queued, cancellation);
    };
  }

  async #execute(frame: ContextTreeOperationFrame, signal: AbortSignal, cleanupSignal: AbortSignal): Promise<Result> {
    if (frame.requireStopped && this.options.hasAgentSessions(frame.agentId)) return failed("busy");
    const input = frame.input;
    const managedEnvironment = input.action === "disconnect" ? undefined : this.options.managedEnvironment?.();
    if (this.options.managedCredentials && input.action !== "disconnect" && !managedEnvironment) {
      // No managed GitHub authority is available for this Computer; never fall back to ambient
      // host credentials (`gh auth login`, user git config) in proxy mode.
      return failed("authentication_required");
    }
    if (
      managedEnvironment &&
      input.action === "connect" &&
      input.repository &&
      !managedRepositoryAllowed(managedEnvironment, input.repository)
    ) {
      // Explicit consistency check: the selected repository must be inside the managed grant set.
      return failed("permission_denied");
    }
    const run = this.#runner(frame, signal, managedEnvironment);
    if (!run) return failed("capability_missing");
    return this.#executeRecorded(frame, run, cleanupSignal);
  }

  async #executeRecorded(frame: ContextTreeOperationFrame, run: Run, cleanupSignal: AbortSignal): Promise<Result> {
    const input = frame.input;
    const directory = join(this.options.home, "state", "context-tree-operations");
    await ensurePrivateDirectory(this.options.home, directory);
    const recordFile = join(directory, `${input.operationId}.json`);
    const previous = await readDurableJson(recordFile, RecordSchema.parse);
    if (previous) return previous.fingerprint === fingerprint(frame) ? previous.result : failed("stale_configuration");
    const identity = fingerprint(frame);
    if (input.action === "disconnect")
      return this.#save(recordFile, identity, { status: "completed", repository: null });
    if (!input.repository) return failed("failed");
    const setup = join(directory, contextTreeStagingName(input.repository));
    await ensurePrivateDirectory(this.options.home, setup);
    const project = ["--project-path", setup, "--json"];
    const result = await this.#runRepositoryOperation(input, directory, project, run);
    return this.#save(recordFile, identity, await this.#cleanup(project, result, run, cleanupSignal));
  }

  async #save(recordFile: string, identity: string, result: Result): Promise<Result> {
    await writeDurableFile(recordFile, JSON.stringify({ fingerprint: identity, result }));
    return result;
  }

  async #runRepositoryOperation(
    input: ContextTreeOperationFrame["input"],
    directory: string,
    project: string[],
    run: Run,
  ): Promise<Result> {
    const publication =
      input.action === "create" ? await this.#publish(directory, input.repository as string, project, run) : undefined;
    return publication ?? verifyRepository(input.repository as string, project, run);
  }

  async #cleanup(project: string[], result: Result, run: Run, signal: AbortSignal): Promise<Result> {
    try {
      const cleanup = await run(["disconnect", "--all", ...project], signal);
      return cleanup.failureCode && result.status === "completed" ? failed("failed") : result;
    } catch {
      return result.status === "completed" ? failed("failed") : result;
    }
  }

  async #publish(directory: string, repository: string, project: string[], run: Run): Promise<Result | undefined> {
    const publicationFile = join(
      directory,
      `publication-${createHash("sha256").update(repository.toLowerCase()).digest("hex")}.json`,
    );
    const previous = await readDurableJson(publicationFile, ContextTreeOperationResponseSchema.parse);
    if (previous?.status === "completed") return undefined;
    if (previous?.status === "failed" && previous.code === "publication_uncertain") return previous;
    // A retry can reconnect the deterministic managed staging tree after the temporary connection was removed.
    const staged = await run([
      "connect",
      `${contextTreeStagingName(repository)}-context-tree`,
      "--as",
      "settings",
      ...project,
    ]);
    if (staged.failureCode) {
      const created = await run(["create", "--as", "settings", ...project]);
      if (created.failureCode) return classify(created.failureCode);
    }
    await writeDurableFile(publicationFile, JSON.stringify(failed("publication_uncertain")));
    try {
      const published = await run(["publish", repository, "--tree", "settings", ...project]);
      const outcome: Result = published.failureCode
        ? classify(published.failureCode, true)
        : { status: "completed", repository };
      await writeDurableFile(publicationFile, JSON.stringify(outcome));
      return outcome.status === "failed" ? outcome : undefined;
    } catch {
      // Only failures after the durable publication fence can hide a remote publication.
      return failed("publication_uncertain");
    }
  }
}

async function verifyRepository(repository: string, project: string[], run: Run): Promise<Result> {
  const connected = await run(["connect", repository, "--as", "settings", ...project]);
  if (connected.failureCode) return classify(connected.failureCode);
  const payload = TREE_PATH.safeParse(connected.payload);
  if (!payload.success) return failed("invalid_tree");
  const verified = await run(["verify", "--tree-path", payload.data.tree.path, "--json"]);
  return verified.failureCode ? failed("invalid_tree") : { status: "completed", repository };
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
function classify(code: string, publishing = false): Result {
  if (code === "GITHUB_AUTH") return failed("authentication_required");
  if (code === "GITHUB_PERMISSION") return failed("permission_denied");
  if (code === "REPOSITORY_EXISTS") return failed("repository_exists");
  if (code === "PUBLISH_INCOMPLETE" || publishing) return failed("publication_uncertain");
  if (["INVALID_TREE", "DIRTY_TREE", "NO_CONNECTION"].includes(code)) return failed("invalid_tree");
  return failed("failed");
}
