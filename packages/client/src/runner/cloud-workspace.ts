import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { type FileHandle, mkdir, mkdtemp, open, readdir, rename, rm } from "node:fs/promises";
import { isIP } from "node:net";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { setTimeout as retryDelay } from "node:timers/promises";
import {
  RUNNER_WORKSPACE_ARCHIVE_MAX_BYTES,
  RUNNER_WORKSPACE_PATH,
  RUNNER_WORKSPACE_TIMEOUT_MS,
  type RunnerWorkspaceObject,
  RunnerWorkspaceObjectSchema,
} from "@opentag/shared";
import { type RunnerPerformanceSink, traceRunnerOperation } from "./perf-log.js";
import {
  createWorkspaceArchive,
  fingerprintWorkspace,
  restoreWorkspaceArchive,
  WorkspaceArchiveError,
  type WorkspaceArchiveErrorCode,
  type WorkspaceArchiveInfo,
} from "./workspace-archive.js";

const CLOUD_WORKSPACE_SAVE_MAX_ATTEMPTS = 3;
const CLOUD_WORKSPACE_RETRY_DELAY_MS = 1000;

export class CloudWorkspaceError extends Error {
  readonly archiveErrorCode?: WorkspaceArchiveErrorCode;
  readonly httpStatus?: number;

  constructor(
    readonly code: "restore_failed" | "save_failed" | "scope_unavailable",
    readonly retryable = true,
    options?: ErrorOptions & { httpStatus?: number },
  ) {
    const cause = options?.cause;
    const archiveErrorCode =
      cause instanceof WorkspaceArchiveError
        ? cause.code
        : cause instanceof CloudWorkspaceError
          ? cause.archiveErrorCode
          : undefined;
    const httpStatus = options?.httpStatus ?? (cause instanceof CloudWorkspaceError ? cause.httpStatus : undefined);
    super(
      `Cloud workspace ${code}${archiveErrorCode ? ` (${archiveErrorCode})` : httpStatus ? ` (HTTP ${httpStatus})` : ""}`,
      options,
    );
    this.name = "CloudWorkspaceError";
    this.archiveErrorCode = archiveErrorCode;
    this.httpStatus = httpStatus;
  }
}

export interface CloudWorkspaceOptions {
  backendUrl: string;
  workspace: string;
  /** Private trusted parent directory, outside every Sandbox mount. */
  stateDirectory: string;
  token: () => string;
  environmentGeneration: () => number | undefined;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  retryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  onPerformanceLog?: RunnerPerformanceSink;
}

function outside(root: string, target: string): boolean {
  const path = relative(resolve(root), resolve(target));
  return path === ".." || path.startsWith(`..${sep}`);
}

function workspaceOrigin(raw: string): string {
  const url = new URL(raw);
  if (url.username || url.password || url.search || url.hash) throw new CloudWorkspaceError("scope_unavailable");
  if (url.protocol === "wss:") url.protocol = "https:";
  if (url.protocol === "ws:") url.protocol = "http:";
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const local = host === "localhost" || host === "::1" || (isIP(host) === 4 && host.startsWith("127."));
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new CloudWorkspaceError("scope_unavailable");
  }
  return `${url.origin}${RUNNER_WORKSPACE_PATH}`;
}

async function boundedJson(response: Response): Promise<unknown> {
  if (!response.ok) {
    await response.body?.cancel();
    throw new CloudWorkspaceError("save_failed", [408, 429].includes(response.status) || response.status >= 500, {
      httpStatus: response.status,
    });
  }
  if (!response.body) throw new CloudWorkspaceError("save_failed", false);
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      total += item.value.byteLength;
      if (total > 16 * 1024) throw new CloudWorkspaceError("save_failed", false);
      chunks.push(item.value);
    }
  } catch (error) {
    throw error instanceof CloudWorkspaceError ? error : new CloudWorkspaceError("save_failed", true, { cause: error });
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    throw new CloudWorkspaceError("save_failed", false, { cause: error });
  }
}

