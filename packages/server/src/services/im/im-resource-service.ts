import { Transform } from "node:stream";
import { and, eq, isNull } from "drizzle-orm";
import type { DatabaseClient } from "../../db/client.js";
import {
  agents,
  computers,
  imConversations,
  imMessageResources,
  imMessages,
  integrationCredentials,
  integrations,
  sessionPlacements,
  sessions,
} from "../../db/schema/index.js";
import type { ImProviderAdapter, ReadableResource } from "../integrations/index.js";
import { IntegrationServiceError } from "../integrations/index.js";

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
    resourceId: string,
  ): Promise<AuthorizedImResource> {
    const [scope] = await this.#database
      .select({
        resource: imMessageResources,
        messageExternalId: imMessages.externalMessageId,
        integrationId: integrations.id,
        generation: integrationCredentials.generation,
      })
      .from(imMessageResources)
      .innerJoin(imMessages, eq(imMessages.id, imMessageResources.messageId))
      .innerJoin(imConversations, eq(imConversations.id, imMessages.conversationId))
      .innerJoin(integrations, eq(integrations.id, imConversations.integrationId))
      .innerJoin(agents, eq(agents.id, integrations.agentId))
      .innerJoin(integrationCredentials, eq(integrationCredentials.integrationId, integrations.id))
      .innerJoin(
        sessions,
        and(
          eq(sessions.id, runtime.sessionId),
          eq(sessions.conversationId, imConversations.id),
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
      .where(
        and(
          eq(imMessageResources.id, resourceId),
          isNull(imConversations.detachedAt),
          isNull(integrations.disabledAt),
          isNull(agents.deletedAt),
        ),
      )
      .limit(1);
    if (!scope) throw new IntegrationServiceError("INTEGRATION_NOT_FOUND", 404, "The IM resource was not found");
    if (scope.resource.availability === "too_large") {
      throw new IntegrationServiceError("VALIDATION_ERROR", 413, "The IM resource exceeds the size limit");
    }
    if (scope.resource.availability !== "available") {
      throw new IntegrationServiceError("INTEGRATION_NOT_FOUND", 404, "The IM resource is unavailable");
    }
    const adapter = await this.#resolveAdapter(scope.integrationId, scope.generation);
    const resource = await adapter.fetchResource({
      messageExternalId: scope.messageExternalId,
      providerResourceKey: scope.resource.providerResourceKey,
      kind: scope.resource.kind,
    });
    if (resource.sizeBytes !== undefined && resource.sizeBytes > MAX_RESOURCE_BYTES) {
      resource.stream.destroy();
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
      ...resource,
      stream: resource.stream.pipe(limiter),
      kind: scope.resource.kind,
      filename: resource.filename ?? scope.resource.filename ?? undefined,
      mediaType: resource.mediaType ?? scope.resource.mediaType ?? undefined,
    };
  }
}
