import { Transform } from "node:stream";
import { and, eq, isNull } from "drizzle-orm";
import type { DatabaseClient } from "../../db/client.js";
import {
  agents,
  computers,
  imMessageDeliveries,
  imMessages,
  integrations,
  sessionPlacements,
  sessions,
} from "../../db/schema/index.js";
import type { ImProviderAdapter, ReadableResource } from "../integrations/index.js";
import { IntegrationServiceError } from "../integrations/index.js";
import { ProviderAdapterResolutionError } from "../integrations/provider-adapter-resolver.js";

const MAX_RESOURCE_BYTES = 25 * 1024 * 1024;

export interface AuthorizedImResource extends ReadableResource {
  kind: "image" | "file" | "audio" | "video";
}

export class ImResourceService {
  readonly #database: DatabaseClient;
  readonly #resolveAdapter: (integrationId: string, generation: number) => Promise<ImProviderAdapter<unknown>>;

  constructor(
    database: DatabaseClient,
    resolveAdapter: (integrationId: string, generation: number) => Promise<ImProviderAdapter<unknown>>,
  ) {
    this.#database = database;
    this.#resolveAdapter = resolveAdapter;
  }

  async open(
    userId: string,
    runtime: { sessionId: string; computerId: string; instanceId: string; placementGeneration: number },
    imMessageId: string,
    ordinal: number,
  ): Promise<AuthorizedImResource> {
    const [scope] = await this.#database
      .select({ message: imMessages, integration: integrations })
      .from(imMessages)
      .innerJoin(integrations, eq(integrations.id, imMessages.integrationId))
      .innerJoin(agents, eq(agents.id, integrations.agentId))
      .innerJoin(imMessageDeliveries, eq(imMessageDeliveries.messageId, imMessages.id))
      .innerJoin(
        sessions,
        and(
          eq(sessions.id, runtime.sessionId),
          eq(sessions.id, imMessageDeliveries.sessionId),
          eq(sessions.integrationId, imMessages.integrationId),
          eq(sessions.channelId, imMessages.channelId),
          isNull(sessions.endedAt),
        ),
      )
      .innerJoin(
        sessionPlacements,
        and(
          eq(sessionPlacements.sessionId, sessions.id),
          eq(sessionPlacements.computerId, runtime.computerId),
          eq(sessionPlacements.generation, runtime.placementGeneration),
        ),
      )
      .innerJoin(
        computers,
        and(
          eq(computers.id, sessionPlacements.computerId),
          eq(computers.ownerUserId, userId),
          eq(computers.currentInstanceId, runtime.instanceId),
        ),
      )
      .where(and(eq(imMessages.id, imMessageId), eq(integrations.status, "active"), isNull(agents.deletedAt)))
      .limit(1);
    if (!scope) throw new IntegrationServiceError("INTEGRATION_NOT_FOUND", 404, "The IM resource was not found");
    const resource = scope.message.content.resources?.find(
      (candidate, index) => (candidate.ordinal ?? index) === ordinal,
    );
    if (!resource) throw new IntegrationServiceError("INTEGRATION_NOT_FOUND", 404, "The IM resource was not found");
    const availability = resource.availability ?? "available";
    if (availability === "too_large") {
      throw new IntegrationServiceError("VALIDATION_ERROR", 413, "The IM resource exceeds the size limit");
    }
    if (availability !== "available") {
      throw new IntegrationServiceError("INTEGRATION_NOT_FOUND", 404, "The IM resource is unavailable");
    }
    const adapter = await this.#resolveAdapter(scope.integration.id, scope.integration.credentialGeneration).catch(
      (error: unknown) => {
        if (error instanceof ProviderAdapterResolutionError && error.code === "INTEGRATION_GENERATION_STALE") {
          throw new IntegrationServiceError("INTEGRATION_GENERATION_STALE", 409, "The IM Integration changed");
        }
        throw new IntegrationServiceError(
          "INTEGRATION_TEMPORARILY_UNAVAILABLE",
          503,
          "The IM Integration is temporarily unavailable",
        );
      },
    );
    const opened = await adapter.fetchResource({
      messageExternalId: scope.message.externalMessageId,
      providerResourceKey: resource.providerResourceKey,
      kind: resource.kind,
    });
    if (opened.sizeBytes !== undefined && opened.sizeBytes > MAX_RESOURCE_BYTES) {
      opened.stream.destroy();
      throw new IntegrationServiceError("VALIDATION_ERROR", 413, "The IM resource exceeds the size limit");
    }
    let observed = 0;
    const limiter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        observed += chunk.byteLength;
        callback(observed <= MAX_RESOURCE_BYTES ? null : new Error("IM_RESOURCE_TOO_LARGE"), chunk);
      },
    });
    return {
      ...opened,
      stream: opened.stream.pipe(limiter),
      kind: resource.kind,
      filename: opened.filename ?? resource.filename ?? undefined,
      mediaType: opened.mediaType ?? resource.mediaType ?? undefined,
    };
  }
}