/**
 * Latest-state transfer in the trusted parent. The caller exclusively owns the native namespace
 * and MUST stop every workspace writer before initialize/save. Reconnects retry unsaved local
 * bytes; they never re-extract an older archive over an initialized workspace.
 */
export class CloudWorkspace {
  readonly #options: CloudWorkspaceOptions;
  readonly #url: string;
  readonly #fetch: typeof fetch;
  #object?: RunnerWorkspaceObject;
  #fingerprint?: string;
  #restored = false;
  #pendingSave = false;
  #rollbackPending = false;
  #terminalFailure?: CloudWorkspaceError;
  #serial: Promise<unknown> = Promise.resolve();

  constructor(options: CloudWorkspaceOptions) {
    if (!outside(options.workspace, options.stateDirectory) || !outside(options.stateDirectory, options.workspace)) {
      throw new CloudWorkspaceError("scope_unavailable");
    }
    this.#options = options;
    this.#url = workspaceOrigin(options.backendUrl);
    this.#fetch = options.fetchImpl ?? fetch;
  }

  get initialized(): boolean {
    return this.#restored;
  }
  get pendingSave(): boolean {
    return this.#pendingSave;
  }
  /** An unchanged directory cannot recover from an archive format/size violation by retrying. */
  get terminalFailure(): boolean {
    return this.#terminalFailure !== undefined;
  }
  get sealed(): boolean {
    return this.#object?.sealed === true;
  }

