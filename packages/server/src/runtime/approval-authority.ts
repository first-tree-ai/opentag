import type { RuntimeApprovalRequest } from "@opentag/shared";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { DatabaseClient } from "../db/client.js";
import {
  agentRuntimeConfigs,
  agents,
  computers,
  imBindings,
  imMessageDeliveries,
  imMessages,
  sessionPlacements,
  sessions,
  slackInstallations,
} from "../db/schema/index.js";
import type { RuntimeBusinessContext } from "./runtime-session.js";

export async function loadApprovalAuthority(
  database: DatabaseClient,
  request: RuntimeApprovalRequest,
  context: Pick<RuntimeBusinessContext, "computerId" | "instanceId">,
) {
  const [row] = await database
    .select({
      imBindingId: imBindings.id,
      provider: imBindings.provider,
      generation: imBindings.credentialGeneration,
      installationId: slackInstallations.id,
      slackGeneration: slackInstallations.credentialGeneration,
      slackStatus: slackInstallations.status,
      channelId: imMessages.channelId,
      threadKey: imMessages.threadKey,
      externalMessageId: imMessages.externalMessageId,
      senderExternalId: imMessages.authorExternalId,
      senderKind: imMessages.authorKind,
      configRevision: agentRuntimeConfigs.revision,
      maxDurationMs: agentRuntimeConfigs.maxDurationMs,
      acceptedAt: imMessageDeliveries.acceptedAt,
    })
    .from(imMessageDeliveries)
    .innerJoin(imMessages, eq(imMessages.id, imMessageDeliveries.messageId))
    .innerJoin(sessions, eq(sessions.id, imMessageDeliveries.sessionId))
    .innerJoin(sessionPlacements, eq(sessionPlacements.sessionId, sessions.id))
    .innerJoin(imBindings, eq(imBindings.id, sessions.imBindingId))
    .innerJoin(agents, eq(agents.id, imBindings.agentId))
    .innerJoin(computers, eq(computers.id, sessionPlacements.computerId))
    .innerJoin(agentRuntimeConfigs, eq(agentRuntimeConfigs.agentId, agents.id))
    .leftJoin(slackInstallations, eq(slackInstallations.id, imBindings.slackInstallationId))
    .where(
      and(
        eq(imMessageDeliveries.id, request.deliveryId),
        eq(imMessageDeliveries.sessionId, request.sessionId),
        eq(imMessageDeliveries.turnId, request.turnId),
        eq(imMessageDeliveries.state, "accepted"),
        eq(imMessageDeliveries.reportOwnerInstanceId, context.instanceId),
        isNull(imMessageDeliveries.reportedAt),
        eq(sessionPlacements.computerId, context.computerId),
        eq(sessionPlacements.generation, request.placementGeneration),
        eq(computers.kind, "local"),
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
  if (
    !row ||
    row.senderKind !== "human" ||
    !row.senderExternalId ||
    !row.acceptedAt ||
    (row.provider === "slack" && row.slackStatus !== "active")
  )
    return undefined;
  return {
    imBindingId: row.imBindingId,
    deadlineAt: new Date(row.acceptedAt.getTime() + (row.maxDurationMs ?? 30 * 60 * 1000)),
    authority: {
      senderExternalId: row.senderExternalId,
      provider: row.provider,
      generation: row.provider === "slack" ? (row.slackGeneration ?? 0) : row.generation,
      ...(row.installationId ? { installationId: row.installationId } : {}),
      channelId: row.channelId,
      threadKey: row.threadKey,
      externalMessageId: row.externalMessageId,
      configRevision: row.configRevision,
    },
  };
}
