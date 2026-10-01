import { Readable } from "node:stream";
import { and, eq, isNull, ne } from "drizzle-orm";
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
import { ExternalCallPolicy, limitReadableStream } from "./external-call-policy.js";

const MAX_RESOURCE_BYTES = 25 * 1024 * 1024;
const MAX_AVATAR_BYTES = 5 * 1024 * 1024;
const ALLOWED_AVATAR_MEDIA_TYPES = new Set(["image/avif", "image/gif", "image/jpeg", "image/png", "image/webp"]);

export interface AuthorizedImResource extends ReadableResource {
  kind: "image" | "file" | "audio" | "video";
}

export interface AuthorizedAgentAvatar extends ReadableResource {
  mediaType: string;
}

export class ImResourceService {
  readonly #database: DatabaseClient;
  readonly #resolveAdapter: (imBindingId: string, generation: number) => Promise<ImProviderAdapter<unknown>>;
  readonly #policy: ExternalCallPolicy;

  constructor(
    database: DatabaseClient,
    resolveAdapter: (imBindingId: string, generation: number) => Promise<ImProviderAdapter<unknown>>,
    policy: ExternalCallPolicy = new ExternalCallPolicy({
      allowedHosts: ["slack.com", "files.slack.com", "open.feishu.cn", "open.larksuite.com"],
    }),
  ) {
    this.#database = database;
    this.#resolveAdapter = resolveAdapter;
    this.#policy = policy;
  }

  async openAvatar(callerUserId: string, agentId: string): Promise<AuthorizedAgentAvatar> {
    const [binding] = await this.#database
      .select({ providerUrl: imBindings.botAvatarUrl })
      .from(agents)
      .innerJoin(imBindings, and(eq(imBindings.agentId, agents.id), ne(imBindings.status, "disabled")))
      .where(and(eq(agents.id, agentId), eq(agents.createdByUserId, callerUserId), ne(agents.status, "deleted")))
      .limit(1);
    if (!binding?.providerUrl) {
      throw new ImBindingServiceError("IM_BINDING_NOT_FOUND", 404, "The Agent avatar was not found");
    }

    let response: Response;
    try {
      response = await this.#policy.fetch(
        binding.providerUrl,
        { headers: { accept: "image/*" } },
        { allowAnyHttpsHost: true, circuitKey: `im-avatar:${agentId}`, maxAttempts: 1, timeoutMs: 10_000 },
      );
    } catch {
      throw new ImBindingServiceError(
        "IM_BINDING_TEMPORARILY_UNAVAILABLE",
        503,
        "The Agent avatar is temporarily unavailable",
        "transient",
      );
    }

    if (!response.ok || !response.body) {
      await discardResponseBody(response);
      throw new ImBindingServiceError(
        "IM_BINDING_TEMPORARILY_UNAVAILABLE",
        503,
        "The Agent avatar is temporarily unavailable",
        "transient",
      );
    }

    const mediaType = imageMediaType(response.headers.get("content-type"));
    if (!mediaType) {
      await discardResponseBody(response);
      throw new ImBindingServiceError(
        "VALIDATION_ERROR",
        415,
        "The Agent avatar is not an allowed image",
        "validation",
      );
    }

    const sizeBytes = response.headers.get("content-length");
    const declaredSize = sizeBytes === null ? undefined : Number(sizeBytes);
    if (declaredSize !== undefined && (!Number.isSafeInteger(declaredSize) || declaredSize < 0)) {
      await discardResponseBody(response);
      throw new ImBindingServiceError("VALIDATION_ERROR", 502, "The Agent avatar response is invalid", "validation");
    }
    if (declaredSize !== undefined && declaredSize > MAX_AVATAR_BYTES) {
      await discardResponseBody(response);
      throw new ImBindingServiceError("VALIDATION_ERROR", 413, "The Agent avatar exceeds the size limit", "validation");
    }

    return {
      stream: limitReadableStream(Readable.fromWeb(response.body), MAX_AVATAR_BYTES, "IM_AVATAR_TOO_LARGE"),
      mediaType,
      ...(declaredSize === undefined ? {} : { sizeBytes: declaredSize }),
    };
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
          "transient",
        );
      },
    );
    const opened = await this.#policy.run(
      `im.resource.${scope.imBinding.provider}`,
      () =>
        adapter.fetchResource({
          messageExternalId: scope.message.externalMessageId,
          providerResourceKey: resource.providerResourceKey,
          kind: resource.kind,
        }),
      { circuitKey: `im-resource:${scope.imBinding.id}` },
    );
    if (opened.sizeBytes !== undefined && opened.sizeBytes > MAX_RESOURCE_BYTES) {
      opened.stream.destroy();
      throw new ImBindingServiceError("VALIDATION_ERROR", 413, "The IM resource exceeds the size limit");
    }
    return {
      ...opened,
      stream: limitReadableStream(opened.stream, MAX_RESOURCE_BYTES, "IM_RESOURCE_TOO_LARGE"),
      kind: resource.kind,
      filename: opened.filename ?? resource.filename ?? undefined,
      mediaType: opened.mediaType ?? resource.mediaType ?? undefined,
    };
  }
}

function imageMediaType(value: string | null): string | undefined {
  const mediaType = value?.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType && ALLOWED_AVATAR_MEDIA_TYPES.has(mediaType) ? mediaType : undefined;
}

async function discardResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Best effort: the provider response is never relayed after validation fails.
  }
}
