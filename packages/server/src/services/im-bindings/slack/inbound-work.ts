import { InboundWorkSchema, type SlackInboundWork, slackWorkEvent } from "../../im/inbound-work.js";

export interface SlackEventEnvelope {
  type?: string;
  api_app_id?: string;
  team_id?: string;
  event_id?: string;
  event_time?: number;
  challenge?: string;
  authorizations?: Array<{ team_id?: string; user_id?: string; is_bot?: boolean }>;
  event?: { type?: string; tokens?: { oauth?: string[]; bot?: string[] } } & Record<string, unknown>;
}

interface SlackIdentity {
  appId: string;
  teamId: string;
  botUserId: string;
  botId: string;
}

export function matchesSlackInstallation(installation: SlackIdentity, envelope: SlackEventEnvelope): boolean {
  return envelope.api_app_id === installation.appId && envelope.team_id === installation.teamId;
}

export function hasSlackBotAuthorization(installation: SlackIdentity, envelope: SlackEventEnvelope): boolean {
  return (
    envelope.authorizations?.some(
      (authorization) =>
        authorization.is_bot === true &&
        authorization.team_id === installation.teamId &&
        authorization.user_id === installation.botUserId,
    ) ?? false
  );
}

export function createSlackInboundWork(
  installation: SlackIdentity,
  envelope: SlackEventEnvelope,
  bindingId: string | null | undefined,
): SlackInboundWork {
  const work = InboundWorkSchema.parse({
    version: 1,
    provider: "slack",
    ...(bindingId === undefined ? {} : { bindingId }),
    appId: installation.appId,
    teamId: installation.teamId,
    botUserId: installation.botUserId,
    botId: installation.botId,
    eventId: envelope.event_id,
    ...(typeof envelope.event_time === "number" && Number.isFinite(envelope.event_time)
      ? { eventTime: envelope.event_time }
      : {}),
    identityClosed: hasSlackBotAuthorization(installation, envelope),
    revokesBot:
      envelope.event?.type === "tokens_revoked" &&
      (envelope.event.tokens?.bot?.includes(installation.botUserId) ?? false),
    event: slackWorkEvent(envelope.event),
  });
  if (work.provider !== "slack") throw new Error("SLACK_INBOUND_WORK_PROVIDER_MISMATCH");
  return work;
}

export function recoveredSlackEnvelope(work: SlackInboundWork): SlackEventEnvelope {
  return {
    type: "event_callback",
    api_app_id: work.appId,
    team_id: work.teamId,
    event_id: work.eventId,
    ...(work.eventTime === undefined ? {} : { event_time: work.eventTime }),
    authorizations: work.identityClosed ? [{ is_bot: true, team_id: work.teamId, user_id: work.botUserId }] : [],
    event: work.revokesBot
      ? { type: "tokens_revoked", tokens: { bot: [work.botUserId] } }
      : (work.event as SlackEventEnvelope["event"]),
  };
}
