import {
  HTTP_PATHS,
  RUNNER_WS_CLOSE,
  RUNNER_WS_MAX_FRAME_BYTES,
  RUNNER_WS_PROTOCOL_VERSION,
  type RunnerAcceptanceResultFrame,
  type RunnerClientFrame,
  RunnerClientFrameSchema,
  type RunnerReadiness,
  type RunnerServerFrame,
} from "@opentag/shared";
import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import type {
  RunnerBootstrapClaims,
  RunnerBootstrapTokenService,
} from "../services/sandboxes/runner-bootstrap-token.js";
import type { RunnerControlSocket, RunnerHub, RunnerScope } from "../services/sandboxes/runner-hub.js";
import type { SandboxRunnerService } from "../services/sandboxes/sandbox-runner-service.js";

/**
 * Runner control channel. Runners dial OUT from their Cloud Run Instance to this route; the
 * parent HTTP listener exposes no management API for Instances. Authentication is a first-frame
 * bootstrap bearer token (never a URL token — a query string is rejected outright), and the
 * claims are validated against the CURRENT database allocation AND current authority chain on
 * every connect. Frames are handled strictly serially per connection with a bounded queue, the
 * authentication deadline spans the asynchronous verification, and every awaited step re-checks
 * that the connection is still open and still the hub's current socket for its scope. No
 * credential, token, or acceptance config is ever written to logs from this module.
 */

export interface RunnerWebSocketRouteOptions {
  tokens: RunnerBootstrapTokenService;
  service: SandboxRunnerService;
  hub: RunnerHub;
  authTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  /** Override the token-service derived renewal cadence (tests only). */
  credentialRenewalIntervalMs?: number;
  now?: () => number;
}

const DEFAULT_AUTH_TIMEOUT_MS = 5_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 45_000;
/** Frames accepted but not yet handled before the socket is failed closed. */
const MAX_QUEUED_FRAMES = 16;

