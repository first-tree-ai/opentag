import {
  type DirectImMessageDeliveryRequest,
  type ProviderInboundContext,
  RUNTIME_IM_HISTORY_MAX_BYTES,
  RUNTIME_MAX_FRAME_BYTES,
  type RuntimeImSteerRequest,
  type RuntimeProviderMessageRef,
  runtimeFrameByteLength,
  truncateImText,
} from "@opentag/shared";
import { and, desc, eq, gt, inArray, lt, ne, notExists, or } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { alias } from "drizzle-orm/pg-core";
import type { DatabaseClient, DatabaseTransaction } from "../db/client.js";
import { imBindings, imMessageDeliveries, imMessages, type sessions } from "../db/schema/index.js";
import { threadRootExternalId } from "../services/im/provider-thread-context.js";
import { deliveryMessageText, ImDeliveryInputError } from "./im-delivery-content.js";
import { DeliveryCustodySnapshot, loadDeliveryContexts, readDeliveryCustody } from "./im-delivery-work-query.js";
import { runtimeProviderMessageRef } from "./runtime-provider-message-ref.js";

/**
 * Shared IM delivery custody/query helpers. Kept out of the worker module so the claim and
 * delivery paths share one definition of "another delivery already owns this Agent" and one
 * frame-fitting rule, without growing the worker further.
 */

export type CustodyQuery = Pick<DatabaseClient | DatabaseTransaction, "select" | "execute">;

export interface ClaimLease {
  assertOwned(): Promise<boolean>;
  stop(): Promise<void>;
}

/**
 * The concurrency scope of one delivery. A Local Computer executes one Turn at a time for its
 * Agent, so a Local delivery occupies the whole Agent. A Cloud Computer is only the Account's
 * logical identity: every Agent Session owns its own Sandbox Runner, so a Cloud delivery occupies
 * just its Session. This is the E6 contract: different Cloud Sessions of one Agent execute
 * concurrently, the same Cloud Session keeps exactly one custody owner and stays ordered, and a
 * live Local occupancy still fences every Session of its Agent.
 */
export type DeliveryOccupancyScope =
  | { kind: "agent"; agentId: string }
  | { kind: "session"; agentId: string; sessionId: string };

/** The identity a delivery needs to resolve its occupancy scope and scheduler lane. */
export interface DeliveryOccupancySubject {
  deliveryId: string;
  agentId: string;
  sessionId: string;
  computerKind: "local" | "cloud";
}

export function deliveryOccupancyScope(subject: {
  computerKind: "local" | "cloud";
  agentId: string;
  sessionId: string;
}): DeliveryOccupancyScope {
  return subject.computerKind === "cloud"
    ? { kind: "session", agentId: subject.agentId, sessionId: subject.sessionId }
    : { kind: "agent", agentId: subject.agentId };
}

export function occupancyScopeKey(scope: DeliveryOccupancyScope): string {
  return scope.kind === "agent" ? `agent:${scope.agentId}` : `session:${scope.sessionId}`;
}

export async function hasOtherCustody(database: CustodyQuery, subject: DeliveryOccupancySubject): Promise<boolean> {
  return (await findOtherCustody(database, subject)) !== undefined;
}

/**
 * The occupancy owner of another delivery, if any, computed from committed custody. Used as the
 * last-boundary recheck before any frame reaches a runtime; `skip locked` claims that another
 * Worker has only claimed (not committed) leave no durable trace, which is why the claim itself
 * rechecks the same snapshot rule under the Agent-scoped advisory lock.
 */
export async function findOtherCustody(database: CustodyQuery, subject: DeliveryOccupancySubject) {
  const rows = await readDeliveryCustody(database);
  const contexts = await loadDeliveryContexts(
    database,
    rows.map((row) => row.sessionId),
  );
  return new DeliveryCustodySnapshot(rows, contexts).other(subject);
}

/** The columns that define ingress order within one Session. */
export interface MessageOrderColumns {
  occurredAt: AnyPgColumn;
  providerRevisionKey: AnyPgColumn;
  id: AnyPgColumn;
}

export interface MessageOrderBoundary {
  occurredAt: Date | AnyPgColumn;
  providerRevisionKey: string | AnyPgColumn;
  id: string | AnyPgColumn;
}

/** Ingress order within one Session: occurredAt, then provider revision, then message id. */
export function messageOrderBefore(earlier: MessageOrderColumns, boundary: MessageOrderBoundary) {
  return or(
    lt(earlier.occurredAt, boundary.occurredAt),
    and(
      eq(earlier.occurredAt, boundary.occurredAt),
      or(
        lt(earlier.providerRevisionKey, boundary.providerRevisionKey),
        and(eq(earlier.providerRevisionKey, boundary.providerRevisionKey), lt(earlier.id, boundary.id)),
      ),
    ),
  );
}

