import { eq } from "drizzle-orm";
import type { DatabaseClient } from "../db/client.js";
import {
  agents,
  computers,
  imBindings,
  sandboxes,
  sessionPlacements,
  sessions,
  slackInstallations,
} from "../db/schema/index.js";
import type { RuntimeExecutionRecord } from "./types.js";

export interface RuntimeBindingSnapshot {
  id: string;
  agentId: string;
  provider: "feishu" | "slack";
  status: string;
  credentialGeneration: number;
  externalAppId: string | null;
  externalTeamId: string | null;
  externalTeamBrand: string | null;
  externalBotId: string | null;
  slackInstallationId: string | null;
}

export interface RuntimeSlackInstallationSnapshot {
  id: string;
  agentId: string;
  status: string;
  credentialGeneration: number;
  externalTeamId: string | null;
  externalBotId: string | null;
}

/**
 * Binding/agent/computer facts for a Server-issued validation run. A validation execution has no
 * business Session (and must never invent one), so its fence is the exact binding plus the owning
 * Agent, Computer, and provider installation rows at their current revisions.
 */
export interface RuntimeValidationScopeSnapshot {
  agent: { id: string; status: string; revision: number; computerId: string | null; createdByUserId: string };
  binding: RuntimeBindingSnapshot;
  slackInstallation: RuntimeSlackInstallationSnapshot | null;
  computer: { id: string; kind: "local" | "cloud"; ownerAccountId: string };
}

export interface RuntimeScopeSnapshot {
  sessionId: string;
  sessionKind: "channel" | "thread" | "internal";
  sessionEnded: boolean;
  channelId: string;
  threadKey: string | null;
  binding: RuntimeBindingSnapshot;
  slackInstallation: RuntimeSlackInstallationSnapshot | null;
  agent: {
    id: string;
    status: string;
    revision: number;
    computerId: string | null;
    createdByUserId: string;
  };
  placement: { computerId: string; generation: number } | null;
  computer: { id: string; kind: "local" | "cloud"; ownerAccountId: string };
  sandbox: {
    id: string;
    resourceUid: string | null;
    environmentGeneration: number;
    lifecycle: string;
  } | null;
}

export type RuntimeFenceViolation =
  | "session_unknown"
  | "session_ended"
  | "session_internal"
  | "agent_mismatch"
  | "agent_inactive"
  | "agent_revision_changed"
  | "placement_stale"
  | "ownership_mismatch"
  | "binding_inactive"
  | "installation_inactive"
  | "sandbox_mismatch";

/** Structural port so tests can substitute in-memory fences; the Postgres resolver is the production one. */
export interface RuntimeScopeResolverPort {
  load(sessionId: string): Promise<RuntimeScopeSnapshot | undefined>;
  /** Validation executions load the binding fence instead of a Session fence. */
  loadValidationScope?(input: {
    bindingId: string;
    agentId: string;
  }): Promise<RuntimeValidationScopeSnapshot | undefined>;
  assertExecutionFence(
    record: RuntimeExecutionRecord,
    snapshot: RuntimeScopeSnapshot,
  ): RuntimeFenceViolation | undefined;
}

export class RuntimeScopeResolver {
  readonly #database: DatabaseClient;

  constructor(database: DatabaseClient) {
    this.#database = database;
  }