class SocketAdapter implements RunnerControlSocket {
  readonly #socket: WebSocket;
  constructor(socket: WebSocket) {
    this.#socket = socket;
  }
  send(frame: RunnerServerFrame): void {
    if (this.#socket.readyState !== this.#socket.OPEN) throw new Error("Runner control socket is not writable");
    this.#socket.send(JSON.stringify(frame));
  }
  close(code: number, reason: string): void {
    try {
      this.#socket.close(code, reason);
    } catch {
      // Already closed; the detach path is idempotent.
    }
  }
}

function claimsFromScope(scope: RunnerScope): RunnerBootstrapClaims {
  return {
    sandboxId: scope.sandboxId,
    sessionId: scope.sessionId,
    environmentGeneration: scope.environmentGeneration,
    resourceName: scope.resourceName,
  };
}

export function registerRunnerWebSocketRoute(app: FastifyInstance, options: RunnerWebSocketRouteOptions): void {
  const authTimeoutMs = options.authTimeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
  const credentialRenewalIntervalMs =
    options.credentialRenewalIntervalMs ?? Math.max(1_000, Math.floor(options.tokens.ttlMs / 2));
  const now = options.now ?? (() => Date.now());

  app.get(HTTP_PATHS.sandboxRunnerWebSocket, { websocket: true }, (socket, request) => {
    // A bootstrap credential is a bearer secret; it belongs in the first frame and never in a
    // URL that proxies, load balancers, and access logs can retain.
    if (request.url.includes("?")) {
      socket.close(RUNNER_WS_CLOSE.authFailed, "credentials must be sent in-band, never in the URL");
      return;
    }

    let closed = false;
    let scope: RunnerScope | undefined;
    let authTimer: ReturnType<typeof setTimeout> | undefined;
    let credentialTimer: ReturnType<typeof setInterval> | undefined;
    let queued = 0;
    let chain: Promise<void> = Promise.resolve();
    const adapter = new SocketAdapter(socket);

    const clearTimers = () => {
      if (authTimer) clearTimeout(authTimer);
      if (credentialTimer) clearInterval(credentialTimer);
      authTimer = undefined;
      credentialTimer = undefined;
    };
    const send = (frame: RunnerServerFrame) => {
      if (closed) return;
      adapter.send(frame);
    };
    const closeWith = (code: number, reason: string) => {
      if (closed) return;
      closed = true;
      clearTimers();
      if (scope) options.hub.detach(scope.sandboxId, adapter);
      adapter.close(code, reason);
    };
    const sendAuthResult = (ok: boolean, requestId: string | undefined) => {
      send({ type: "auth:result", ok, ...(requestId ? { requestId } : {}) });
    };

    // The authentication deadline stays armed across the asynchronous token and database checks;
    // it is cleared only when authentication actually completes.
    authTimer = setTimeout(() => {
      if (closed || scope) return;
      send({ type: "error", code: "RUNNER_AUTH_TIMEOUT", message: "Authentication timed out" });
      closeWith(RUNNER_WS_CLOSE.authFailed, "authentication timed out");
    }, authTimeoutMs);
    authTimer.unref?.();

    const renewCredential = async (current: RunnerScope) => {
      if (closed || !options.hub.isCurrent(current.sandboxId, adapter)) return;
      // Revalidate the database allocation before minting anything; a stale connection must
      // never receive a fresh credential.
      const stillCurrent = await options.service.validateRunnerScope(claimsFromScope(current));
      if (closed || !stillCurrent || !options.hub.isCurrent(current.sandboxId, adapter)) return;
      const token = await options.tokens.issue(claimsFromScope(stillCurrent));
      if (closed || !options.hub.isCurrent(current.sandboxId, adapter)) return;
      options.hub.sendToCurrent(current.sandboxId, adapter, { type: "server:credential", token });
    };

    const handleAuth = async (token: string, requestId: string | undefined) => {
      if (scope) {
        closeWith(RUNNER_WS_CLOSE.protocolError, "duplicate authentication frame");
        return;
      }
      const validated = await resolveAuthenticatedScope(token, requestId);
      if (validated) await attachAuthenticatedRunner(validated, requestId);
    };

    const rejectAuth = (requestId: string | undefined, reason: string) => {
      sendAuthResult(false, requestId);
      closeWith(RUNNER_WS_CLOSE.authFailed, reason);
    };

    const verifyBootstrapToken = async (
      token: string,
      requestId: string | undefined,
    ): Promise<RunnerBootstrapClaims | undefined> => {
      try {
        return await options.tokens.verify(token);
      } catch {
        if (!closed) rejectAuth(requestId, "bootstrap token invalid or expired");
        return undefined;
      }
    };

    const validateBootstrapClaims = async (
      claims: RunnerBootstrapClaims,
      requestId: string | undefined,
    ): Promise<RunnerScope | undefined> => {
      let validated: RunnerScope | undefined;
      try {
        validated = await options.service.validateRunnerScope(claims);
      } catch (error) {
        request.log.warn({ err: error }, "Runner scope validation failed");
        if (!closed) closeWith(RUNNER_WS_CLOSE.protocolError, "authentication could not be validated");
        return undefined;
      }
      if (closed) return undefined;
      if (!validated) {
        rejectAuth(requestId, "no current Sandbox allocation matches the bootstrap token");
        return undefined;
      }
      return validated;
    };

    const resolveAuthenticatedScope = async (
      token: string,
      requestId: string | undefined,
    ): Promise<RunnerScope | undefined> => {
      const claims = await verifyBootstrapToken(token, requestId);
      if (!claims || closed) return undefined;
      return validateBootstrapClaims(claims, requestId);
    };

    const attachAuthenticatedRunner = async (validated: RunnerScope, requestId: string | undefined) => {
      // No await between the closed check and the hub mutation, so a socket that closed during
      // verification can never become a ghost entry.
      scope = validated;
      options.hub.attach(validated, adapter);
      if (closed) {
        options.hub.detach(validated.sandboxId, adapter);
        return;
      }
      if (authTimer) clearTimeout(authTimer);
      authTimer = undefined;
      sendAuthResult(true, requestId);
      send({
        type: "server:welcome",
        protocolVersion: RUNNER_WS_PROTOCOL_VERSION,
        sandboxId: validated.sandboxId,
        sessionId: validated.sessionId,
        environmentGeneration: validated.environmentGeneration,
        resourceName: validated.resourceName,
        heartbeatIntervalMs,
        heartbeatTimeoutMs,
      });
      await renewCredential(validated);
      if (!closed) {
        credentialTimer = setInterval(() => {
          void renewCredential(validated).catch(() => {
            // Credential renewal failures never log credentials; liveness stays the heartbeat's job.
          });
        }, credentialRenewalIntervalMs);
        credentialTimer.unref?.();
      }
    };

    /** Revalidate the DB allocation AND the current socket after an await. */
    const currentAllocationHolds = async (current: RunnerScope): Promise<boolean | undefined> => {
      let stillCurrent: RunnerScope | undefined;
      try {
        stillCurrent = await options.service.validateRunnerScope(claimsFromScope(current));
      } catch (error) {
        request.log.warn({ err: error }, "Runner control message validation failed");
        return undefined;
      }
      if (closed) return undefined;
      return Boolean(stillCurrent && options.hub.isCurrent(current.sandboxId, adapter));
    };

    const settleReadiness = async (current: RunnerScope, reported: RunnerReadiness) => {
      const outcome = await options.service.markRunnerReady(current, reported);
      if (closed) return;
      if (outcome === "stale") {
        closeWith(RUNNER_WS_CLOSE.staleScope, "runner scope is stale");
        return;
      }
      if (outcome === "version_mismatch") {
        // The connection stays authenticated so an operator can see runnerConnected reasons; the
        // environment simply never becomes ready from a build that is not the pinned one.
        send({
          type: "error",
          code: "RUNNER_VERSION_MISMATCH",
          message: "The Runner build does not match the version this Server requires",
        });
      }
    };

    const handleReady = async (current: RunnerScope, readiness: Omit<RunnerReadiness, "reportedAt">) => {
      const holds = await currentAllocationHolds(current);
      if (holds === undefined) return;
      if (!holds) {
        closeWith(RUNNER_WS_CLOSE.staleScope, "environment allocation changed");
        return;
      }
      const reported: RunnerReadiness = { ...readiness, reportedAt: new Date(now()).toISOString() };
      if (!options.hub.markReady(current, reported, adapter)) {
        closeWith(RUNNER_WS_CLOSE.staleScope, "this Runner connection was replaced");
        return;
      }
      await settleReadiness(current, reported);
    };

    const handleResult = async (current: RunnerScope, frame: RunnerAcceptanceResultFrame) => {
      const holds = await currentAllocationHolds(current);
      if (holds === undefined) return;
      if (!holds) {
        closeWith(RUNNER_WS_CLOSE.staleScope, "environment allocation changed");
        return;
      }
      options.hub.resolveAcceptanceResult(current.sandboxId, frame, adapter);
    };

    const parseClientFrame = (raw: Buffer): RunnerClientFrame | undefined => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString("utf8"));
      } catch {
        send({ type: "error", code: "PROTOCOL_ERROR", message: "Frames must be JSON" });
        closeWith(RUNNER_WS_CLOSE.protocolError, "frame was not JSON");
        return undefined;
      }
      const frame = RunnerClientFrameSchema.safeParse(parsed);
      if (!frame.success) {
        send({ type: "error", code: "PROTOCOL_ERROR", message: "Frame does not match the runner protocol" });
        closeWith(RUNNER_WS_CLOSE.protocolError, "invalid frame");
        return undefined;
      }
      return frame.data;
    };