export function messageBefore(occurredAt: Date, providerRevisionKey: string, messageId: string) {
  return messageOrderBefore(
    { occurredAt: imMessages.occurredAt, providerRevisionKey: imMessages.providerRevisionKey, id: imMessages.id },
    { occurredAt, providerRevisionKey, id: messageId },
  );
}

export function messageAfter(occurredAt: Date, providerRevisionKey: string, messageId: string) {
  return or(
    gt(imMessages.occurredAt, occurredAt),
    and(
      eq(imMessages.occurredAt, occurredAt),
      or(
        gt(imMessages.providerRevisionKey, providerRevisionKey),
        and(eq(imMessages.providerRevisionKey, providerRevisionKey), gt(imMessages.id, messageId)),
      ),
    ),
  );
}

export function truncateUtf8(value: string, maxBytes: number): string {
  return truncateImText(value, maxBytes);
}

export function fitDeliveryFrame(request: DirectImMessageDeliveryRequest | RuntimeImSteerRequest): void {
  const fits = () => runtimeFrameByteLength(JSON.stringify(request)) <= RUNTIME_MAX_FRAME_BYTES;
  while (!fits() && request.content.history && request.content.history.length > 0) {
    request.content.history.shift();
    request.content.historyTruncated = true;
  }
  while (!fits() && request.content.resources && request.content.resources.length > 0) {
    request.content.resources.pop();
  }
  if (!fits()) {
    // Runtime configuration is mutable; only an independently oversized message can be terminal.
    const messageFrame = request.type === "im:deliver" ? { ...request, runtime: undefined } : request;
    if (runtimeFrameByteLength(JSON.stringify(messageFrame)) > RUNTIME_MAX_FRAME_BYTES) {
      throw new ImDeliveryInputError("IM_DELIVERY_REQUEST_INVALID", "frame_too_large", ["content"]);
    }
    throw new Error("IM_DELIVERY_FRAME_TOO_LARGE");
  }
}

const newerHistoryRevisions = alias(imMessages, "newer_history_revisions");

type DirectHistoryRow = Pick<
  typeof imMessages.$inferSelect,
  | "id"
  | "operation"
  | "occurredAt"
  | "content"
  | "channelId"
  | "externalMessageId"
  | "authorKind"
  | "authorExternalId"
  | "providerContext"
> & { imBinding: typeof imBindings.$inferSelect };

interface DirectHistory {
  items: Array<{
    imMessageId: string;
    occurredAt: string;
    text: string;
    providerRef: RuntimeProviderMessageRef;
  }>;
  truncated: boolean;
}

interface DirectHistoryInput {
  session: typeof sessions.$inferSelect;
  providerContext: ProviderInboundContext;
  externalMessageId: string;
  occurredAt: Date;
  providerRevisionKey: string;
  messageId: string;
}

export async function loadDirectHistory(database: DatabaseClient, input: DirectHistoryInput): Promise<DirectHistory> {
  const { session, providerContext, externalMessageId } = input;
  const rootExternalId = threadRootExternalId(providerContext);
  const lastAccepted = await loadLastAcceptedBoundary(database, input);
  const historyBoundary = buildHistoryBoundary(database, input, lastAccepted);
  const { root, rows } = await queryHistoryWindow(database, {
    session,
    externalMessageId,
    rootExternalId,
    historyBoundary,
  });
  const selected = rows.slice(0, root ? 99 : 100);
  return collectHistoryItems(selected, root, rows.length > selected.length);
}

async function loadLastAcceptedBoundary(database: DatabaseClient, input: DirectHistoryInput) {
  const [lastAccepted] = await database
    .select({
      id: imMessages.id,
      occurredAt: imMessages.occurredAt,
      providerRevisionKey: imMessages.providerRevisionKey,
    })
    .from(imMessageDeliveries)
    .innerJoin(imMessages, eq(imMessages.id, imMessageDeliveries.messageId))
    .where(
      and(
        eq(imMessageDeliveries.sessionId, input.session.id),
        inArray(imMessageDeliveries.state, ["accepted", "steered"]),
        messageBefore(input.occurredAt, input.providerRevisionKey, input.messageId),
      ),
    )
    .orderBy(desc(imMessages.occurredAt), desc(imMessages.providerRevisionKey), desc(imMessages.id))
    .limit(1);
  return lastAccepted;
}

