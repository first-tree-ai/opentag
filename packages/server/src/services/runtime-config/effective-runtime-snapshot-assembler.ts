import {
  AgentNameSchema,
  AgentRuntimeConfigSchema,
  computeAgentSkillsDigest,
  type EffectiveRuntimeSnapshot,
  EffectiveRuntimeSnapshotSchema,
  EMPTY_AGENT_SKILLS_DIGEST,
  hashTuple,
  renderPlatformInstructions,
} from "@opentag/shared";
import { eq } from "drizzle-orm";
import type { DatabaseClient } from "../../db/client.js";
import { agentRuntimeConfigs, agentSkills, agents, imBindings, sessions, skills } from "../../db/schema/index.js";
import { EffectiveRuntimeSnapshotAssemblerError } from "./errors.js";
import { isServerAdmittedAgentRuntimeProvider, serverAgentRuntimeProviderPolicy } from "./provider-admission.js";

interface EffectiveRuntimeSnapshotAuthority {
  agentStatus: string;
  agentId: string;
  agentName: string;
  imBindingStatus: string;
  runtimeConfig: unknown;
  runtimeProvider: string;
  sessionEndedAt: Date | null;
  sessionId: string;
  sessionKind: "channel" | "thread" | "internal";
  sessionRuntimeModel: string | null;
  sessionRuntimeReasoningEffort: string | null;
  sessionRuntimeMaxDurationMs: number | null;
  /** Digest of the skills assigned to the agent; the empty-set constant when the loader does not supply one. */
  skillsDigest?: string;
}

type AuthorityLoader = (sessionId: string) => Promise<EffectiveRuntimeSnapshotAuthority | undefined>;

export class EffectiveRuntimeSnapshotAssembler {
  readonly #loadAuthority: AuthorityLoader;

  constructor(database: DatabaseClient, options: { loadAuthority?: AuthorityLoader } = {}) {
    this.#loadAuthority = options.loadAuthority ?? ((sessionId) => loadAuthority(database, sessionId));
  }

  async assembleForSession(sessionId: string): Promise<EffectiveRuntimeSnapshot> {
    let authority: EffectiveRuntimeSnapshotAuthority | undefined;
    try {
      authority = await this.#loadAuthority(sessionId);
    } catch (error) {
      throw new EffectiveRuntimeSnapshotAssemblerError("DATABASE_FAILURE", { cause: error });
    }
    if (!authority) throw new EffectiveRuntimeSnapshotAssemblerError("SESSION_NOT_FOUND");
    if (
      authority.sessionEndedAt !== null ||
      authority.imBindingStatus !== "active" ||
      authority.agentStatus !== "active"
    ) {
      throw new EffectiveRuntimeSnapshotAssemblerError("AUTHORITY_INACTIVE");
    }
    if (!isServerAdmittedAgentRuntimeProvider(authority.runtimeProvider)) {
      throw new EffectiveRuntimeSnapshotAssemblerError("UNSUPPORTED_PROVIDER");
    }
    const providerPolicy = serverAgentRuntimeProviderPolicy(authority.runtimeProvider);
    if (authority.runtimeConfig === null) {
      throw new EffectiveRuntimeSnapshotAssemblerError("RUNTIME_CONFIG_MISSING");
    }
    const parsedConfig = AgentRuntimeConfigSchema.safeParse(authority.runtimeConfig);
    if (!parsedConfig.success) {
      throw new EffectiveRuntimeSnapshotAssemblerError("INVALID_STORED_CONFIG", { cause: parsedConfig.error });
    }
    const config = parsedConfig.data;
    const platformInstructions = renderAgentPlatformInstructions(authority.agentName);
    const model = authority.sessionKind === "internal" ? (authority.sessionRuntimeModel ?? config.model) : config.model;
    const reasoningEffort =
      authority.sessionKind === "internal"
        ? (authority.sessionRuntimeReasoningEffort ?? config.reasoningEffort)
        : config.reasoningEffort;
    const maxDurationMs =
      authority.sessionKind === "internal"
        ? (authority.sessionRuntimeMaxDurationMs ?? config.maxDurationMs)
        : config.maxDurationMs;
    const agentRevisionId = revisionId("agent", [
      authority.agentId,
      authority.runtimeProvider,
      // The exact rendered platform string, so a slug change produces a new Agent revision.
      platformInstructions,
      config.instructions,
      authority.agentId,
      "empty_on_create",
      "agent",
    ]);
    const sessionRevisionId = revisionId(
      "session",
      authority.sessionKind === "internal"
        ? [
            authority.sessionId,
            authority.sessionKind,
            model,
            reasoningEffort,
            null,
            providerPolicy.execution.approvalPolicy,
            providerPolicy.execution.networkAccess,
            maxDurationMs,
          ]
        : [
            authority.sessionId,
            config.model,
            config.reasoningEffort,
            null,
            providerPolicy.execution.approvalPolicy,
            providerPolicy.execution.networkAccess,
            config.maxDurationMs,
          ],
    );
    const snapshot = EffectiveRuntimeSnapshotSchema.safeParse({
      revision: {
        agent: { sequence: config.revision, id: agentRevisionId },
        session: {
          sequence: config.revision,
          id: sessionRevisionId,
        },
      },
      agentId: authority.agentId,
      provider: authority.runtimeProvider,
      ...(model !== null ? { model } : {}),
      ...(reasoningEffort !== null ? { reasoningEffort } : {}),
      instructions: {
        platform: platformInstructions,
        agent: config.instructions,
      },
      execution: providerPolicy.execution,
      workspace: { workspaceId: authority.agentId, mode: "empty_on_create", sharing: "agent" },
      ...(maxDurationMs !== null ? { budget: { maxDurationMs } } : {}),
      skills: skillsLayer(authority),
    });
    if (!snapshot.success) {
      throw new EffectiveRuntimeSnapshotAssemblerError("SNAPSHOT_INVALID", { cause: snapshot.error });
    }
    return snapshot.data;
  }
}

