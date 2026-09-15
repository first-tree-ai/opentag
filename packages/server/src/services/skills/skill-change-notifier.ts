import { RUNTIME_CAPABILITY, RUNTIME_SKILLS_CHANGED_MAX_AGENTS, SkillsChangedFrameSchema } from "@opentag/shared";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import type { DatabaseClient } from "../../db/client.js";
import { agents } from "../../db/schema/index.js";
import type { ServiceLogger } from "../../observability/index.js";
import type { ConnectionRegistry } from "../../runtime/connection-registry.js";

/** Tells the daemons hosting the affected agents that their assigned skill set changed. Best effort by design. */
export interface SkillChangeNotifier {
  notifyAgents(agentIds: readonly string[]): Promise<void>;
}

export interface RegistrySkillChangeNotifierOptions {
  database: DatabaseClient;
  registry: Pick<ConnectionRegistry, "currentInstanceId" | "supportsCapability" | "send">;
  digestFor(agentId: string): Promise<string>;
  logger?: ServiceLogger;
}

const noopLogger: ServiceLogger = { debug() {}, info() {}, warn() {}, error() {} };

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

/**
 * Sends `skills:changed` to every online computer hosting one of the agents, but only over connections that
 * negotiated `runtime.skillsSync`; an older daemon never sees a frame it cannot parse. The effective runtime snapshot
 * carries the same digest, so a daemon that missed the frame still converges on its next reconcile.
 */
export class RegistrySkillChangeNotifier implements SkillChangeNotifier {
  readonly #options: RegistrySkillChangeNotifierOptions;
  readonly #logger: ServiceLogger;

  constructor(options: RegistrySkillChangeNotifierOptions) {
    this.#options = options;
    this.#logger = options.logger ?? noopLogger;
  }

  async notifyAgents(agentIds: readonly string[]): Promise<void> {
    const unique = [...new Set(agentIds)];
    if (unique.length === 0) return;
    const byComputer = await this.#groupByComputer(unique);
    for (const [computerId, computerAgents] of byComputer) {
      const instanceId = this.#options.registry.currentInstanceId(computerId);
      if (!instanceId) continue;
      if (!this.#options.registry.supportsCapability(computerId, instanceId, RUNTIME_CAPABILITY.skillsSync)) continue;
      await this.#sendFrames(computerId, instanceId, computerAgents);
    }
  }

  async #groupByComputer(agentIds: string[]): Promise<Map<string, string[]>> {
    const rows = await this.#options.database
      .select({ agentId: agents.id, computerId: agents.computerId })
      .from(agents)
      .where(and(inArray(agents.id, agentIds), eq(agents.status, "active"), isNotNull(agents.computerId)));
    const byComputer = new Map<string, string[]>();
    for (const row of rows) {
      if (!row.computerId) continue;
      byComputer.set(row.computerId, [...(byComputer.get(row.computerId) ?? []), row.agentId]);
    }
    return byComputer;
  }

  async #sendFrames(computerId: string, instanceId: string, agentIds: string[]): Promise<void> {
    const entries = await Promise.all(
      agentIds.map(async (agentId) => ({ agentId, digest: await this.#options.digestFor(agentId) })),
    );
    for (const batch of chunk(entries, RUNTIME_SKILLS_CHANGED_MAX_AGENTS)) {
      const frame = SkillsChangedFrameSchema.parse({ type: "skills:changed", agents: batch });
      try {
        await this.#options.registry.send(computerId, instanceId, frame);
      } catch (error) {
        this.#logger.warn(
          { computerId, agentCount: batch.length, err: error },
          "skills:changed frame was not delivered",
        );
      }
    }
  }
}
