import type { FastifyBaseLogger } from "fastify";
import type { SkillRouteServices } from "../../api/skill-routes-shared.js";
import type { ServerConfig } from "../../config.js";
import type { DatabaseClient } from "../../db/client.js";
import type { ServiceLogger } from "../../observability/index.js";
import type { ConnectionRegistry } from "../../runtime/connection-registry.js";
import { S3SkillBlobStore } from "./s3-skill-blob-store.js";
import { SkillAssignmentService } from "./skill-assignment-service.js";
import { RegistrySkillChangeNotifier } from "./skill-change-notifier.js";
import { SkillOrphanSweeper } from "./skill-orphan-sweeper.js";
import { SkillService } from "./skill-service.js";

export interface SkillCompositionInput {
  config: Pick<ServerConfig, "skillStorage">;
  database: DatabaseClient;
  registry: Pick<ConnectionRegistry, "currentInstanceId" | "supportsCapability" | "send">;
  serviceLogger(module: string): ServiceLogger;
}

export interface SkillComposition {
  /** Spread into `createApp`; empty when storage is not configured so the routes answer 503. */
  appOptions: { skills?: SkillRouteServices };
  /** Verifies the bucket in the background and starts the orphan sweeper. */
  start(log: FastifyBaseLogger): void;
  stop(): void;
}

/** Environment values that must never appear in startup diagnostics. */
export function skillStorageSecretValues(environment: NodeJS.ProcessEnv): string[] {
  return [
    environment.OPENTAG_SKILL_STORAGE_S3_ACCESS_KEY_ID,
    environment.OPENTAG_SKILL_STORAGE_S3_SECRET_ACCESS_KEY,
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
}

/** Wires the skill library for one server process; without a bucket it composes nothing and the routes answer 503. */
export function composeSkillServices(input: SkillCompositionInput): SkillComposition {
  const storage = input.config.skillStorage;
  if (!storage) return { appOptions: {}, start: () => undefined, stop: () => undefined };
  const store = S3SkillBlobStore.fromConfig(storage);
  const assignments = new SkillAssignmentService(input.database);
  const skills = new SkillService(input.database, store, { logger: input.serviceLogger("skills") });
  const notifier = new RegistrySkillChangeNotifier({
    database: input.database,
    registry: input.registry,
    digestFor: (agentId) => assignments.agentDigest(agentId),
    logger: input.serviceLogger("skills-notifier"),
  });
  const sweeper = new SkillOrphanSweeper({
    database: input.database,
    store,
    logger: input.serviceLogger("skills-sweeper"),
  });
  return {
    appOptions: { skills: { skills, assignments, notifier } },
    start: (log) => {
      void store.healthCheck().then(
        () => log.info({ bucket: storage.bucket }, "Skill storage reachable"),
        (error: unknown) =>
          log.error({ err: error }, "Skill storage health check failed; skill routes will report 503"),
      );
      sweeper.start();
    },
    stop: () => sweeper.stop(),
  };
}
