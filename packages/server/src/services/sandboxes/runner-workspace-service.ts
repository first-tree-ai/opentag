import type { RunnerWorkspaceObject } from "@opentag/shared";
import type { DatabaseClient } from "../../db/client.js";
import type { sandboxes } from "../../db/schema/index.js";
import { loadSandboxRecordById } from "./owned-sandbox.js";
import type { RunnerBootstrapTokenService } from "./runner-bootstrap-token.js";
import type { RunnerHub, RunnerScope } from "./runner-hub.js";
import type { SandboxRunnerService } from "./sandbox-runner-service.js";
import {
  type WorkspaceObjectScope,
  type WorkspaceObjectStore,
  WorkspaceObjectStoreError,
  type WorkspaceObjectWriteInput,
} from "./workspace-object-store.js";

/**
 * E5 Runner workspace HTTP authority. The Runner transfers archive bytes over authenticated
 * streaming HTTP while small control messages stay on the WSS channel. Every request:
 * - authenticates with the allocation-scoped bootstrap bearer token (never account auth, and the
 *   caller can never supply a path, URI, bucket, or another Session's storage address — the
 *   Server derives `storageUri` from the database);
 * - is validated against the CURRENT persisted allocation (channel scope, so recovery and the
 *   release seal keep working while releasing or after the Session became inactive);
 * - must belong to the exact current authenticated Runner channel (a token without the live
 *   control connection is not enough);
 * and every store failure maps to a stable redacted error — no credential, header, body, or
 * upstream response content is ever logged or echoed here.
 */

/** Stable wire codes for the Runner workspace API; bodies stay `{ error: { code, message } }`. */
export const RUNNER_WORKSPACE_ERROR_CODES = {
  unauthorized: "RUNNER_WORKSPACE_UNAUTHORIZED",
  staleScope: "RUNNER_WORKSPACE_SCOPE_STALE",
  channelRequired: "RUNNER_WORKSPACE_CHANNEL_REQUIRED",
  badRequest: "RUNNER_WORKSPACE_BAD_REQUEST",
  notFound: "RUNNER_WORKSPACE_NOT_FOUND",
  conflict: "RUNNER_WORKSPACE_CONFLICT",
  unavailable: "RUNNER_WORKSPACE_UNAVAILABLE",
} as const;

export class RunnerWorkspaceError extends Error {
  readonly statusCode: number;
  readonly code: string;
  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = "RunnerWorkspaceError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

export interface RunnerWorkspaceContext {
  readonly scope: RunnerScope;
  readonly row: typeof sandboxes.$inferSelect;
}

export interface RunnerWorkspacePins {
  readonly generation: string;
  readonly metageneration: string;
}

export interface RunnerWorkspaceUploadInput extends RunnerWorkspacePins {
  readonly bytes: number;
  readonly sha256: string;
  readonly md5: string;
  readonly sealed: boolean;
  readonly body: AsyncIterable<Uint8Array>;
}

export interface RunnerWorkspaceServiceOptions {
  readonly tokens: RunnerBootstrapTokenService;
  readonly hub: RunnerHub;
  readonly store: WorkspaceObjectStore;
  readonly runnerService: Pick<SandboxRunnerService, "validateRunnerChannelScope">;
}

const MAX_BEARER_TOKEN_CHARS = 4_096;

function unauthorized(message: string): RunnerWorkspaceError {
  return new RunnerWorkspaceError(401, RUNNER_WORKSPACE_ERROR_CODES.unauthorized, message);
}

function staleScope(message: string): RunnerWorkspaceError {
  return new RunnerWorkspaceError(403, RUNNER_WORKSPACE_ERROR_CODES.staleScope, message);
}

function conflict(message: string): RunnerWorkspaceError {
  return new RunnerWorkspaceError(409, RUNNER_WORKSPACE_ERROR_CODES.conflict, message);
}

function unavailable(message: string): RunnerWorkspaceError {
  return new RunnerWorkspaceError(503, RUNNER_WORKSPACE_ERROR_CODES.unavailable, message);
}

/**
 * Map an adapter failure to a stable, redacted Runner-facing error. The adapter's typed codes are
 * the only detail that crosses; upstream bodies, credentials, and transport causes never do.
 */
function mapStoreError(error: unknown): RunnerWorkspaceError {
  if (error instanceof WorkspaceObjectStoreError) {
    switch (error.code) {
      case "invalid_input":
        return new RunnerWorkspaceError(
          400,
          RUNNER_WORKSPACE_ERROR_CODES.badRequest,
          "The workspace request is invalid",
        );
      case "missing":
        return new RunnerWorkspaceError(404, RUNNER_WORKSPACE_ERROR_CODES.notFound, "No workspace archive exists");
      case "stale":
      case "conflict":
      case "changed":
      case "sealed":
      case "owner_mismatch":
        return conflict("The workspace state conflicts with the current allocation");
      default:
        return unavailable("The workspace store could not complete the operation");
    }
  }
  return unavailable("The workspace store could not complete the operation");
}

export class RunnerWorkspaceService {
  readonly #database: DatabaseClient;
  readonly #tokens: RunnerBootstrapTokenService;
  readonly #hub: RunnerHub;
  readonly #store: WorkspaceObjectStore;
  readonly #runnerService: Pick<SandboxRunnerService, "validateRunnerChannelScope">;
  /** One upload per Sandbox per Server process; a second concurrent attempt conflicts. */
  readonly #uploads = new Set<string>();