    const dispatchAuthenticatedFrame = async (current: RunnerScope, data: RunnerClientFrame) => {
      if (data.type === "heartbeat") {
        options.hub.acknowledge(current.sandboxId, adapter, { type: "server:heartbeat" });
        return;
      }
      if (data.type === "runner:ready") {
        await handleReady(current, data.readiness);
        return;
      }
      if (data.type === "acceptance:result") await handleResult(current, data);
    };

    const handleFirstFrame = async (data: RunnerClientFrame) => {
      if (data.type !== "auth") {
        closeWith(RUNNER_WS_CLOSE.authFailed, "the first frame must authenticate");
        return;
      }
      await handleAuth(data.token, data.requestId);
    };

    const handleAuthenticatedFrame = async (current: RunnerScope, data: RunnerClientFrame) => {
      if (data.type === "auth") {
        closeWith(RUNNER_WS_CLOSE.protocolError, "duplicate authentication frame");
        return;
      }
      if (!options.hub.isCurrent(current.sandboxId, adapter)) {
        closeWith(RUNNER_WS_CLOSE.staleScope, "this Runner connection was replaced");
        return;
      }
      await dispatchAuthenticatedFrame(current, data);
    };

    const handleFrame = async (raw: Buffer) => {
      if (closed) return;
      const data = parseClientFrame(raw);
      if (!data) return;
      if (!scope) {
        await handleFirstFrame(data);
        return;
      }
      await handleAuthenticatedFrame(scope, data);
    };

    const enqueueFrame = (raw: Buffer, isBinary: boolean) => {
      if (closed) return;
      if (isBinary) {
        closeWith(RUNNER_WS_CLOSE.protocolError, "binary frames are not part of the protocol");
        return;
      }
      // Bound the frame before any string conversion or JSON parse.
      if (raw.length > RUNNER_WS_MAX_FRAME_BYTES) {
        closeWith(RUNNER_WS_CLOSE.protocolError, "frame exceeds the control-channel bound");
        return;
      }
      if (queued >= MAX_QUEUED_FRAMES) {
        closeWith(RUNNER_WS_CLOSE.protocolError, "too many queued frames");
        return;
      }
      queued += 1;
      chain = chain
        .then(() => handleFrame(raw))
        .catch((error: unknown) => {
          request.log.warn({ err: error }, "Runner control channel failure");
          closeWith(RUNNER_WS_CLOSE.protocolError, "internal failure");
        })
        .finally(() => {
          queued -= 1;
        });
    };

    socket.on("message", (raw: Buffer, isBinary: boolean) => enqueueFrame(raw, isBinary));

    const onClose = () => {
      closed = true;
      clearTimers();
      if (scope) options.hub.detach(scope.sandboxId, adapter);
    };
    socket.on("close", onClose);
    socket.on("error", onClose);
  });

  const sweep = setInterval(() => {
    const cutoff = now() - heartbeatTimeoutMs;
    options.hub.sweepStale(cutoff);
  }, heartbeatTimeoutMs);
  sweep.unref();
  const heartbeat = setInterval(() => {
    options.hub.heartbeatAll({ type: "server:heartbeat" });
  }, heartbeatIntervalMs);
  heartbeat.unref();
  app.addHook("onClose", async () => {
    clearInterval(sweep);
    clearInterval(heartbeat);
  });
}
