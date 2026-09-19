import {
  RUNNER_CLOUD_DELIVERY_VERSION,
  RUNNER_REUSE_VERSION,
  RUNNER_WORKSPACE_VERSION,
  RUNNER_WS_CLOSE,
  RUNNER_WS_MAX_FRAME_BYTES,
  RUNNER_WS_PROTOCOL_VERSION,
  type RunnerAcceptanceResultFrame,
  type RunnerClientFrame,
  RunnerClientFrameSchema,
  type RunnerReadiness,
  type RunnerServerFrame,
  type RuntimeCredentialClientFrame,
} from "@opentag/shared";
import type { FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import type { CloudDeliveryOwner } from "../services/sandboxes/cloud-delivery-owner.js";
import type { CloudConnectionRecord } from "../services/sandboxes/cloud-runtime-fence.js";
import type {
  RunnerBootstrapClaims,
  RunnerBootstrapTokenService,
} from "../services/sandboxes/runner-bootstrap-token.js";
import type { RunnerControlSocket, RunnerHub, RunnerScope } from "../services/sandboxes/runner-hub.js";
import type { RunnerReadyOutcome, SandboxRunnerService } from "../services/sandboxes/sandbox-runner-service.js";

/**
 * One authenticated Runner control connection. Runners dial OUT from their Cloud Run Instance;
 * the parent HTTP listener exposes no management API for Instances. Authentication is a first-frame
 * bootstrap bearer token (never a URL token — a query string is rejected outright), and the claims
 * are validated against the CURRENT database allocation on every connect:
 * - the active authority chain admits a normal (E3-compatible) connection;
 * - a negotiated E4 connection whose active chain ended/suspended may still authenticate in
 *   REPORT-ONLY mode against the exact still-current persisted allocation, so a result the Runner
 *   saved in its journal is not lost when it reconnects after the effect;
 * - report-only connections can never mark readiness, receive deliveries, or open new credential
 *   executions.
 * Frames are handled strictly serially with a bounded queue, the authentication deadline spans the
 * asynchronous verification, and every awaited step re-checks that the connection is still open and
 * still the hub's current socket for its scope. No credential, token, or acceptance config is ever
 * written to logs from this module.
 */

export interface RunnerWebSocketRouteOptions {
  tokens: RunnerBootstrapTokenService;
  service: SandboxRunnerService;
  hub: RunnerHub;
  /** E4 Session-scoped Cloud IM delivery; absent keeps the channel acceptance-only. */
  cloudDelivery?: CloudDeliveryOwner;
  authTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  /** Override the token-service derived renewal cadence (tests only). */
  credentialRenewalIntervalMs?: number;
  now?: () => number;
}

const DEFAULT_AUTH_TIMEOUT_MS = 5_000;
// Signed renewal evidence requires a bounded Cloud API read (30s by default) before re-handshake.
const RENEWAL_AUTH_TIMEOUT_MS = 45_000;
/** Shared with the route's liveness sweeps. */
export const RUNNER_WS_DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
export const RUNNER_WS_DEFAULT_HEARTBEAT_TIMEOUT_MS = 45_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = RUNNER_WS_DEFAULT_HEARTBEAT_INTERVAL_MS;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = RUNNER_WS_DEFAULT_HEARTBEAT_TIMEOUT_MS;
/** Frames accepted but not yet handled before the socket is failed closed. */
const MAX_QUEUED_FRAMES = 16;
/**
 * Transient attach rejection (RFC 6455 "Try Again Later"). A Cloud-capable Runner must retry
 * until the create caller has tracked the verified allocation UID; this is never an auth failure.
 */
const RUNNER_WS_CLOSE_RETRY_LATER = 1013;

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

/**
 * A credential execution open must target exactly the sending connection's authenticated
 * allocation: the Session, the Sandbox, and the environment generation it authenticated for. A
 * Cloud execution is always Sandbox-bound, so a missing sandbox fact never matches.
 */
function executionOpenMatchesConnection(
  connection: CloudConnectionRecord,
  frame: Extract<RuntimeCredentialClientFrame, { type: "runtime:execution:open" }>,
): boolean {
  if (frame.sessionId !== connection.scope.sessionId) return false;
  const sandbox = frame.sandbox;
  if (!sandbox) return false;
  return (
    sandbox.sandboxId === connection.scope.sandboxId &&
    sandbox.environmentGeneration === connection.scope.environmentGeneration
  );
}

export class RunnerConnection {
  readonly #options: RunnerWebSocketRouteOptions;
  readonly #socket: WebSocket;
  readonly #request: FastifyRequest;
  readonly #adapter: SocketAdapter;
  readonly #now: () => number;
  readonly #authTimeoutMs: number;
  readonly #heartbeatIntervalMs: number;
  readonly #heartbeatTimeoutMs: number;
  readonly #credentialRenewalIntervalMs: number;
  #closed = false;
  #scope: RunnerScope | undefined;
  #cloudConnection: CloudConnectionRecord | undefined;
  /** Immutable physical birth identity of an E7 control-authenticated connection. */
  #controlClaims: RunnerBootstrapClaims | undefined;
  /** E4 reconnect after the active chain ended: report/query/proxy traffic only. */
  #reportOnly = false;
  /** Set at attach: only a connection that negotiated E4 may use the channel-scope fallback. */
  #cloudNegotiated = false;
  /** Set at attach: E5 workspace persistence was requested AND is configured on this Server. */
  #workspaceNegotiated = false;
  #authTimer: ReturnType<typeof setTimeout> | undefined;
  #credentialTimer: ReturnType<typeof setInterval> | undefined;
  #queued = 0;
  #chain: Promise<void> = Promise.resolve();

  constructor(input: {
    socket: WebSocket;
    request: FastifyRequest;
    options: RunnerWebSocketRouteOptions;
    now: () => number;
  }) {
    this.#socket = input.socket;
    this.#request = input.request;
    this.#options = input.options;
    this.#now = input.now;
    this.#adapter = new SocketAdapter(input.socket);
    this.#authTimeoutMs = input.options.authTimeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS;
    this.#heartbeatIntervalMs = input.options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.#heartbeatTimeoutMs = input.options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
    this.#credentialRenewalIntervalMs =
      input.options.credentialRenewalIntervalMs ?? Math.max(1_000, Math.floor(input.options.tokens.ttlMs / 2));
  }

  start(): void {
    // A bootstrap credential is a bearer secret; it belongs in the first frame and never in a
    // URL that proxies, load balancers, and access logs can retain.
    if (this.#request.url.includes("?")) {
      this.#socket.close(RUNNER_WS_CLOSE.authFailed, "credentials must be sent in-band, never in the URL");
      return;
    }
    // The authentication deadline stays armed across the asynchronous token and database checks;
    // it is cleared only when authentication actually completes.
    this.#armAuthDeadline(this.#authTimeoutMs);
    this.#socket.on("message", (raw: Buffer, isBinary: boolean) => this.#enqueueFrame(raw, isBinary));
    this.#socket.on("close", () => this.#onTransportClosed());
    this.#socket.on("error", () => this.#onTransportClosed());
  }

  #armAuthDeadline(timeoutMs: number): void {
    clearTimeout(this.#authTimer);
    this.#authTimer = setTimeout(() => {
      if (this.#closed || this.#scope) return;
      this.#send({ type: "error", code: "RUNNER_AUTH_TIMEOUT", message: "Authentication timed out" });
      this.#closeWith(RUNNER_WS_CLOSE.authFailed, "authentication timed out");
    }, timeoutMs);
    this.#authTimer.unref?.();
  }

  /* ------------------------------------------------------------------------------------------
   * Small transport helpers
   * ---------------------------------------------------------------------------------------- */

  #clearTimers(): void {
    if (this.#authTimer) clearTimeout(this.#authTimer);
    if (this.#credentialTimer) clearInterval(this.#credentialTimer);
    this.#authTimer = undefined;
    this.#credentialTimer = undefined;
  }

  #send(frame: RunnerServerFrame): void {
    if (this.#closed) return;
    this.#adapter.send(frame);
  }

  #closeWith(code: number, reason: string): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#clearTimers();
    if (this.#cloudConnection) this.#options.cloudDelivery?.detachConnection(this.#cloudConnection.connectionId);
    if (this.#scope) this.#options.hub.detach(this.#scope.sandboxId, this.#adapter);
    this.#adapter.close(code, reason);
  }

  #onTransportClosed(): void {
    this.#closed = true;
    this.#clearTimers();
    if (this.#cloudConnection) this.#options.cloudDelivery?.detachConnection(this.#cloudConnection.connectionId);
    if (this.#scope) this.#options.hub.detach(this.#scope.sandboxId, this.#adapter);
  }

  #sendAuthResult(ok: boolean, requestId: string | undefined): void {
    this.#send({ type: "auth:result", ok, ...(requestId ? { requestId } : {}) });
  }

  #rejectAuth(requestId: string | undefined, reason: string): void {
    this.#sendAuthResult(false, requestId);
    this.#closeWith(RUNNER_WS_CLOSE.authFailed, reason);
  }

  /* ------------------------------------------------------------------------------------------
   * Authentication and channel attachment
   * ---------------------------------------------------------------------------------------- */

  async #handleAuth(
    token: string,
    requestId: string | undefined,
    wantsCloudDelivery: boolean,
    wantsWorkspace: boolean,
    renewExpired: boolean,
    controlToken: string | undefined,
    reuseVersion: number | undefined,
  ): Promise<void> {
    if (this.#scope) {
      this.#closeWith(RUNNER_WS_CLOSE.protocolError, "duplicate authentication frame");
      return;
    }
    // E7 physical control authentication is a strictly separate path: a stale Session bearer is
    // NEVER used to resolve a different current holder, even within one account. The control
    // credential names the immutable physical birth identity; the Server resolves the unique
    // current owning Sandbox by resource name and validates that owner's authority below.
    if (controlToken !== undefined && reuseVersion === RUNNER_REUSE_VERSION) {
      await this.#handleControlAuth(controlToken, requestId, wantsCloudDelivery, wantsWorkspace, renewExpired);
      return;
    }
    const claims = await this.#verifyBootstrapToken(token, requestId, wantsWorkspace && renewExpired);
    if (!claims || this.#closed) return;
    const resolved = await this.#resolveAuthenticatedScope(claims, requestId, wantsCloudDelivery, wantsWorkspace);
    if (!resolved) return;
    await this.#attachAuthenticatedRunner(
      resolved.scope,
      requestId,
      wantsCloudDelivery,
      wantsWorkspace,
      resolved.reportOnly,
    );
  }

  /**
   * E7 control-token attach. Verification is two-stage: the signed physical birth identity, then
   * the current owner of the unique `currentResourceName`. Only a control credential can follow a
   * transfer; invalid control evidence is rejected rather than downgraded to the Session token.
   */
  async #handleControlAuth(
    controlToken: string,
    requestId: string | undefined,
    wantsCloudDelivery: boolean,
    wantsWorkspace: boolean,
    renewExpired: boolean,
  ): Promise<void> {
    let controlClaims: RunnerBootstrapClaims;
    try {
      controlClaims = await this.#options.tokens.verifyControl(controlToken);
    } catch {
      if (renewExpired && (await this.#renewExpiredControl(controlToken))) return;
      if (!this.#closed) this.#rejectAuth(requestId, "physical control credential invalid or expired");
      return;
    }
    // The signed credential is verified, so the connection is no longer arbitrary input: the
    // physical-holder resolution performs a bounded provider read and uses the same 45 s
    // provider-read deadline as renewal. An ordinary handshake keeps its short deadline.
    this.#armAuthDeadline(RENEWAL_AUTH_TIMEOUT_MS);
    const holderClaims = await this.#options.service.resolveRunnerControlHolder(controlClaims);
    if (this.#closed) return;
    if (!holderClaims) {
      // A deleted instance will terminate this process; a transient database read or a not-yet
      // tracked holder must keep retrying with the SAME durable physical credential.
      this.#send({
        type: "error",
        code: "RUNNER_ALLOCATION_NOT_TRACKED",
        message: "No Sandbox currently owns this physical Instance; retry the attach",
      });
      this.#closeWith(RUNNER_WS_CLOSE_RETRY_LATER, "physical Instance has no current owner");
      return;
    }
    const resolved = await this.#resolveAuthenticatedScope(holderClaims, requestId, wantsCloudDelivery, wantsWorkspace);
    if (!resolved) return;
    this.#controlClaims = controlClaims;
    await this.#attachAuthenticatedRunner(
      resolved.scope,
      requestId,
      wantsCloudDelivery,
      wantsWorkspace,
      resolved.reportOnly,
      { reuseCapable: wantsWorkspace && this.#options.service.workspacePersistenceEnabled },
    );
  }

  /**
   * Renewal-only physical evidence: the signature names the same birth identity AND the provider
   * still shows the tracked binding. A fresh control credential keeps the birth claims; the
   * ordinary handshake resolves the current holder again.
   */
  async #renewExpiredControl(token: string): Promise<boolean> {
    const claims = await this.#options.tokens.expiredControlClaimsForRenewal(token);
    if (!claims || this.#closed) return false;
    this.#armAuthDeadline(RENEWAL_AUTH_TIMEOUT_MS);
    try {
      const renewed = await this.#options.service.renewExpiredControl(claims);
      if (!renewed) return false;
      if (!this.#closed) {
        this.#send({ type: "auth:renewed", controlToken: renewed });
        this.#closeWith(RUNNER_WS_CLOSE_RETRY_LATER, "reconnect with the renewed control credential");
      }
    } catch {
      if (!this.#closed) this.#closeWith(RUNNER_WS_CLOSE_RETRY_LATER, "control credential renewal unavailable");
    }
    return true;
  }

  async #verifyBootstrapToken(
    token: string,
    requestId: string | undefined,
    renewExpired: boolean,
  ): Promise<RunnerBootstrapClaims | undefined> {
    try {
      return await this.#options.tokens.verify(token);
    } catch {
      if (renewExpired && (await this.#renewExpiredBootstrap(token))) return undefined;
      if (!this.#closed) this.#rejectAuth(requestId, "bootstrap token invalid or expired");
      return undefined;
    }
  }

  /** Renewal replies grant no channel, delivery, readiness, or workspace HTTP authority. */
  async #renewExpiredBootstrap(token: string): Promise<boolean> {
    const claims = await this.#options.tokens.expiredClaimsForRenewal(token);
    if (!claims || this.#closed) return false;
    this.#armAuthDeadline(RENEWAL_AUTH_TIMEOUT_MS);
    try {
      const renewed = await this.#options.service.renewExpiredBootstrap(claims);
      if (!renewed) return false;
      if (!this.#closed) {
        this.#send({ type: "auth:renewed", token: renewed });
        this.#closeWith(RUNNER_WS_CLOSE_RETRY_LATER, "reconnect with the renewed credential");
      }
    } catch {
      // Provider/DB uncertainty is not revocation and never reveals credentials or cloud errors.
      if (!this.#closed) this.#closeWith(RUNNER_WS_CLOSE_RETRY_LATER, "credential renewal unavailable");
    }
    return true;
  }

  /**
   * Active authority first; for a negotiated E4/E5 connection whose active chain has
   * ended/suspended, the exact still-current persisted allocation is accepted in report-only mode,
   * so a result the Runner saved in its journal (or a release seal) is not lost when it
   * reconnects after the effect. Report-only connections can never mark readiness, receive
   * deliveries, or open new credential executions. When the Server persists workspaces, an
   * execution-capable Runner must have negotiated the workspace capability: a Runner without it
   * fails closed here rather than ever dispatching a blank environment.
   */
  async #resolveAuthenticatedScope(
    claims: RunnerBootstrapClaims,
    requestId: string | undefined,
    wantsCloudDelivery: boolean,
    wantsWorkspace: boolean,
  ): Promise<{ scope: RunnerScope; reportOnly: boolean } | undefined> {
    try {
      const workspaceEnabled = this.#options.service.workspacePersistenceEnabled;
      const active = await this.#options.service.validateRunnerScope(claims);
      if (this.#closed) return undefined;
      if (active) {
        if (workspaceEnabled && !wantsWorkspace) {
          this.#rejectAuth(requestId, "runner workspace persistence capability is required");
          return undefined;
        }
        return { scope: active, reportOnly: false };
      }
      const channelCapable =
        (wantsCloudDelivery && this.#options.cloudDelivery) || (wantsWorkspace && workspaceEnabled);
      if (!channelCapable) {
        this.#rejectAuth(requestId, "no current Sandbox allocation matches the bootstrap token");
        return undefined;
      }
      const channel = await this.#options.service.validateRunnerChannelScope(claims);
      if (this.#closed) return undefined;
      if (!channel) {
        this.#rejectAuth(requestId, "no current Sandbox allocation matches the bootstrap token");
        return undefined;
      }
      // The token still has to be unexpired (verified above) and the allocation identity current;
      // report-only mode forbids every new-work frame.
      return { scope: channel, reportOnly: true };
    } catch (error) {
      this.#request.log.warn({ err: error }, "Runner scope validation failed");
      if (!this.#closed) this.#closeWith(RUNNER_WS_CLOSE.protocolError, "authentication could not be validated");
      return undefined;
    }
  }

  async #attachAuthenticatedRunner(
    validated: RunnerScope,
    requestId: string | undefined,
    wantsCloudDelivery: boolean,
    wantsWorkspace: boolean,
    reportOnly: boolean,
    control?: { reuseCapable: boolean },
  ): Promise<void> {
    const cloudNegotiated = wantsCloudDelivery && this.#options.cloudDelivery !== undefined;
    // E5 capability negotiation is independent of delivery: echo only when the Runner requested
    // the workspace capability AND this Server has persistence configured.
    const workspaceNegotiated = wantsWorkspace && this.#options.service.workspacePersistenceEnabled;
    // The asynchronous Cloud fence facts are resolved BEFORE the hub attach: once this socket is
    // the hub's current entry, the route's cadenced heartbeat sweep can write to it, and no server
    // frame may ever reach the Runner ahead of its auth:result. Everything between the hub attach
    // and the auth:result below is synchronous, so the sweep cannot interleave.
    const fence = cloudNegotiated ? await this.#prepareCloudFenceFacts(validated) : undefined;
    if (cloudNegotiated && !fence) return; // the prepare step already closed the connection
    // A socket that closed during the asynchronous verification must never disturb the live
    // connection for its scope. No await between this check and the hub mutation, so a socket
    // that closed mid-verification can never evict a healthy Runner or become a ghost entry.
    if (this.#closed) return;
    const outcome = this.#options.hub.attach(validated, this.#adapter, {
      liveWindowMs: this.#heartbeatTimeoutMs,
      reuseCapable: control?.reuseCapable === true,
    });
    if (outcome === "duplicate") {
      // A live, heartbeating connection already owns this scope. Rejecting the newcomer —
      // without an auth:result — keeps this retriable on the Runner side: after the dead
      // connection is swept, a legitimate reconnect attaches.
      this.#send({
        type: "error",
        code: "RUNNER_DUPLICATE_CONNECTION",
        message: "A live Runner connection already exists for this Sandbox environment",
      });
      this.#closeWith(RUNNER_WS_CLOSE.duplicate, "a live Runner connection already exists for this scope");
      return;
    }
    this.#scope = validated;
    this.#reportOnly = reportOnly;
    this.#cloudNegotiated = cloudNegotiated;
    this.#workspaceNegotiated = workspaceNegotiated;
    if (this.#authTimer) clearTimeout(this.#authTimer);
    this.#authTimer = undefined;
    if (fence) {
      this.#cloudConnection = this.#options.cloudDelivery?.attachConnection({
        computerId: fence.computerId,
        installationId: fence.installationId,
        scope: validated,
        socket: this.#adapter,
        // A report-only reconnect may settle/report existing custody, but the owner must never
        // mint execution permission for it; the fresh active handshake replaces the record.
        executionEligible: !reportOnly,
      });
    }
    this.#sendAuthResult(true, requestId);
    this.#send({
      type: "server:welcome",
      protocolVersion: RUNNER_WS_PROTOCOL_VERSION,
      sandboxId: validated.sandboxId,
      sessionId: validated.sessionId,
      environmentGeneration: validated.environmentGeneration,
      resourceName: validated.resourceName,
      // Exact legacy E3 welcome shape for a connection that did not opt into E4: no capability
      // echo and no resourceUid are added for it.
      ...(cloudNegotiated ? { cloudDeliveryVersion: RUNNER_CLOUD_DELIVERY_VERSION } : {}),
      ...(cloudNegotiated && fence?.resourceUid ? { resourceUid: fence.resourceUid } : {}),
      ...(workspaceNegotiated ? { workspaceVersion: RUNNER_WORKSPACE_VERSION } : {}),
      ...(control?.reuseCapable === true ? { reuseVersion: RUNNER_REUSE_VERSION } : {}),
      heartbeatIntervalMs: this.#heartbeatIntervalMs,
      heartbeatTimeoutMs: this.#heartbeatTimeoutMs,
    });
    await this.#renewCredential();
    if (!this.#closed) {
      this.#credentialTimer = setInterval(() => {
        void this.#renewCredential().catch(() => {
          // Credential renewal failures never log credentials; liveness stays the heartbeat's job.
        });
      }, this.#credentialRenewalIntervalMs);
      this.#credentialTimer.unref?.();
    }
  }

  /**
   * Load and check the Cloud fence facts for a negotiated connection. Returns `undefined` after
   * the connection was closed transiently/permanently (or already was); the caller then stops
   * without ever attaching the socket to the hub.
   */
  async #prepareCloudFenceFacts(
    validated: RunnerScope,
  ): Promise<{ computerId: string; installationId: string; resourceUid: string } | undefined> {
    const authority = await this.#describeAuthority(validated);
    if (this.#closed) return undefined;
    if (!authority) {
      this.#closeWith(RUNNER_WS_CLOSE.protocolError, "runner authority facts are unavailable");
      return undefined;
    }
    if (authority.resourceUid === null) {
      // The create caller has not tracked the policy-verified UID yet. Publishing a Cloud welcome
      // without it would leave the Runner unable to open its first execution, so the attach fails
      // transiently and the Runner retries after the UID is tracked.
      this.#send({
        type: "error",
        code: "RUNNER_ALLOCATION_NOT_TRACKED",
        message: "The Sandbox allocation UID is not tracked yet; retry the attach",
      });
      this.#closeWith(RUNNER_WS_CLOSE_RETRY_LATER, "the Sandbox allocation UID is not tracked yet");
      return undefined;
    }
    return {
      computerId: authority.computerId,
      installationId: authority.installationId,
      resourceUid: authority.resourceUid,
    };
  }

  async #describeAuthority(
    scope: RunnerScope,
  ): Promise<{ computerId: string; installationId: string; resourceUid: string | null } | undefined> {
    try {
      return await this.#options.service.describeScopeAuthority(scope);
    } catch (error) {
      this.#request.log.warn({ err: error }, "Runner authority facts could not be loaded");
      return undefined;
    }
  }

  /* ------------------------------------------------------------------------------------------
   * Credential renewal
   * ---------------------------------------------------------------------------------------- */

  async #issueRenewedCredential(current: RunnerScope, stillCurrent: RunnerScope): Promise<void> {
    if (!this.#options.hub.isCurrent(current.sandboxId, this.#adapter)) return;
    const token = await this.#options.tokens.issue(claimsFromScope(stillCurrent));
    // The physical control credential is renewed alongside the Session bearer: it stays bound to
    // the immutable birth claims, never to the current assignment, so a later process restart can
    // still find the holder of the physical Instance.
    const controlToken = this.#controlClaims ? await this.#options.tokens.issueControl(this.#controlClaims) : undefined;
    if (this.#closed || !this.#options.hub.isCurrent(current.sandboxId, this.#adapter)) return;
    this.#options.hub.sendToCurrent(current.sandboxId, this.#adapter, {
      type: "server:credential",
      token,
      ...(controlToken ? { controlToken } : {}),
    });
  }

  async #renewCredential(): Promise<void> {
    const current = this.#scope;
    if (!current || this.#closed || !this.#options.hub.isCurrent(current.sandboxId, this.#adapter)) return;
    // Revalidate the database allocation before minting anything; a stale connection must never
    // receive a fresh credential. A transient lookup failure is NOT a revocation: the socket is
    // left alone and a later renewal retries.
    let active: RunnerScope | undefined;
    try {
      active = await this.#options.service.validateRunnerScope(claimsFromScope(current));
    } catch (error) {
      this.#request.log.warn({ err: error }, "Runner credential renewal could not validate the scope");
      return;
    }
    if (this.#closed) return;
    if (active) {
      await this.#issueRenewedCredential(current, active);
      return;
    }
    // The active authority chain is gone (Session ended, Agent suspended, binding disabled). A
    // connection that never negotiated E4 delivery or E5 workspace persistence has no
    // report-capable fallback: a definitive miss is a revocation and must take effect on the live
    // socket instead of leaving the Runner connected and credentialed until some later sweep.
    if (!this.#cloudNegotiated && !this.#workspaceNegotiated) {
      this.#closeWith(RUNNER_WS_CLOSE.staleScope, "runner scope is no longer current");
      return;
    }
    // A negotiated E4/E5 connection keeps a report-capable channel while the exact persisted
    // allocation identity is current, so already accepted work can still deliver its
    // final/cancellation report (and a releasing environment can still be sealed). Every NEW work
    // frame re-checks the active chain before it is handled. A transient lookup failure here is
    // not a revocation either.
    let channel: RunnerScope | undefined;
    try {
      channel = await this.#options.service.validateRunnerChannelScope(claimsFromScope(current));
    } catch (error) {
      this.#request.log.warn({ err: error }, "Runner credential renewal could not validate the channel scope");
      return;
    }
    if (this.#closed) return;
    if (!channel) {
      // A definitive miss is a revocation (allocation released/superseded): it must take effect on
      // the live socket instead of leaving the Runner connected until some later sweep.
      this.#closeWith(RUNNER_WS_CLOSE.staleScope, "runner scope is no longer current");
      return;
    }
    await this.#issueRenewedCredential(current, channel);
  }

  /* ------------------------------------------------------------------------------------------
   * Allocation checks
   * ---------------------------------------------------------------------------------------- */

  /** Active authority chain AND the current socket. Gates every new-work frame. */
  async #activeAllocationHolds(current: RunnerScope): Promise<boolean | undefined> {
    return this.#allocationHolds(current, () => this.#options.service.validateRunnerScope(claimsFromScope(current)));
  }

  /**
   * A report-only connection is latched at handshake while the authority chain was inactive. When
   * the chain becomes active again (IM reauthorization restored), force the Runner back through
   * the existing control reconnect: the fresh handshake resolves the active chain, accepts
   * readiness and permits execution opens. Owner issuance is gated on `executionEligible`, so no
   * grant can reach this socket in the meantime. Returns true when this connection was closed.
   */
  async #refreshReportOnlyConnection(current: RunnerScope): Promise<boolean> {
    if (!this.#reportOnly || this.#closed) return false;
    const active = await this.#activeAllocationHolds(current);
    if (this.#closed) return true;
    if (active !== true) return false;
    this.#closeWith(RUNNER_WS_CLOSE_RETRY_LATER, "authority restored; reconnect for execution");
    return true;
  }

  /** Exact persisted allocation identity without the active chain. Gates report/query traffic. */
  async #channelAllocationHolds(current: RunnerScope): Promise<boolean | undefined> {
    return this.#allocationHolds(current, () =>
      this.#options.service.validateRunnerChannelScope(claimsFromScope(current)),
    );
  }

  async #allocationHolds(
    current: RunnerScope,
    validate: () => Promise<RunnerScope | undefined>,
  ): Promise<boolean | undefined> {
    let stillCurrent: RunnerScope | undefined;
    try {
      stillCurrent = await validate();
    } catch (error) {
      this.#request.log.warn({ err: error }, "Runner control message validation failed");
      return undefined;
    }
    if (this.#closed) return undefined;
    return Boolean(stillCurrent && this.#options.hub.isCurrent(current.sandboxId, this.#adapter));
  }

  /* ------------------------------------------------------------------------------------------
   * Frame handlers
   * ---------------------------------------------------------------------------------------- */

  async #handleReady(
    current: RunnerScope,
    readiness: Omit<RunnerReadiness, "reportedAt">,
    workspaceRestored: boolean,
  ): Promise<void> {
    if (this.#reportOnly) {
      if (await this.#refreshReportOnlyConnection(current)) return;
      this.#send({
        type: "error",
        code: "RUNNER_SCOPE_REPORT_ONLY",
        message: "The Runner scope is report-only; readiness cannot be accepted",
      });
      return;
    }
    const holds = await this.#activeAllocationHolds(current);
    if (holds === undefined) return;
    if (!holds) {
      this.#closeWith(RUNNER_WS_CLOSE.staleScope, "environment allocation changed");
      return;
    }
    // The Runner must prove native execution on the exact Instance this scope allocated: the
    // reported sandbox name must match the scope resource before anything may become ready.
    if (!current.resourceName.endsWith(`/instances/${readiness.sandboxName}`)) {
      this.#send({
        type: "error",
        code: "RUNNER_READINESS_MISMATCH",
        message: "The reported native sandbox does not match the allocated Instance",
      });
      return;
    }
    const reported: RunnerReadiness = { ...readiness, reportedAt: new Date(this.#now()).toISOString() };
    const outcome = await this.#options.service.markRunnerReady(current, reported, { workspaceRestored });
    await this.#settleReadyOutcome(current, reported, outcome);
  }

  async #settleReadyOutcome(
    current: RunnerScope,
    reported: RunnerReadiness,
    outcome: RunnerReadyOutcome,
  ): Promise<void> {
    if (this.#closed) return;
    if (outcome === "stale") {
      this.#closeWith(RUNNER_WS_CLOSE.staleScope, "runner scope is stale");
      return;
    }
    if (outcome === "version_mismatch") {
      // The connection stays authenticated so an operator can see runnerConnected reasons; the
      // environment simply never becomes ready from a build that is not the pinned one.
      this.#send({
        type: "error",
        code: "RUNNER_VERSION_MISMATCH",
        message: "The Runner build does not match the version this Server requires",
      });
      return;
    }
    if (outcome === "workspace_not_restored") {
      // E5 fail-closed: without a restored workspace the environment must never become ready and
      // must never dispatch a blank state. The connection stays authenticated for diagnosis.
      this.#send({
        type: "error",
        code: "RUNNER_WORKSPACE_NOT_RESTORED",
        message: "The Runner did not restore its workspace; readiness is not accepted",
      });
      return;
    }
    // The hub only ever holds readiness the service accepted (correct pinned version, current
    // allocation); a mismatch must never flip snapshot.ready ahead of that verdict.
    if (!this.#options.hub.markReady(current, reported, this.#adapter)) {
      this.#closeWith(RUNNER_WS_CLOSE.staleScope, "this Runner connection was replaced");
      return;
    }
    if (outcome === "deferred") {
      // The service defers until the verified UID is tracked. With readiness now held by the hub,
      // an already-tracked row promotes immediately; an in-flight create caller promotes the rest
      // when its tracking completes.
      await this.#options.service.promoteDeferredReadiness(current.sandboxId);
    }
  }

  async #handleResult(current: RunnerScope, frame: RunnerAcceptanceResultFrame): Promise<void> {
    // An acceptance result resolves work that was already started on this exact channel. A legacy
    // E3 connection resolves only against the active authority chain (merge-base semantics: a
    // definitive miss revokes the live socket); a negotiated E4 connection may also resolve
    // accepted work against the exact persisted allocation after the active chain ended. A
    // transient validation failure drops the frame and leaves the socket alone either way.
    const holds = this.#cloudNegotiated ? await this.#channelHolds(current) : await this.#activeHolds(current);
    if (!holds) return;
    this.#options.hub.resolveAcceptanceResult(current.sandboxId, frame, this.#adapter);
  }

  async #handleDeliveryReceived(
    current: RunnerScope,
    frame: Extract<RunnerClientFrame, { type: "delivery:received" }>,
  ): Promise<void> {
    if (this.#reportOnly) {
      // Existing custody must finish through cancellation/reporting; a blanket rejection would
      // erase an accepted received entry from the Runner journal and fabricate a lost result.
      if (await this.#refreshReportOnlyConnection(current)) return;
      if (!(await this.#channelHolds(current))) return;
      const cloud = this.#requireCloudContext();
      if (cloud) await cloud.owner.handleInactiveDeliveryReceived(cloud.connection, frame);
      return;
    }
    // A stop can switch a live channel to releasing before this receipt arrives. Keep the exact
    // allocation connected so pending receipts can be rejected and accepted work can settle.
    const active = await this.#activeAllocationHolds(current);
    if (active === undefined) return;
    if (!(await this.#channelHolds(current))) return;
    const cloud = this.#requireCloudContext();
    if (!cloud) return;
    if (active) await cloud.owner.handleDeliveryReceived(cloud.connection, frame);
    else await cloud.owner.handleInactiveDeliveryReceived(cloud.connection, frame);
  }

  async #handleDeliveryReport(
    current: RunnerScope,
    frame: Extract<RunnerClientFrame, { type: "delivery:report" }>,
  ): Promise<void> {
    if (!(await this.#channelHolds(current))) return;
    const cloud = this.#requireCloudContext();
    if (!cloud) return;
    await cloud.owner.handleDeliveryReport(cloud.connection, frame);
  }

  async #handleQueryResult(
    current: RunnerScope,
    frame: Extract<RunnerClientFrame, { type: "delivery:query:result" }>,
  ): Promise<void> {
    if (!(await this.#channelHolds(current))) return;
    const cloud = this.#requireCloudContext();
    if (!cloud) return;
    cloud.owner.handleQueryResult(cloud.connection, frame);
    // The recovery query is the first server-driven traffic after a reauthorization restore:
    // switch the Runner back to an execution-capable connection as soon as the chain is active.
    await this.#refreshReportOnlyConnection(current);
  }

  async #handleCredentialFrame(
    current: RunnerScope,
    frame: Extract<RunnerClientFrame, { type: "credential:frame" }>,
  ): Promise<void> {
    if (!(await this.#channelHolds(current))) return;
    const cloud = this.#requireCloudContext();
    if (!cloud) return;
    if (this.#reportOnly && frame.frame.type === "runtime:execution:open") {
      // Report-only never mints a new execution permission, even if the credential owner's own
      // fences would allow it. A restored authority closes for a fresh active handshake instead.
      if (await this.#refreshReportOnlyConnection(current)) return;
      this.#send({
        type: "credential:frame",
        frame: {
          type: "runtime:execution:result",
          requestId: frame.frame.requestId,
          status: "rejected",
          code: "execution_authority_denied",
        },
      });
      return;
    }
    if (
      frame.frame.type === "runtime:execution:open" &&
      !executionOpenMatchesConnection(cloud.connection, frame.frame)
    ) {
      // The open must name exactly this connection's authenticated allocation (Session, Sandbox,
      // environment generation). The credential module fences the frame against the target
      // Session's persisted row, not against the SENDING connection, so without this binding a
      // Runner could open a credential execution for any Session it can name (defense in depth;
      // delivery sources are additionally covered by custody, session-message sources are not).
      this.#send({
        type: "credential:frame",
        frame: {
          type: "runtime:execution:result",
          requestId: frame.frame.requestId,
          status: "rejected",
          code: "sandbox_mismatch",
        },
      });
      return;
    }
    const result = await cloud.owner.handleCredentialFrame(cloud.connection, frame.frame);
    if (result && !this.#closed && this.#options.hub.isCurrent(current.sandboxId, this.#adapter)) {
      this.#send({ type: "credential:frame", frame: result });
    }
  }

  /**
   * E5 release seal results belong to the channel scope, never the manage scope: a releasing
   * environment (or an inactive Session) must still settle its save. The hub correlates the
   * result to the exact current socket and the exact pending request; anything else is dropped.
   */
  async #handleWorkspaceSealResult(
    current: RunnerScope,
    frame: Extract<RunnerClientFrame, { type: "workspace:seal:result" }>,
  ): Promise<void> {
    if (!(await this.#channelHolds(current))) return;
    this.#options.hub.settleWorkspaceSeal(current.sandboxId, frame, this.#adapter);
  }

  /** Report/query check with the shared close-on-miss semantics; false means the frame is dropped. */
  async #channelHolds(current: RunnerScope): Promise<boolean> {
    const holds = await this.#channelAllocationHolds(current);
    if (holds === undefined) return false;
    if (!holds) {
      this.#closeWith(RUNNER_WS_CLOSE.staleScope, "environment allocation changed");
      return false;
    }
    return true;
  }

  async #activeHolds(current: RunnerScope): Promise<boolean> {
    const holds = await this.#activeAllocationHolds(current);
    if (holds === undefined) return false;
    if (!holds) {
      this.#closeWith(RUNNER_WS_CLOSE.staleScope, "environment allocation changed");
      return false;
    }
    return true;
  }

  #requireCloudContext(): { connection: CloudConnectionRecord; owner: CloudDeliveryOwner } | undefined {
    const connection = this.#cloudConnection;
    const owner = this.#options.cloudDelivery;
    if (!connection || !owner) {
      this.#closeWith(RUNNER_WS_CLOSE.protocolError, "cloud delivery is not enabled on this channel");
      return undefined;
    }
    return { connection, owner };
  }

  /* ------------------------------------------------------------------------------------------
   * Frame parsing and serial dispatch
   * ---------------------------------------------------------------------------------------- */

  #parseClientFrame(raw: Buffer): RunnerClientFrame | undefined {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString("utf8"));
    } catch {
      this.#send({ type: "error", code: "PROTOCOL_ERROR", message: "Frames must be JSON" });
      this.#closeWith(RUNNER_WS_CLOSE.protocolError, "frame was not JSON");
      return undefined;
    }
    const frame = RunnerClientFrameSchema.safeParse(parsed);
    if (!frame.success) {
      this.#send({ type: "error", code: "PROTOCOL_ERROR", message: "Frame does not match the runner protocol" });
      this.#closeWith(RUNNER_WS_CLOSE.protocolError, "invalid frame");
      return undefined;
    }
    return frame.data;
  }

  async #dispatchAuthenticatedFrame(current: RunnerScope, data: RunnerClientFrame): Promise<void> {
    if (data.type === "heartbeat") {
      // The heartbeat cadence also re-evaluates a report-only latch: a restored authority chain
      // closes for the fresh active reconnect instead of leaving the Runner execution-blocked.
      if (await this.#refreshReportOnlyConnection(current)) return;
      this.#options.hub.acknowledge(current.sandboxId, this.#adapter, { type: "server:heartbeat" });
      return;
    }
    if (data.type === "runner:ready")
      return this.#handleReady(current, data.readiness, data.workspaceRestored === true);
    if (data.type === "acceptance:result") return this.#handleResult(current, data);
    if (data.type === "delivery:received") return this.#handleDeliveryReceived(current, data);
    if (data.type === "delivery:report") return this.#handleDeliveryReport(current, data);
    if (data.type === "delivery:query:result") return this.#handleQueryResult(current, data);
    if (data.type === "credential:frame") return this.#handleCredentialFrame(current, data);
    if (data.type === "workspace:seal:result") return this.#handleWorkspaceSealResult(current, data);
  }

  async #handleFirstFrame(data: RunnerClientFrame): Promise<void> {
    if (data.type !== "auth") {
      this.#closeWith(RUNNER_WS_CLOSE.authFailed, "the first frame must authenticate");
      return;
    }
    // E4/E5 capability negotiation happens on the auth frame; a legacy E3 auth never sets either
    // capability and keeps the exact legacy welcome/behavior.
    await this.#handleAuth(
      data.token,
      data.requestId,
      data.cloudDeliveryVersion === RUNNER_CLOUD_DELIVERY_VERSION,
      data.workspaceVersion === RUNNER_WORKSPACE_VERSION,
      data.renewExpired === true,
      data.controlToken,
      data.reuseVersion,
    );
  }

  async #handleAuthenticatedFrame(current: RunnerScope, data: RunnerClientFrame): Promise<void> {
    if (data.type === "auth") {
      this.#closeWith(RUNNER_WS_CLOSE.protocolError, "duplicate authentication frame");
      return;
    }
    if (!this.#options.hub.isCurrent(current.sandboxId, this.#adapter)) {
      this.#closeWith(RUNNER_WS_CLOSE.staleScope, "this Runner connection was replaced");
      return;
    }
    await this.#dispatchAuthenticatedFrame(current, data);
  }

  async #handleFrame(raw: Buffer): Promise<void> {
    if (this.#closed) return;
    const data = this.#parseClientFrame(raw);
    if (!data) return;
    const current = this.#scope;
    if (!current) {
      await this.#handleFirstFrame(data);
      return;
    }
    await this.#handleAuthenticatedFrame(current, data);
  }

  #enqueueFrame(raw: Buffer, isBinary: boolean): void {
    if (this.#closed) return;
    if (isBinary) {
      this.#closeWith(RUNNER_WS_CLOSE.protocolError, "binary frames are not part of the protocol");
      return;
    }
    // Bound the frame before any string conversion or JSON parse.
    if (raw.length > RUNNER_WS_MAX_FRAME_BYTES) {
      this.#closeWith(RUNNER_WS_CLOSE.protocolError, "frame exceeds the control-channel bound");
      return;
    }
    if (this.#queued >= MAX_QUEUED_FRAMES) {
      this.#closeWith(RUNNER_WS_CLOSE.protocolError, "too many queued frames");
      return;
    }
    this.#queued += 1;
    this.#chain = this.#chain
      .then(() => this.#handleFrame(raw))
      .catch((error: unknown) => {
        this.#request.log.warn({ err: error }, "Runner control channel failure");
        this.#closeWith(RUNNER_WS_CLOSE.protocolError, "internal failure");
      })
      .finally(() => {
        this.#queued -= 1;
      });
  }
}
