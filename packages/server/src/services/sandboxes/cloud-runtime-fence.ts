import { createHash, randomUUID } from "node:crypto";
import type { RuntimeControlIdentity } from "../../runtime/connection-registry.js";
import type { RunnerControlSocket, RunnerScope } from "./runner-hub.js";

/**
 * Live Cloud Runner connection facts, keyed per Sandbox — one Agent Session owns one Sandbox and
 * therefore at most one current Runner connection. This is deliberately NOT the Local
 * ConnectionRegistry: a Cloud Computer is a logical identity with many Session Sandboxes, and no
 * Runner attach/detach may ever mutate the Computer's online state or evict another Session's
 * entry. The Local registry stays untouched; Cloud fencing consults only this map.
 */

export interface CloudConnectionRecord {
  readonly computerId: string;
  /** Exact per-attach identity; credential executions die with it. */
  readonly connectionId: string;
  readonly installationId: string;
  /** Deterministic per-allocation runtime identity (`cloudInstanceIdFor`). */
  readonly instanceId: string;
  readonly scope: RunnerScope;
  /**
   * Exact socket this connection authenticated on. Result/revocation frames are only ever sent to
   * this socket while it is still the hub's current socket for the scope; a replacement
   * connection can never receive the superseded connection's frames. Records created directly by
   * the fence (tests, recovery fixtures) omit it and fall back to the hub's current socket only
   * while this exact connectionId is still the fence's current entry for the Sandbox.
   */
  readonly socket?: RunnerControlSocket;
  /**
   * Whether this connection may be handed Session-CLI proofs and receive `session:message:*`
   * frames. Set only when the Runner requested the E8 capability in its auth frame and the Server
   * echoed it; a legacy E7 Runner keeps existing IM delivery with no unknown field or frame.
   */
  readonly sessionCollaborationEligible: boolean;
  /**
   * Whether this connection may receive execution permission. A report-only reconnect (the active
   * authority chain was inactive at handshake) sets false: existing custody may still be settled
   * or reported, but no grant is ever minted until a fresh active handshake replaces the record.
   */
  readonly executionEligible: boolean;
}

/**
 * Deterministic per-allocation instance identity (UUID v5 over the allocation scope). It changes
 * with every new environment generation, so a superseded allocation can never report turns or
 * hold credential executions against the current one — without persisting anything new.
 */
export function cloudInstanceIdFor(scope: RunnerScope): string {
  const digest = createHash("sha1")
    .update(`opentag-cloud-instance:${scope.sandboxId}:${scope.environmentGeneration}:${scope.resourceName}`)
    .digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export class CloudRuntimeFence {
  readonly #byConnection = new Map<string, CloudConnectionRecord>();
  readonly #bySandbox = new Map<string, string>();

  /** Register an authenticated, hub-attached connection. One current connection per Sandbox. */
  attach(input: {
    computerId: string;
    installationId: string;
    scope: RunnerScope;
    socket?: RunnerControlSocket;
    executionEligible?: boolean;
    sessionCollaborationEligible?: boolean;
  }): CloudConnectionRecord {
    this.detachSandbox(input.scope.sandboxId);
    const record: CloudConnectionRecord = {
      computerId: input.computerId,
      connectionId: randomUUID(),
      installationId: input.installationId,
      instanceId: cloudInstanceIdFor(input.scope),
      scope: input.scope,
      ...(input.socket ? { socket: input.socket } : {}),
      executionEligible: input.executionEligible !== false,
      sessionCollaborationEligible: input.sessionCollaborationEligible === true,
    };
    this.#byConnection.set(record.connectionId, record);
    this.#bySandbox.set(input.scope.sandboxId, record.connectionId);
    return record;
  }

  detach(connectionId: string): CloudConnectionRecord | undefined {
    const record = this.#byConnection.get(connectionId);
    if (!record) return undefined;
    this.#byConnection.delete(connectionId);
    if (this.#bySandbox.get(record.scope.sandboxId) === connectionId) {
      this.#bySandbox.delete(record.scope.sandboxId);
    }
    return record;
  }

  detachSandbox(sandboxId: string): void {
    const connectionId = this.#bySandbox.get(sandboxId);
    if (connectionId) this.detach(connectionId);
  }

  connectionForSandbox(sandboxId: string): CloudConnectionRecord | undefined {
    const connectionId = this.#bySandbox.get(sandboxId);
    return connectionId ? this.#byConnection.get(connectionId) : undefined;
  }

  /** The exact attach record for one connection id, or undefined when it was detached. */
  connectionById(connectionId: string): CloudConnectionRecord | undefined {
    return this.#byConnection.get(connectionId);
  }

  /**
   * The current exact connection for one allocation identity. Several Session Runners of one
   * Cloud Computer may be attached; the (computerId, instanceId) pair is the allocation identity,
   * so a revocation for a specific execution reaches exactly its owning connection.
   */
  connectionForInstance(computerId: string, instanceId: string): CloudConnectionRecord | undefined {
    for (const record of this.#byConnection.values()) {
      if (record.computerId === computerId && record.instanceId === instanceId) return record;
    }
    return undefined;
  }

  /** Exact connection fence for credential executions and report/recipient routing. */
  isCurrent(computerId: string, instanceId: string, connectionId: string): boolean {
    const record = this.#byConnection.get(connectionId);
    return record?.computerId === computerId && record.instanceId === instanceId;
  }

  /**
   * A live Cloud control identity for the Computer when any Session Runner is attached. The
   * credentialId names the exact connection; `isControlActive` re-validates it per use, and the
   * strong per-execution fence remains the exact `isCurrent` connection check.
   */
  currentControlIdentity(computerId: string): RuntimeControlIdentity | undefined {
    for (const record of this.#byConnection.values()) {
      if (record.computerId !== computerId) continue;
      return {
        credentialId: `cloud-runner:${record.connectionId}`,
        computerId: record.computerId,
        installationId: record.installationId,
        kind: "cloud",
      };
    }
    return undefined;
  }

  isControlActive(identity: RuntimeControlIdentity): boolean {
    if (identity.kind !== "cloud") return false;
    const prefix = "cloud-runner:";
    if (!identity.credentialId.startsWith(prefix)) return false;
    const connectionId = identity.credentialId.slice(prefix.length);
    const record = this.#byConnection.get(connectionId);
    return record?.computerId === identity.computerId;
  }
}
