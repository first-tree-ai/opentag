import { createReadStream } from "node:fs";
import { type FileHandle, mkdir, mkdtemp, open, readdir, rm } from "node:fs/promises";
import { isIP } from "node:net";
import { join, relative, resolve, sep } from "node:path";
import {
  RUNNER_WORKSPACE_ARCHIVE_MAX_BYTES,
  RUNNER_WORKSPACE_PATH,
  RUNNER_WORKSPACE_TIMEOUT_MS,
  type RunnerWorkspaceObject,
  RunnerWorkspaceObjectSchema,
} from "@opentag/shared";
import {
  createWorkspaceArchive,
  restoreWorkspaceArchive,
  WorkspaceArchiveError,
  type WorkspaceArchiveInfo,
} from "./workspace-archive.js";

export class CloudWorkspaceError extends Error {
  constructor(
    readonly code: "restore_failed" | "save_failed" | "scope_unavailable",
    readonly retryable = true,
  ) {
    super(`Cloud workspace ${code}`);
    this.name = "CloudWorkspaceError";
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
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new CloudWorkspaceError("save_failed");
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      total += item.value.byteLength;
      if (total > 16 * 1024) throw new CloudWorkspaceError("save_failed");
      chunks.push(item.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
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
  #restored = false;
  #pendingSave = false;
  #terminalFailure = false;
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
    return this.#terminalFailure;
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
        const object = await this.#claim();
        this.#object = object;
        if (object.sealed) return;
        await mkdir(this.#options.workspace, { recursive: true, mode: 0o700 });
        if ((await readdir(this.#options.workspace)).length !== 0) throw new CloudWorkspaceError("restore_failed");
        if (object.saved) {
          await this.#temporaryArchive(async (path) => {
            await this.#download(object, path);
            await restoreWorkspaceArchive(path, this.#options.workspace, object);
          });
        }
        this.#restored = true;
        // Even a saved restore commits once before readiness. This CAS fences an upload still
        // in flight from a prior process of the SAME allocation, without a second runtime epoch.
        await this.#save(false);
      } catch {
        throw new CloudWorkspaceError("restore_failed");
      }
    });
  }

  save(sealed = false): Promise<void> {
    return this.#enqueue(() => this.#save(sealed));
  }

  async #save(sealed: boolean): Promise<void> {
    if (this.#terminalFailure) throw new CloudWorkspaceError("save_failed", false);
    if (this.sealed) {
      if (sealed) return;
      throw new CloudWorkspaceError("save_failed");
    }
    const previous = this.#object;
    if (!previous || !this.#restored) throw new CloudWorkspaceError("restore_failed");
    this.#pendingSave = true;
    try {
      await this.#temporaryArchive(async (path) => {
        const info = await createWorkspaceArchive(this.#options.workspace, path);
        this.#object = await this.#upload(path, previous, info, sealed);
      });
      this.#pendingSave = false;
    } catch (error) {
      if (
        error instanceof WorkspaceArchiveError &&
        ["too-many-entries", "workspace-too-large", "archive-too-large", "unsafe-entry", "unsupported-entry"].includes(
          error.code,
        )
      ) {
        this.#terminalFailure = true;
      }
      throw new CloudWorkspaceError("save_failed", !this.#terminalFailure);
    }
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
      throw new CloudWorkspaceError("scope_unavailable");
    }
    return { authorization: `Bearer ${token}` };
  }

  #signal(): AbortSignal {
    return AbortSignal.timeout(this.#options.timeoutMs ?? RUNNER_WORKSPACE_TIMEOUT_MS);
  }

  #parseObject(value: unknown): RunnerWorkspaceObject {
    const object = RunnerWorkspaceObjectSchema.parse(value);
    if (object.ownerGeneration !== this.#options.environmentGeneration()) {
      throw new CloudWorkspaceError("scope_unavailable");
    }
    return object;
  }

  async #claim(): Promise<RunnerWorkspaceObject> {
    const response = await this.#fetch(`${this.#url}/claim`, {
      method: "POST",
      headers: { ...this.#headers(), "content-type": "application/json" },
      body: "{}",
      redirect: "error",
      signal: this.#signal(),
    });
    return this.#parseObject(await boundedJson(response));
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
    const body = createReadStream(path);
    try {
      const init: RequestInit & { duplex: "half" } = {
        method: "PUT",
        headers: {
          ...this.#headers(),
          "content-type": "application/octet-stream",
          "content-length": String(info.bytes),
          "x-opentag-storage-generation": previous.generation,
          "x-opentag-storage-metageneration": previous.metageneration,
          "x-opentag-workspace-sha256": info.sha256,
          "content-md5": info.md5,
          "x-opentag-workspace-sealed": String(sealed),
        },
        body: body as unknown as NonNullable<RequestInit["body"]>,
        duplex: "half",
        redirect: "error",
        signal: this.#signal(),
      };
      const object = this.#parseObject(await boundedJson(await this.#fetch(`${this.#url}/archive`, init)));
      if (!this.#confirmsWrite(object, previous, info, sealed)) throw new CloudWorkspaceError("save_failed");
      return object;
    } catch {
      // An unavailable response is not evidence of failure. Verify the intended write, but never
      // adopt an unrelated newer object as the base for uploading stale local bytes.
      const current = await this.#claim();
      if (!this.#confirmsWrite(current, previous, info, sealed)) throw new CloudWorkspaceError("save_failed");
      return current;
    } finally {
      body.destroy();
    }
  }

  #confirmsWrite(
    object: RunnerWorkspaceObject,
    previous: RunnerWorkspaceObject,
    info: WorkspaceArchiveInfo,
    sealed: boolean,
  ): boolean {
    return (
      object.generation !== previous.generation &&
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
