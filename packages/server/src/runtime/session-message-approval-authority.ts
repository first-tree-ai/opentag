import type { RuntimeApprovalRequest } from "@opentag/shared";
import { and, desc, eq, inArray, isNull, lte } from "drizzle-orm";
import { z } from "zod";
import type { DatabaseClient } from "../db/client.js";
import {
  agentRuntimeConfigs,
  agents,
  computers,
  imBindings,
  imMessageDeliveries,
  imMessages,
  sessionMessages,
  sessionPlacements,
  sessions,
  slackInstallations,
} from "../db/schema/index.js";
import type { RuntimeBusinessContext } from "./runtime-session.js";

/** The longest a Session message Run can last; the Client's own expiry is far shorter. */
const SESSION_MESSAGE_APPROVAL_DEADLINE_MS = 24 * 60 * 60 * 1000;
/** How far up the creation chain the visible Session is looked for. */
const MAX_CHAIN_DEPTH = 32;
const uuid = z.string().uuid();

/**
 * The authority of an approval asked for by a Session message's own Run. The Run must be the live one of that
 * message, on this connection's Computer and placement. The card goes to the top visible Session above the target,
 * reached through `created_by_session_id`, and the approver is the human whose message that visible Session had last
 * received when the Session message was created. Fixing that moment keeps the authority stable while the request is
 * open: a newer message in the conversation does not change who may decide.
 */
export async function loadSessionMessageApprovalAuthority(
  database: DatabaseClient,
  request: RuntimeApprovalRequest,
  context: Pick<RuntimeBusinessContext, "computerId" | "instanceId" | "connectionId">,
) {
  if (
    !context.connectionId ||
    !uuid.safeParse(request.deliveryId).success ||
    !uuid.safeParse(request.sessionId).success
  )
    return undefined;
  if (request.turnId !== `session-message-${request.deliveryId}`) return undefined;
  const [target] = await database
    .select({
      createdAt: sessionMessages.createdAt,
      kind: sessions.kind,
      creatorSessionId: sessions.createdBySessionId,
      imBindingId: imBindings.id,
      provider: imBindings.provider,
      generation: imBindings.credentialGeneration,
      installationId: slackInstallations.id,
      slackGeneration: slackInstallations.credentialGeneration,
      slackStatus: slackInstallations.status,
      configRevision: agentRuntimeConfigs.revision,
    })
    .from(sessionMessages)
    .innerJoin(sessions, eq(sessions.id, sessionMessages.targetSessionId))
    .innerJoin(sessionPlacements, eq(sessionPlacements.sessionId, sessions.id))
    .innerJoin(imBindings, eq(imBindings.id, sessions.imBindingId))
    .innerJoin(agents, eq(agents.id, imBindings.agentId))
    .innerJoin(computers, eq(computers.id, sessionPlacements.computerId))
    .innerJoin(agentRuntimeConfigs, eq(agentRuntimeConfigs.agentId, agents.id))
    .leftJoin(slackInstallations, eq(slackInstallations.id, imBindings.slackInstallationId))
    .where(
      and(
        eq(sessionMessages.id, request.deliveryId),
        eq(sessionMessages.targetSessionId, request.sessionId),
        eq(sessionMessages.lastOutcome, "accepted"),
        eq(sessionPlacements.computerId, context.computerId),
        eq(sessionPlacements.generation, request.placementGeneration),
        eq(computers.kind, "local"),
        eq(computers.currentInstanceId, context.instanceId),
        eq(computers.currentConnectionId, context.connectionId),
        isNull(computers.deletedAt),
        isNull(computers.disconnectedAt),
        eq(agents.status, "active"),
        inArray(agents.runtimeProvider, ["codex", "claude-code"]),
        eq(agents.computerId, context.computerId),
        eq(imBindings.status, "active"),
        isNull(sessions.endedAt),
      ),
    )
    .limit(1);
  if (!target || (target.provider === "slack" && target.slackStatus !== "active")) return undefined;
  const visibleSessionId = await topVisibleSession(database, request.sessionId, target);
  if (!visibleSessionId) return undefined;
  const [approver] = await database
    .select({
      channelId: imMessages.channelId,
      threadKey: imMessages.threadKey,
      externalMessageId: imMessages.externalMessageId,
      senderExternalId: imMessages.authorExternalId,
    })
    .from(imMessageDeliveries)
    .innerJoin(imMessages, eq(imMessages.id, imMessageDeliveries.messageId))
    .where(
      and(
        eq(imMessageDeliveries.sessionId, visibleSessionId),
        eq(imMessages.authorKind, "human"),
        lte(imMessages.receivedAt, target.createdAt),
      ),
    )
    .orderBy(desc(imMessages.receivedAt), desc(imMessages.id))
    .limit(1);
  if (!approver?.senderExternalId) return undefined;
  return {
    imBindingId: target.imBindingId,
    deadlineAt: new Date(target.createdAt.getTime() + SESSION_MESSAGE_APPROVAL_DEADLINE_MS),
    visibleSessionId,
    authority: {
      senderExternalId: approver.senderExternalId,
      provider: target.provider,
      generation: target.provider === "slack" ? (target.slackGeneration ?? 0) : target.generation,
      ...(target.installationId ? { installationId: target.installationId } : {}),
      channelId: approver.channelId,
      threadKey: approver.threadKey,
      externalMessageId: approver.externalMessageId,
      configRevision: target.configRevision,
    },
  };
}

/** The target itself when it is visible, else the nearest visible, active Session up its creation chain. */
async function topVisibleSession(
  database: DatabaseClient,
  sessionId: string,
  target: { kind: string; creatorSessionId: string | null },
): Promise<string | undefined> {
  if (target.kind !== "internal") return sessionId;
  let current = target.creatorSessionId;
  for (let depth = 0; current && depth < MAX_CHAIN_DEPTH; depth += 1) {
    const [row] = await database
      .select({ kind: sessions.kind, creatorSessionId: sessions.createdBySessionId, endedAt: sessions.endedAt })
      .from(sessions)
      .where(eq(sessions.id, current))
      .limit(1);
    if (!row || row.endedAt) return undefined;
    if (row.kind !== "internal") return current;
    current = row.creatorSessionId;
  }
  return undefined;
}