  /** Fresh per-request read: fencing never trusts a cached cross-request snapshot. */
  async load(sessionId: string): Promise<RuntimeScopeSnapshot | undefined> {
    const [row] = await this.#database
      .select({
        sessionId: sessions.id,
        sessionKind: sessions.kind,
        sessionEndedAt: sessions.endedAt,
        channelId: sessions.channelId,
        threadKey: sessions.threadKey,
        binding: imBindings,
        slackInstallation: slackInstallations,
        agentId: agents.id,
        agentStatus: agents.status,
        agentRevision: agents.revision,
        agentComputerId: agents.computerId,
        agentCreatedByUserId: agents.createdByUserId,
        placementComputerId: sessionPlacements.computerId,
        placementGeneration: sessionPlacements.generation,
        computerId: computers.id,
        computerKind: computers.kind,
        computerOwnerAccountId: computers.ownerAccountId,
      })
      .from(sessions)
      .innerJoin(imBindings, eq(imBindings.id, sessions.imBindingId))
      .innerJoin(agents, eq(agents.id, imBindings.agentId))
      .leftJoin(slackInstallations, eq(slackInstallations.id, imBindings.slackInstallationId))
      .leftJoin(sessionPlacements, eq(sessionPlacements.sessionId, sessions.id))
      .leftJoin(computers, eq(computers.id, sessionPlacements.computerId))
      .where(eq(sessions.id, sessionId))
      .limit(1);
    if (!row?.computerId || !row.computerKind || !row.computerOwnerAccountId) return undefined;
    const sandboxRows = await this.#database
      .select({
        id: sandboxes.id,
        resourceUid: sandboxes.currentResourceUid,
        environmentGeneration: sandboxes.environmentGeneration,
        lifecycle: sandboxes.lifecycle,
      })
      .from(sandboxes)
      .where(eq(sandboxes.sessionId, sessionId))
      .limit(1);
    const sandbox = sandboxRows[0];
    return {
      sessionId: row.sessionId,
      sessionKind: row.sessionKind,
      sessionEnded: row.sessionEndedAt !== null,
      channelId: row.channelId,
      threadKey: row.threadKey,
      binding: {
        id: row.binding.id,
        agentId: row.binding.agentId,
        provider: row.binding.provider,
        status: row.binding.status,
        credentialGeneration: row.binding.credentialGeneration,
        externalAppId: row.binding.externalAppId,
        externalTeamId: row.binding.externalTeamId,
        externalTeamBrand: row.binding.externalTeamBrand,
        externalBotId: row.binding.externalBotId,
        slackInstallationId: row.binding.slackInstallationId,
      },
      slackInstallation: row.slackInstallation
        ? {
            id: row.slackInstallation.id,
            agentId: row.slackInstallation.agentId,
            status: row.slackInstallation.status,
            credentialGeneration: row.slackInstallation.credentialGeneration,
            externalTeamId: row.slackInstallation.externalTeamId,
            externalBotId: row.slackInstallation.externalBotId,
          }
        : null,
      agent: {
        id: row.agentId,
        status: row.agentStatus,
        revision: row.agentRevision,
        computerId: row.agentComputerId,
        createdByUserId: row.agentCreatedByUserId,
      },
      placement:
        row.placementComputerId && row.placementGeneration
          ? { computerId: row.placementComputerId, generation: row.placementGeneration }
          : null,
      computer: { id: row.computerId, kind: row.computerKind, ownerAccountId: row.computerOwnerAccountId },
      sandbox: sandbox ?? null,
    };
  }

  /** Compares a fresh snapshot against the facts pinned at execution open. */
  assertExecutionFence(
    record: RuntimeExecutionRecord,
    snapshot: RuntimeScopeSnapshot,
  ): RuntimeFenceViolation | undefined {
    if (snapshot.sessionId !== record.sessionId) return "session_unknown";
    if (snapshot.sessionEnded) return "session_ended";
    // A Local internal Session (or any internal Session without the explicit Cloud collaboration
    // authority) stays closed here. The exact open-time decision is carried on the record, so the
    // per-request fence never has to re-derive authorization from the frame or the connection.
    if (snapshot.sessionKind === "internal" && record.internalAuthority !== "cloud-session-collaboration") {
      return "session_internal";
    }
    if (snapshot.agent.id !== record.agentId || snapshot.agent.computerId !== record.computerId) {
      return "agent_mismatch";
    }
    if (snapshot.agent.status !== "active") return "agent_inactive";
    if (snapshot.agent.revision !== record.agentRevision) return "agent_revision_changed";
    if (
      !snapshot.placement ||
      snapshot.placement.computerId !== record.computerId ||
      snapshot.placement.generation !== record.placementGeneration
    ) {
      return "placement_stale";
    }
    if (snapshot.computer.ownerAccountId !== record.accountId) return "ownership_mismatch";
    if (snapshot.binding.status !== "active") return "binding_inactive";
    if (record.computerKind === "cloud") {
      const sandboxViolation = cloudSandboxFenceViolation(record, snapshot);
      if (sandboxViolation) return sandboxViolation;
    }
    return undefined;
  }