  initialize(): Promise<void> {
    return this.#enqueue(async () => {
      if (this.sealed) return;
      if (this.#restored) {
        if (this.#pendingSave) await this.#save(false);
        return;
      }
      try {
        const object = await this.#claim(this.#signal(), { fence: true });
        this.#object = object;
        if (object.sealed) {
          this.#rollbackPending = false;
          return;
        }
        await traceRunnerOperation(
          this.#options.onPerformanceLog,
          "runner.workspace.restore",
          async (addMetrics) => {
            await this.#restoreFromObject(object, this.#rollbackPending, addMetrics);
          },
          {
            environmentGeneration: this.#options.environmentGeneration(),
            workspaceGeneration: object.generation,
            saved: object.saved,
            sealed: object.sealed,
            ...(object.saved ? { archiveBytes: object.bytes } : {}),
          },
        );
        this.#rollbackPending = false;
        this.#restored = true;
        if (object.saved) this.#fingerprint = await fingerprintWorkspace(this.#options.workspace);
        else await this.#save(false);
      } catch (error) {
        throw new CloudWorkspaceError("restore_failed", true, { cause: error });
      }
    });
  }

  /**
   * Discard unsaved pre-prompt workspace dirt and restore the last committed archive baseline.
   * Only valid when a Turn failed before prompt acceptance (`executionEffects === "not_started"`).
   */
  rollback(): Promise<void> {
    return this.#enqueue(async () => {
      if (this.sealed) return;
      this.#restored = false;
      this.#fingerprint = undefined;
      this.#pendingSave = false;
      this.#terminalFailure = undefined;
      this.#rollbackPending = true;
      try {
        const object = await this.#claim();
        this.#object = object;
        if (object.sealed) {
          this.#rollbackPending = false;
          return;
        }
        await traceRunnerOperation(
          this.#options.onPerformanceLog,
          "runner.workspace.restore",
          async (addMetrics) => {
            await this.#restoreFromObject(object, true, addMetrics);
          },
          {
            environmentGeneration: this.#options.environmentGeneration(),
            workspaceGeneration: object.generation,
            saved: object.saved,
            sealed: object.sealed,
            ...(object.saved ? { archiveBytes: object.bytes } : {}),
          },
        );
        this.#rollbackPending = false;
        this.#restored = true;
        if (object.saved) this.#fingerprint = await fingerprintWorkspace(this.#options.workspace);
      } catch (error) {
        throw new CloudWorkspaceError("restore_failed", true, { cause: error });
      }
    });
  }

  async #restoreFromObject(
    object: RunnerWorkspaceObject,
    replaceExisting: boolean,
    addMetrics?: (metrics: { archiveBytes?: number; workspaceBytes?: number; entryCount?: number }) => void,
  ): Promise<void> {
    if (!replaceExisting) {
      await mkdir(this.#options.workspace, { recursive: true, mode: 0o700 });
      if ((await readdir(this.#options.workspace)).length !== 0) throw new CloudWorkspaceError("restore_failed");
      if (object.saved) {
        await this.#temporaryArchive(async (path) => {
          await this.#download(object, path);
          await restoreWorkspaceArchive(path, this.#options.workspace, object, {
            onStats: (stats) => addMetrics?.(stats),
          });
        });
      }
      return;
    }
    if (!object.saved) {
      await rm(this.#options.workspace, { recursive: true, force: true });
      await mkdir(this.#options.workspace, { recursive: true, mode: 0o700 });
      return;
    }
    const workspacePath = resolve(this.#options.workspace);
    const parent = dirname(workspacePath);
    await mkdir(parent, { recursive: true });
    const staging = await mkdtemp(join(parent, `.${basename(workspacePath)}.rollback-`));
    try {
      await this.#temporaryArchive(async (path) => {
        await this.#download(object, path);
        await restoreWorkspaceArchive(path, staging, object, {
          onStats: (stats) => addMetrics?.(stats),
        });
      });
      await rm(workspacePath, { recursive: true, force: true });
      await rename(staging, workspacePath);
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
  }

  save(sealed = false): Promise<void> {
    return this.#enqueue(() => this.#save(sealed));
  }

  async #save(sealed: boolean): Promise<void> {
    if (this.#terminalFailure) throw this.#terminalFailure;
    if (this.sealed) {
      if (sealed) return;
      throw new CloudWorkspaceError("save_failed");
    }
    const previous = this.#object;
    if (!previous || !this.#restored) throw new CloudWorkspaceError("restore_failed");
    this.#pendingSave = true;
    await traceRunnerOperation(
      this.#options.onPerformanceLog,
      sealed ? "runner.workspace.seal" : "runner.workspace.save",
      async (addMetrics) => {
        try {
          const fingerprint = await fingerprintWorkspace(this.#options.workspace);
          const object =
            sealed && previous.saved && fingerprint === this.#fingerprint
              ? await this.#seal(previous)
              : await this.#temporaryArchive(async (path) => {
                  const info = await createWorkspaceArchive(this.#options.workspace, path, {
                    onStats: (stats) => addMetrics(stats),
                  });
                  const uploaded = await this.#upload(path, previous, info, sealed);
                  // Keep the confirmed version and its baseline together if local cleanup fails.
                  this.#object = uploaded;
                  this.#fingerprint = fingerprint;
                  return uploaded;
                });
          this.#object = object;
          this.#fingerprint = fingerprint;
          addMetrics({
            workspaceGeneration: object.generation,
            saved: object.saved,
            sealed: object.sealed,
          });
          this.#pendingSave = false;
        } catch (error) {
          if (
            error instanceof WorkspaceArchiveError &&
            [
              "too-many-entries",
              "workspace-too-large",
              "archive-too-large",
              "unsafe-entry",
              "unsupported-entry",
            ].includes(error.code)
          ) {
            this.#terminalFailure = new CloudWorkspaceError("save_failed", false, { cause: error });
          }
          throw (
            this.#terminalFailure ??
            (error instanceof CloudWorkspaceError
              ? error
              : new CloudWorkspaceError("save_failed", true, { cause: error }))
          );
        }
      },
      {
        environmentGeneration: this.#options.environmentGeneration(),
        sealed,
      },
    );
  }

  async #temporaryArchive<T>(operation: (path: string) => Promise<T>): Promise<T> {
    await mkdir(this.#options.stateDirectory, { recursive: true, mode: 0o700 });
    const directory = await mkdtemp(join(this.#options.stateDirectory, "workspace-"));
    try {
      return await operation(join(directory, "state.tar.gz"));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  #headers(): Record<string, string> {
    const generation = this.#options.environmentGeneration();
    const token = this.#options.token();
    if (!token || generation === undefined || !Number.isSafeInteger(generation) || generation < 1) {
      throw new CloudWorkspaceError("scope_unavailable", false);
    }
    return { authorization: `Bearer ${token}` };
  }

  #signal(): AbortSignal {
    return AbortSignal.timeout(this.#options.timeoutMs ?? RUNNER_WORKSPACE_TIMEOUT_MS);
  }

  #parseObject(value: unknown): RunnerWorkspaceObject {
    const parsed = RunnerWorkspaceObjectSchema.safeParse(value);
    if (!parsed.success) throw new CloudWorkspaceError("save_failed", false, { cause: parsed.error });
    const object = parsed.data;
    if (object.ownerGeneration !== this.#options.environmentGeneration()) {
      throw new CloudWorkspaceError("scope_unavailable", false);
    }
    return object;
  }

  async #claim(
    signal = this.#signal(),
    options: {
      fence?: true;
      upload?: Pick<RunnerWorkspaceObject, "generation" | "metageneration"> & { id: string };
    } = {},
  ): Promise<RunnerWorkspaceObject> {
    signal.throwIfAborted();
    const response = await this.#fetch(`${this.#url}/claim`, {
      method: "POST",
      headers: { ...this.#headers(), "content-type": "application/json" },
      body: JSON.stringify(options),
      redirect: "error",
      signal,
    });
    return this.#parseObject(await boundedJson(response));
  }

  async #seal(previous: RunnerWorkspaceObject): Promise<RunnerWorkspaceObject> {
    const signal = this.#signal();
    const confirmsSeal = (object: RunnerWorkspaceObject) =>
      this.#sameObject(object, {
        ...previous,
        metageneration: String(BigInt(previous.metageneration) + 1n),
        sealed: true,
      });
    try {
      const response = await this.#fetch(`${this.#url}/seal`, {
        method: "POST",
        headers: { ...this.#headers(), "content-type": "application/json" },
        body: JSON.stringify({ generation: previous.generation, metageneration: previous.metageneration }),
        redirect: "error",
        signal,
      });
      const object = this.#parseObject(await boundedJson(response));
      if (!confirmsSeal(object)) throw new CloudWorkspaceError("save_failed", false);
      return object;
    } catch (error) {
      // Readback never fences or adopts a new base. An uncertain PATCH is not retried here.
      const current = await this.#claim(signal);
      if (!confirmsSeal(current)) throw error;
      return current;
    }
  }

  async #download(object: RunnerWorkspaceObject, path: string): Promise<void> {
    const url = new URL(`${this.#url}/archive`);
    url.searchParams.set("generation", object.generation);
    url.searchParams.set("metageneration", object.metageneration);
    const response = await this.#fetch(url, { headers: this.#headers(), redirect: "error", signal: this.#signal() });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new CloudWorkspaceError("restore_failed");
    }
    const reader = response.body.getReader();
    let file: FileHandle | undefined;
    let bytes = 0;
    try {
      file = await open(path, "wx", 0o600);
      for (;;) {
        const item = await reader.read();
        if (item.done) break;
        bytes += item.value.byteLength;
        if (bytes > object.bytes || bytes > RUNNER_WORKSPACE_ARCHIVE_MAX_BYTES) {
          throw new CloudWorkspaceError("restore_failed");
        }
        // writeFile on an open handle writes the complete chunk at the current file position.
        await file.writeFile(item.value);
      }
      if (bytes !== object.bytes) throw new CloudWorkspaceError("restore_failed");
      await file.sync();
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
      await file?.close();
    }
  }

  async #upload(
    path: string,
    previous: RunnerWorkspaceObject,
    info: WorkspaceArchiveInfo,
    sealed: boolean,
  ): Promise<RunnerWorkspaceObject> {
    const signal = this.#signal();
    const writeId = randomUUID();
    for (let attempt = 0; ; attempt += 1) {
      signal.throwIfAborted();
      try {
        const object = await this.#putArchive(path, previous, info, sealed, writeId, signal);
        if (!this.#confirmsWrite(object, previous, info, sealed)) throw new CloudWorkspaceError("save_failed", false);
        return object;
      } catch (error) {
        const confirmed = await this.#verifyFailedUpload(error, previous, info, sealed, writeId, signal);
        if (confirmed) return confirmed;
        if (attempt === CLOUD_WORKSPACE_SAVE_MAX_ATTEMPTS - 1) throw error;
        await this.#waitBackoff(attempt, signal);
      }
    }
  }

  async #waitBackoff(attempt: number, signal: AbortSignal): Promise<void> {
    const delayMs = (this.#options.retryDelayMs ?? CLOUD_WORKSPACE_RETRY_DELAY_MS) * 2 ** attempt;
    if (this.#options.sleep) await this.#options.sleep(delayMs);
    else await retryDelay(delayMs, undefined, { signal });
  }

  async #verifyFailedUpload(
    error: unknown,
    previous: RunnerWorkspaceObject,
    info: WorkspaceArchiveInfo,
    sealed: boolean,
    writeId: string,
    signal: AbortSignal,
  ): Promise<RunnerWorkspaceObject | undefined> {
    if (
      error instanceof CloudWorkspaceError &&
      (error.code === "scope_unavailable" || (error.httpStatus !== undefined && !error.retryable))
    ) {
      throw error;
    }
    // A missing response may hide a committed write. Only an unchanged original object
    // permits another conditional upload; an unrelated newer object is never a new base.
    const current = await this.#claim(signal, {
      upload: { id: writeId, generation: previous.generation, metageneration: previous.metageneration },
    });
    if (this.#confirmsWrite(current, previous, info, sealed)) return current;
    if (!this.#sameObject(current, previous)) throw new CloudWorkspaceError("save_failed", false, { cause: error });
    if (!(error instanceof CloudWorkspaceError && error.retryable)) throw error;
    return undefined;
  }

  async #putArchive(
    path: string,
    previous: RunnerWorkspaceObject,
    info: WorkspaceArchiveInfo,
    sealed: boolean,
    writeId: string,
    signal: AbortSignal,
  ): Promise<RunnerWorkspaceObject> {
    if (previous.ownerGeneration !== this.#options.environmentGeneration()) {
      throw new CloudWorkspaceError("scope_unavailable", false);
    }
    const headers = this.#headers();
    const body = createReadStream(path);
    try {
      const init: RequestInit & { duplex: "half" } = {
        method: "PUT",
        headers: {
          ...headers,
          "content-type": "application/octet-stream",
          "content-length": String(info.bytes),
          "x-opentag-storage-generation": previous.generation,
          "x-opentag-storage-metageneration": previous.metageneration,
          "x-opentag-workspace-sha256": info.sha256,
          "content-md5": info.md5,
          "x-opentag-workspace-sealed": String(sealed),
          "x-opentag-workspace-write-id": writeId,
        },
        body: body as unknown as NonNullable<RequestInit["body"]>,
        duplex: "half",
        redirect: "error",
        signal,
      };
      let response: Response;
      try {
        response = await this.#fetch(`${this.#url}/archive`, init);
      } catch (error) {
        throw new CloudWorkspaceError("save_failed", true, { cause: error });
      }
      return this.#parseObject(await boundedJson(response));
    } finally {
      body.destroy();
    }
  }

  #sameObject(object: RunnerWorkspaceObject, previous: RunnerWorkspaceObject): boolean {
    return (
      object.generation === previous.generation &&
      object.metageneration === previous.metageneration &&
      object.ownerGeneration === previous.ownerGeneration &&
      object.saved === previous.saved &&
      object.sealed === previous.sealed &&
      object.bytes === previous.bytes &&
      object.sha256 === previous.sha256 &&
      object.md5 === previous.md5
    );
  }

  #confirmsWrite(
    object: RunnerWorkspaceObject,
    previous: RunnerWorkspaceObject,
    info: WorkspaceArchiveInfo,
    sealed: boolean,
  ): boolean {
    return (
      object.generation !== previous.generation &&
      object.metageneration === "1" &&
      object.ownerGeneration === previous.ownerGeneration &&
      object.saved &&
      object.sealed === sealed &&
      object.bytes === info.bytes &&
      object.sha256 === info.sha256 &&
      object.md5 === info.md5
    );
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.#serial.then(operation, operation);
    this.#serial = pending.catch(() => undefined);
    return pending;
  }
}