  constructor(database: DatabaseClient, options: RunnerWorkspaceServiceOptions) {
    this.#database = database;
    this.#tokens = options.tokens;
    this.#hub = options.hub;
    this.#store = options.store;
    this.#runnerService = options.runnerService;
  }

  /**
   * Authenticate and authorize a Runner workspace request. Runs before any body is consumed.
   * The token must be unexpired, name the exact CURRENT allocation (sandbox, session,
   * environment generation, resource name), and that scope must own the live hub channel.
   */
  async authenticate(authorizationHeader: string | undefined): Promise<RunnerWorkspaceContext> {
    const token = bearerToken(authorizationHeader);
    if (!token) throw unauthorized("A Runner bootstrap bearer token is required");
    let claims: Awaited<ReturnType<RunnerBootstrapTokenService["verify"]>>;
    try {
      claims = await this.#tokens.verify(token);
    } catch {
      throw unauthorized("The Runner bootstrap token is invalid or expired");
    }
    let scope: RunnerScope | undefined;
    try {
      scope = await this.#runnerService.validateRunnerChannelScope(claims);
    } catch {
      throw unavailable("The Runner allocation could not be validated");
    }
    if (!scope) throw staleScope("The Runner allocation is no longer current");
    const snapshot = this.#hub.describe(scope.sandboxId);
    if (
      !snapshot.connected ||
      snapshot.scope === null ||
      snapshot.scope.sessionId !== scope.sessionId ||
      snapshot.scope.environmentGeneration !== scope.environmentGeneration ||
      snapshot.scope.resourceName !== scope.resourceName
    ) {
      throw new RunnerWorkspaceError(
        409,
        RUNNER_WORKSPACE_ERROR_CODES.channelRequired,
        "The Runner control channel is not attached to the current allocation",
      );
    }
    const row = await loadSandboxRecordById(this.#database, scope.sandboxId);
    if (
      !row ||
      row.sessionId !== scope.sessionId ||
      row.environmentGeneration !== scope.environmentGeneration ||
      row.currentResourceName !== scope.resourceName
    ) {
      throw staleScope("The Runner allocation is no longer current");
    }
    return { scope, row };
  }

  /**
   * Claim the workspace for the current allocation. `preparing`/`ready` claim through the store
   * (only the allocator may initialize storage); a `releasing` allocation may only read back
   * current same-owner metadata and must never initialize or claim another generation.
   */
  async claim(context: RunnerWorkspaceContext): Promise<RunnerWorkspaceObject> {
    const scope = storeScope(context.row);
    if (context.row.lifecycle === "releasing") {
      const head = await this.#head(scope);
      if (!head || head.ownerGeneration !== context.row.environmentGeneration) {
        throw conflict("A releasing environment cannot claim the workspace");
      }
      return head;
    }
    try {
      return await this.#store.claim(scope);
    } catch (error) {
      throw mapStoreError(error);
    }
  }

  /**
   * Open the exact pinned archive for download. The head must match the caller's
   * generation/metageneration exactly, belong to the current owner generation, and hold a saved
   * archive; anything else fails closed.
   */
  async openArchive(
    context: RunnerWorkspaceContext,
    pins: RunnerWorkspacePins,
  ): Promise<{ object: RunnerWorkspaceObject; stream: ReadableStream<Uint8Array> }> {
    const scope = storeScope(context.row);
    const head = await this.#head(scope);
    if (!head) {
      throw new RunnerWorkspaceError(404, RUNNER_WORKSPACE_ERROR_CODES.notFound, "No workspace archive exists");
    }
    if (
      head.generation !== pins.generation ||
      head.metageneration !== pins.metageneration ||
      !head.saved ||
      head.ownerGeneration !== context.row.environmentGeneration
    ) {
      throw conflict("The pinned workspace archive is no longer current");
    }
    try {
      return { object: head, stream: await this.#store.read(scope, head) };
    } catch (error) {
      throw mapStoreError(error);
    }
  }

  /**
   * Conditionally store one archive. Headers were already validated by the route; here the
   * same-owner head must match the declared preconditions, seal discipline is enforced
   * (sealed saves belong to `ready`/`releasing` only, and a sealed object never accepts an
   * unsealed write), and at most one upload per Sandbox runs at a time.
   */
  async saveArchive(
    context: RunnerWorkspaceContext,
    input: RunnerWorkspaceUploadInput,
  ): Promise<RunnerWorkspaceObject> {
    const { row } = context;
    if (input.sealed && row.lifecycle !== "ready" && row.lifecycle !== "releasing") {
      throw conflict("Only a ready or releasing environment may seal the workspace");
    }
    // A Turn already running when stop marks `releasing` must finish its ordinary checkpoint
    // before its terminal report can be acknowledged and the final seal can proceed.
    const scope = storeScope(row);
    const head = await this.#head(scope);
    if (!head) throw conflict("The workspace must be claimed before it can be saved");
    if (head.generation !== input.generation || head.metageneration !== input.metageneration) {
      throw conflict("The workspace preconditions do not match the current object");
    }
    if (head.ownerGeneration !== row.environmentGeneration) {
      throw conflict("The workspace belongs to a different environment generation");
    }
    if (head.sealed && !input.sealed) {
      throw conflict("The workspace is sealed; unsealed writes are no longer accepted");
    }
    if (this.#uploads.has(row.id)) {
      throw conflict("Another workspace upload is already in flight for this Sandbox");
    }
    this.#uploads.add(row.id);
    try {
      const write: WorkspaceObjectWriteInput = {
        body: exactBytes(input.body, input.bytes),
        bytes: input.bytes,
        sha256: input.sha256,
        md5: input.md5,
        sealed: input.sealed,
      };
      return await this.#store.write(scope, head, write);
    } catch (error) {
      if (error instanceof RunnerWorkspaceError) throw error;
      throw mapStoreError(error);
    } finally {
      this.#uploads.delete(row.id);
    }
  }

  async #head(scope: WorkspaceObjectScope): Promise<RunnerWorkspaceObject | undefined> {
    try {
      return await this.#store.head(scope);
    } catch (error) {
      throw mapStoreError(error);
    }
  }
}

/** Server-side derivation of the store scope; the caller never supplies any of it. */
function storeScope(row: typeof sandboxes.$inferSelect): WorkspaceObjectScope {
  return {
    storageUri: row.storageUri,
    sandboxId: row.id,
    sessionId: row.sessionId,
    environmentGeneration: row.environmentGeneration,
  };
}

function bearerToken(header: string | undefined): string | undefined {
  if (!header?.startsWith("Bearer ")) return undefined;
  const token = header.slice("Bearer ".length).trim();
  return token.length > 0 && token.length <= MAX_BEARER_TOKEN_CHARS ? token : undefined;
}

/** Guard the store against a body whose real byte count differs from the declared length. */
async function* exactBytes(source: AsyncIterable<Uint8Array>, expected: number): AsyncIterable<Uint8Array> {
  let seen = 0;
  for await (const chunk of source) {
    seen += chunk.byteLength;
    if (seen > expected) {
      throw new RunnerWorkspaceError(
        400,
        RUNNER_WORKSPACE_ERROR_CODES.badRequest,
        "The archive body exceeds the declared Content-Length",
      );
    }
    yield chunk;
  }
  if (seen !== expected) {
    throw new RunnerWorkspaceError(
      400,
      RUNNER_WORKSPACE_ERROR_CODES.badRequest,
      "The archive body does not match the declared Content-Length",
    );
  }
}
