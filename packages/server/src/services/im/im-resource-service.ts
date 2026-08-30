import { Transform } from "node:stream";
import { and, eq, isNull } from "drizzle-orm";
import type { DatabaseClient } from "../../db/client.js";
import {
  agents,
  computers,
  imBindings,
  imMessageDeliveries,
  imMessages,
  sessionPlacements,
  sessions,
} from "../../db/schema/index.js";
import type { ComputerAuthContext } from "../computers/index.js";
import type { ImProviderAdapter, ReadableResource } from "../im-bindings/index.js";
import { ImBindingServiceError } from "../im-bindings/index.js";
import { ProviderAdapterResolutionError } from "../im-bindings/provider-adapter-resolver.js";

const MAX_RESOURCE_BYTES = 25 * 1024 * 1024;

export interface AuthorizedImResource extends ReadableResource {
  kind: "image" | "file" | "audio" | "video";
}

export class ImResourceService {
  readonly #database: DatabaseClient;
  readonly #resolveAdapter: (imBindingId: string, generation: number) => Promise<ImProviderAdapter<unknown>>;

  constructor(
    database: DatabaseClient,
    resolveAdapter: (imBindingId: string, generation: number) => Promise<ImProviderAdapter<unknown>>,
  ) {
    this.#database = database;
    this.#resolveAdapter = resolveAdapter;
  }

  async open(
    computerAuth: ComputerAuthContext,
    runtime: { sessionId: string; instanceId: string; placementGeneration: number },
    imMessageId: string,
    ordinal: number,
  ): Promise<AuthorizedImResource> {
    const scope = await this.#database.transaction(async (transaction) => {
      const [candidate] = await transaction
        .select({ agentId: agents.id })
        .from(imMessages)
        .innerJoin(imBindings, eq(imBindings.id, imMessages.imBindingId))
        .innerJoin(agents, eq(agents.id, imBindings.agentId))
        .where(eq(imMessages.id, imMessageId))
        .limit(1);
      if (!candidate) return undefined;
      const [agent] = await transaction
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.id, candidate.agentId), eq(agents.status, "active")))
        .limit(1)
        .for("update");
      if (!agent) return undefined;
      const [authorized] = await transaction
        .select({ message: imMessages, imBinding: imBindings })
        .from(imMessages)
        .innerJoin(imBindings, eq(imBindings.id, imMessages.imBindingId))
        .innerJoin(agents, eq(agents.id, imBindings.agentId))
        .innerJoin(imMessageDeliveries, eq(imMessageDeliveries.messageId, imMessages.id))
        .innerJoin(
          sessions,
          and(
            eq(sessions.id, runtime.sessionId),
            eq(sessions.id, imMessageDeliveries.sessionId),
            eq(sessions.imBindingId, imMessages.imBindingId),
            eq(sessions.channelId, imMessages.channelId),
            isNull(sessions.endedAt),
          ),
        )
        .innerJoin(
          sessionPlacements,
          and(
            eq(sessionPlacements.sessionId, sessions.id),
            eq(sessionPlacements.computerId, computerAuth.computerId),
            eq(sessionPlacements.generation, runtime.placementGeneration),
          ),
        )
        .innerJoin(
          computers,
          and(
            eq(computers.id, computerAuth.computerId),
            eq(computers.id, sessionPlacements.computerId),
            eq(computers.currentInstanceId, runtime.instanceId),
          ),
        )
        .where(and(eq(imMessages.id, imMessageId), eq(imBindings.status, "active"), eq(agents.status, "active")))
        .limit(1);
      return authorized;
    });
    if (!scope) throw new ImBindingServiceError("IM_BINDING_NOT_FOUND", 404, "The IM resource was not found");
    const resource = scope.message.content.resources?.find(
      (candidate, index) => (candidate.ordinal ?? index) === ordinal,
    );
    if (!resource) throw new ImBindingServiceError("IM_BINDING_NOT_FOUND", 404, "The IM resource was not found");
    const availability = resource.availability ?? "available";
    if (availability === "too_large") {
      throw new ImBindingServiceError("VALIDATION_ERROR", 413, "The IM resource exceeds the size limit");
    }
    if (availability !== "available") {
      throw new ImBindingServiceError("IM_BINDING_NOT_FOUND", 404, "The IM resource is unavailable");
    }
    const adapter = await this.#resolveAdapter(scope.imBinding.id, scope.imBinding.credentialGeneration).catch(
      (error: unknown) => {
        if (error instanceof ProviderAdapterResolutionError && error.code === "IM_BINDING_GENERATION_STALE") {
          throw new ImBindingServiceError("IM_BINDING_GENERATION_STALE", 409, "The IM binding changed");
        }
        throw new ImBindingServiceError(
          "IM_BINDING_TEMPORARILY_UNAVAILABLE",
          503,
          "The IM binding is temporarily unavailable",
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
      throw new ImBindingServiceError("VALIDATION_ERROR", 413, "The IM resource exceeds the size limit");
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