function buildHistoryBoundary(
  database: DatabaseClient,
  input: DirectHistoryInput,
  lastAccepted: { id: string; occurredAt: Date; providerRevisionKey: string } | undefined,
) {
  const { occurredAt, providerRevisionKey, messageId } = input;
  return and(
    messageBefore(occurredAt, providerRevisionKey, messageId),
    ...(lastAccepted ? [messageAfter(lastAccepted.occurredAt, lastAccepted.providerRevisionKey, lastAccepted.id)] : []),
    notExists(
      database
        .select({ id: newerHistoryRevisions.id })
        .from(newerHistoryRevisions)
        .where(
          and(
            eq(newerHistoryRevisions.imBindingId, imMessages.imBindingId),
            eq(newerHistoryRevisions.channelId, imMessages.channelId),
            eq(newerHistoryRevisions.externalMessageId, imMessages.externalMessageId),
            eq(newerHistoryRevisions.direction, "inbound"),
            or(
              gt(newerHistoryRevisions.occurredAt, imMessages.occurredAt),
              and(
                eq(newerHistoryRevisions.occurredAt, imMessages.occurredAt),
                or(
                  gt(newerHistoryRevisions.providerRevisionKey, imMessages.providerRevisionKey),
                  and(
                    eq(newerHistoryRevisions.providerRevisionKey, imMessages.providerRevisionKey),
                    gt(newerHistoryRevisions.id, imMessages.id),
                  ),
                ),
              ),
            ),
            or(
              lt(newerHistoryRevisions.occurredAt, occurredAt),
              and(
                eq(newerHistoryRevisions.occurredAt, occurredAt),
                or(
                  lt(newerHistoryRevisions.providerRevisionKey, providerRevisionKey),
                  and(
                    eq(newerHistoryRevisions.providerRevisionKey, providerRevisionKey),
                    lt(newerHistoryRevisions.id, messageId),
                  ),
                ),
              ),
            ),
          ),
        ),
    ),
  );
}

const HISTORY_SELECTION = {
  id: imMessages.id,
  operation: imMessages.operation,
  occurredAt: imMessages.occurredAt,
  content: imMessages.content,
  channelId: imMessages.channelId,
  externalMessageId: imMessages.externalMessageId,
  authorKind: imMessages.authorKind,
  authorExternalId: imMessages.authorExternalId,
  providerContext: imMessages.providerContext,
  imBinding: imBindings,
};

async function queryHistoryWindow(
  database: DatabaseClient,
  input: {
    session: typeof sessions.$inferSelect;
    externalMessageId: string;
    rootExternalId: string | null;
    historyBoundary: ReturnType<typeof buildHistoryBoundary>;
  },
): Promise<{ root: DirectHistoryRow | undefined; rows: DirectHistoryRow[] }> {
  const { session, externalMessageId, rootExternalId, historyBoundary } = input;
  const [root] =
    session.kind === "thread" && rootExternalId
      ? await database
          .select(HISTORY_SELECTION)
          .from(imMessages)
          .innerJoin(imBindings, eq(imBindings.id, imMessages.imBindingId))
          .where(
            and(
              eq(imMessages.imBindingId, session.imBindingId),
              eq(imMessages.channelId, session.channelId),
              eq(imMessages.direction, "inbound"),
              eq(imMessages.externalMessageId, rootExternalId),
              ne(imMessages.externalMessageId, externalMessageId),
              historyBoundary,
            ),
          )
          .orderBy(desc(imMessages.occurredAt), desc(imMessages.providerRevisionKey), desc(imMessages.id))
          .limit(1)
      : [];
  const rows = await database
    .select({ ...HISTORY_SELECTION })
    .from(imMessages)
    .innerJoin(imBindings, eq(imBindings.id, imMessages.imBindingId))
    .where(
      and(
        eq(imMessages.imBindingId, session.imBindingId),
        eq(imMessages.channelId, session.channelId),
        eq(imMessages.direction, "inbound"),
        ne(imMessages.externalMessageId, externalMessageId),
        ...(session.kind === "thread" && session.threadKey ? [eq(imMessages.threadKey, session.threadKey)] : []),
        historyBoundary,
      ),
    )
    .orderBy(desc(imMessages.occurredAt), desc(imMessages.providerRevisionKey), desc(imMessages.id))
    .limit(101);
  return { root, rows };
}

function collectHistoryItems(
  selected: DirectHistoryRow[],
  root: DirectHistoryRow | undefined,
  truncatedBySize: boolean,
) {
  const items: DirectHistory["items"] = [];
  let bytes = 2;
  let truncated = truncatedBySize;
  const rootItem = root ? historyItem(root) : undefined;
  if (rootItem) bytes += Buffer.byteLength(JSON.stringify(rootItem), "utf8");
  for (const row of selected) {
    const item = historyItem(row);
    const itemBytes = Buffer.byteLength(JSON.stringify(item), "utf8") + (items.length > 0 || rootItem ? 1 : 0);
    if (bytes + itemBytes > RUNTIME_IM_HISTORY_MAX_BYTES) {
      truncated = true;
      break;
    }
    items.push(item);
    bytes += itemBytes;
  }
  return { items: [...(rootItem ? [rootItem] : []), ...items.reverse()], truncated };
}

function historyItem(row: DirectHistoryRow): DirectHistory["items"][number] {
  return {
    imMessageId: row.id,
    occurredAt: row.occurredAt.toISOString(),
    text:
      deliveryMessageText(row, row.imBinding.provider) || "[Historical content unavailable; read the source message]",
    providerRef: runtimeProviderMessageRef(row, row.imBinding),
  };
}