  /** Fresh per-request read for a Server-issued validation run: binding + Agent + Computer rows. */
  async loadValidationScope(input: {
    bindingId: string;
    agentId: string;
  }): Promise<RuntimeValidationScopeSnapshot | undefined> {
    const [row] = await this.#database
      .select({
        binding: imBindings,
        slackInstallation: slackInstallations,
        agentId: agents.id,
        agentStatus: agents.status,
        agentRevision: agents.revision,
        agentComputerId: agents.computerId,
        agentCreatedByUserId: agents.createdByUserId,
        computerId: computers.id,
        computerKind: computers.kind,
        computerOwnerAccountId: computers.ownerAccountId,
      })
      .from(imBindings)
      .innerJoin(agents, eq(agents.id, imBindings.agentId))
      .leftJoin(slackInstallations, eq(slackInstallations.id, imBindings.slackInstallationId))
      .leftJoin(computers, eq(computers.id, agents.computerId))
      .where(eq(imBindings.id, input.bindingId))
      .limit(1);
    if (!row?.computerId || !row.computerKind || !row.computerOwnerAccountId || row.agentId !== input.agentId) {
      return undefined;
    }
    return {
      agent: {
        id: row.agentId,
        status: row.agentStatus,
        revision: row.agentRevision,
        computerId: row.agentComputerId,
        createdByUserId: row.agentCreatedByUserId,
      },
      binding: {
        id: row.binding.id,
        agentId: row.binding.agentId,
        provider: row.binding.provider,
        status: row.binding.status,
        credentialGeneration: row.binding.credentialGeneration,
        externalAppId: row.binding.externalAppId,
        externalTeamId: row.binding.externalTeamId,
        externalTeamBrand: row.binding.externalTeamBrand,
        externalBotId: row.binding.externalBotId,
        slackInstallationId: row.binding.slackInstallationId,
      },
      slackInstallation: row.slackInstallation
        ? {
            id: row.slackInstallation.id,
            agentId: row.slackInstallation.agentId,
            status: row.slackInstallation.status,
            credentialGeneration: row.slackInstallation.credentialGeneration,
            externalTeamId: row.slackInstallation.externalTeamId,
            externalBotId: row.slackInstallation.externalBotId,
          }
        : null,
      computer: {
        id: row.computerId,
        kind: row.computerKind,
        ownerAccountId: row.computerOwnerAccountId,
      },
    };
  }
}

/** Exact Cloud allocation fence for per-request scope checks. */
function cloudSandboxFenceViolation(
  record: RuntimeExecutionRecord,
  snapshot: RuntimeScopeSnapshot,
): RuntimeFenceViolation | undefined {
  if (
    !record.sandbox ||
    !snapshot.sandbox ||
    snapshot.sandbox.id !== record.sandbox.sandboxId ||
    snapshot.sandbox.resourceUid !== record.sandbox.resourceUid ||
    snapshot.sandbox.environmentGeneration !== record.sandbox.environmentGeneration ||
    snapshot.sandbox.lifecycle !== "ready"
  ) {
    return "sandbox_mismatch";
  }
  return undefined;
}

/** Compares a validation execution against its fresh binding/agent/computer snapshot. */
export function assertValidationExecutionFence(
  record: RuntimeExecutionRecord,
  snapshot: RuntimeValidationScopeSnapshot,
): RuntimeFenceViolation | undefined {
  const entry = record.validation;
  if (!entry) return "binding_inactive";
  if (snapshot.agent.id !== record.agentId || snapshot.agent.computerId !== record.computerId) {
    return "agent_mismatch";
  }
  if (snapshot.agent.status !== "active") return "agent_inactive";
  if (snapshot.agent.revision !== record.agentRevision) return "agent_revision_changed";
  if (snapshot.computer.ownerAccountId !== record.accountId) return "ownership_mismatch";
  if (snapshot.binding.id !== entry.bindingId || snapshot.binding.provider !== entry.provider) {
    return "binding_inactive";
  }
  if (snapshot.binding.status !== "active") return "binding_inactive";
  if (
    entry.provider === "slack" &&
    (snapshot.slackInstallation?.status !== "active" || snapshot.slackInstallation.agentId !== snapshot.agent.id)
  ) {
    return "installation_inactive";
  }
  return undefined;
}
