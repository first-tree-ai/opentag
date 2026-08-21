import {
  AgentRuntimeConfigSchema,
  type EffectiveRuntimeSnapshot,
  EffectiveRuntimeSnapshotSchema,
  hashTuple,
  OPENTAG_PLATFORM_INSTRUCTIONS,
} from "@opentag/shared";
import { eq } from "drizzle-orm";
import type { DatabaseClient } from "../../db/client.js";
import { agentRuntimeConfigs, agents, imBindings, sessions } from "../../db/schema/index.js";
import { EffectiveRuntimeSnapshotAssemblerError } from "./errors.js";
import { isServerAdmittedAgentRuntimeProvider, serverAgentRuntimeProviderPolicy } from "./provider-admission.js";

interface EffectiveRuntimeSnapshotAuthority {
  agentStatus: string;
  agentId: string;
  imBindingStatus: string;
  runtimeConfig: unknown;
  runtimeProvider: string;
  sessionEndedAt: Date | null;
  sessionId: string;
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
    const agentRevisionId = revisionId("agent", [
      authority.agentId,
      authority.runtimeProvider,
      OPENTAG_PLATFORM_INSTRUCTIONS,
      config.instructions,
      authority.agentId,
      "empty_on_create",
      "agent",
    ]);
    const sessionRevisionId = revisionId("session", [
      authority.sessionId,
      config.model,
      config.reasoningEffort,
      null,
      providerPolicy.execution.approvalPolicy,
      providerPolicy.execution.networkAccess,
      config.maxDurationMs,
    ]);
    const snapshot = EffectiveRuntimeSnapshotSchema.safeParse({
      revision: {
        agent: { sequence: config.revision, id: agentRevisionId },
        session: { sequence: config.revision, id: sessionRevisionId },
      },
      agentId: authority.agentId,
      provider: authority.runtimeProvider,
      ...(config.model !== null ? { model: config.model } : {}),
      ...(config.reasoningEffort !== null ? { reasoningEffort: config.reasoningEffort } : {}),
      instructions: {
        platform: OPENTAG_PLATFORM_INSTRUCTIONS,
        agent: config.instructions,
      },
      execution: providerPolicy.execution,
      workspace: { workspaceId: authority.agentId, mode: "empty_on_create", sharing: "agent" },
      ...(config.maxDurationMs !== null ? { budget: { maxDurationMs: config.maxDurationMs } } : {}),
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
      sessionEndedAt: sessions.endedAt,
      imBindingStatus: imBindings.status,
      agentId: agents.id,
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
    agentStatus: row.agentStatus,
    agentId: row.agentId,
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
  };
}

function revisionId(layer: "agent" | "session", values: readonly unknown[]): string {
  return hashTuple(["opentag-runtime-revision", 1, layer, ...values]);
}