async function loadAuthority(
  database: DatabaseClient,
  sessionId: string,
): Promise<EffectiveRuntimeSnapshotAuthority | undefined> {
  const [row] = await database
    .select({
      sessionId: sessions.id,
      sessionKind: sessions.kind,
      sessionRuntimeModel: sessions.runtimeModel,
      sessionRuntimeReasoningEffort: sessions.runtimeReasoningEffort,
      sessionRuntimeMaxDurationMs: sessions.runtimeMaxDurationMs,
      sessionEndedAt: sessions.endedAt,
      imBindingStatus: imBindings.status,
      agentId: agents.id,
      agentName: agents.name,
      agentStatus: agents.status,
      runtimeProvider: agents.runtimeProvider,
      configRevision: agentRuntimeConfigs.revision,
      configModel: agentRuntimeConfigs.model,
      configReasoningEffort: agentRuntimeConfigs.reasoningEffort,
      configInstructions: agentRuntimeConfigs.instructions,
      configMaxDurationMs: agentRuntimeConfigs.maxDurationMs,
    })
    .from(sessions)
    .innerJoin(imBindings, eq(imBindings.id, sessions.imBindingId))
    .innerJoin(agents, eq(agents.id, imBindings.agentId))
    .leftJoin(agentRuntimeConfigs, eq(agentRuntimeConfigs.agentId, agents.id))
    .where(eq(sessions.id, sessionId))
    .limit(1);
  if (!row) return undefined;
  return {
    skillsDigest: await loadAgentSkillsDigest(database, row.agentId),
    agentStatus: row.agentStatus,
    agentId: row.agentId,
    agentName: row.agentName,
    imBindingStatus: row.imBindingStatus,
    runtimeConfig:
      row.configRevision === null
        ? null
        : {
            revision: row.configRevision,
            model: row.configModel,
            reasoningEffort: row.configReasoningEffort,
            instructions: row.configInstructions,
            maxDurationMs: row.configMaxDurationMs,
          },
    runtimeProvider: row.runtimeProvider,
    sessionEndedAt: row.sessionEndedAt,
    sessionId: row.sessionId,
    sessionKind: row.sessionKind,
    sessionRuntimeModel: row.sessionRuntimeModel,
    sessionRuntimeReasoningEffort: row.sessionRuntimeReasoningEffort,
    sessionRuntimeMaxDurationMs: row.sessionRuntimeMaxDurationMs,
  };
}

function skillsLayer(authority: EffectiveRuntimeSnapshotAuthority): { digest: string } {
  return { digest: authority.skillsDigest ?? EMPTY_AGENT_SKILLS_DIGEST };
}

async function loadAgentSkillsDigest(database: DatabaseClient, agentId: string): Promise<string> {
  const rows = await database
    .select({ name: skills.name, digest: skills.digest })
    .from(agentSkills)
    .innerJoin(skills, eq(skills.id, agentSkills.skillId))
    .where(eq(agentSkills.agentId, agentId));
  return computeAgentSkillsDigest(rows);
}

/**
 * Render the trusted platform layer for one Agent.
 *
 * The canonical slug is the Agent name. A stored name that no longer satisfies the schema fails
 * closed rather than reaching a Session as a malformed identity, because the Agent would then
 * write to the wrong `members/<agent-slug>/` directory in a shared Context Tree.
 */
function renderAgentPlatformInstructions(agentName: string): string {
  const parsed = AgentNameSchema.safeParse(agentName);
  if (!parsed.success) {
    throw new EffectiveRuntimeSnapshotAssemblerError("INVALID_STORED_CONFIG", { cause: parsed.error });
  }
  return renderPlatformInstructions({ agentSlug: parsed.data });
}

function revisionId(layer: "agent" | "session", values: readonly unknown[]): string {
  return hashTuple(["opentag-runtime-revision", 1, layer, ...values]);
}
