import {
  type DirectImMessageDeliveryRequest,
  DirectImMessageDeliveryRequestSchema,
  RUNTIME_DIRECT_TEXT_MAX_BYTES,
  type RuntimeImDeliveryContent,
  RuntimeImDeliveryContentSchema,
  type RuntimeImSteerRequest,
  RuntimeImSteerRequestSchema,
  renderImContentText,
  truncateImText,
} from "@opentag/shared";
import { and, eq, isNull } from "drizzle-orm";
import type { DatabaseClient } from "../db/client.js";
import { type imBindings, imMessageDeliveries, type imMessages } from "../db/schema/index.js";
import { runtimeProviderMessageRef } from "./runtime-provider-message-ref.js";

/** Contains only bounded codes/paths, never Zod messages, provider content, or credentials. */
export class ImDeliveryInputError extends Error {
  constructor(
    readonly code: "IM_DELIVERY_CONTENT_INVALID" | "IM_DELIVERY_REQUEST_INVALID",
    readonly reason: string,
    readonly paths: string[] = [],
  ) {
    super(code);
  }
}

export function deliveryMessageText(
  message: Pick<typeof imMessages.$inferSelect, "operation" | "content">,
  provider: "slack" | "feishu",
): string {
  return renderImContentText({
    content: message.content,
    provider,
    maxBytes: RUNTIME_DIRECT_TEXT_MAX_BYTES,
    deleted: message.operation === "deleted",
  });
}

export function deliveryMessageContent(
  message: typeof imMessages.$inferSelect,
  binding: typeof imBindings.$inferSelect,
): RuntimeImDeliveryContent {
  const text = deliveryMessageText(message, binding.provider);
  if (!text) throw new ImDeliveryInputError("IM_DELIVERY_CONTENT_INVALID", "content_unrecoverable", ["content.text"]);
  const resources = (message.content.resources ?? []).slice(0, 16).map((resource, index) => ({
    imMessageId: message.id,
    ordinal: resource.ordinal ?? index,
    kind: resource.kind,
    ...(resource.filename ? { filename: truncateImText(resource.filename, 512) } : {}),
    ...(resource.mediaType ? { mediaType: truncateImText(resource.mediaType, 255) } : {}),
    ...(resource.sizeBytes != null ? { sizeBytes: resource.sizeBytes } : {}),
    availability: resource.availability ?? "available",
  }));
  const parsed = RuntimeImDeliveryContentSchema.safeParse({
    kind: "text",
    text,
    providerRef: runtimeProviderMessageRef(message, binding),
    ...(resources.length ? { resources } : {}),
  });
  if (!parsed.success) {
    throw new ImDeliveryInputError(
      "IM_DELIVERY_CONTENT_INVALID",
      "invalid_content",
      parsed.error.issues.map((v) => v.path.join(".")).slice(0, 16),
    );
  }
  return parsed.data;
}

/** Validate only a fresh request. Persisted dispatches retain their original payload and hash. */
export function validateFreshImRequest(request: DirectImMessageDeliveryRequest | RuntimeImSteerRequest): void {
  const parsed =
    request.type === "im:deliver"
      ? DirectImMessageDeliveryRequestSchema.safeParse(request)
      : RuntimeImSteerRequestSchema.safeParse(request);
  if (parsed.success) return;
  // Runtime configuration can change without editing the message: keep its existing retry policy.
  if (parsed.error.issues.some((issue) => issue.path[0] === "runtime")) throw parsed.error;
  throw new ImDeliveryInputError(
    "IM_DELIVERY_REQUEST_INVALID",
    "invalid_request",
    parsed.error.issues.map((v) => v.path.join(".")).slice(0, 16),
  );
}

export function validateUndispatchedContent(row: {
  delivery: Pick<typeof imMessageDeliveries.$inferSelect, "dispatchRequestId">;
  message: typeof imMessages.$inferSelect;
  imBinding: typeof imBindings.$inferSelect;
}): void {
  if (row.delivery.dispatchRequestId === null) deliveryMessageContent(row.message, row.imBinding);
}

export async function rejectInvalidImDelivery(
  database: DatabaseClient,
  deliveryId: string,
  error: ImDeliveryInputError,
  claimToken: string,
): Promise<boolean> {
  const [rejected] = await database
    .update(imMessageDeliveries)
    .set({
      state: "terminal_rejected",
      reason: error.reason,
      lastErrorCode: error.code,
    })
    .where(
      and(
        eq(imMessageDeliveries.id, deliveryId),
        eq(imMessageDeliveries.state, "pending"),
        isNull(imMessageDeliveries.dispatchRequestId),
        eq(imMessageDeliveries.lastErrorCode, claimToken),
      ),
    )
    .returning({ id: imMessageDeliveries.id });
  return rejected !== undefined;
}
