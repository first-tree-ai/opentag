import { AGENT_SLACK_EVENTS_TEMPLATE, SLACK_EVENTS_PATH } from "@opentag/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  parseSlackRetryHeaders,
  type SlackInboundFailureCode,
  type SlackInboundTrace,
  type SlackRetryMetadata,
  slackInboundAttrs,
  traceSlackInbound,
} from "../observability/index.js";
import { classifyImInboundPersistenceError, type ImMessageInbox } from "../services/im/index.js";
import type { ImBindingService, SlackIngressBinding } from "../services/im-bindings/index.js";
import type { SlackAdapter } from "../services/im-bindings/slack/adapter.js";
import type { SlackSetupService } from "../services/im-bindings/slack/setup-service.js";
import { preparseSlackRoute, verifySlackSignature } from "../services/im-bindings/slack/signature.js";

interface SlackEnvelopeBase {
  type?: string;
  api_app_id?: string;
  team_id?: string;
  event_id?: string;
  event_time?: number;
  challenge?: string;
  minute_rate_limited?: number;
  event?: { type?: string; tokens?: { oauth?: string[]; bot?: string[] } } & Record<string, unknown>;
}

class SlackEventProcessingError extends Error {
  readonly code = "SLACK_EVENT_PROCESSING_FAILED";

  constructor() {
    super("SLACK_EVENT_PROCESSING_FAILED");
    this.name = "SlackEventProcessingError";
  }
}

export interface SlackEventsRouteOptions {
  imBindings: ImBindingService;
  inbox: ImMessageInbox;
  createAdapter(binding: SlackIngressBinding): SlackAdapter;
  setup?: SlackSetupService;
  now?: () => Date;
}

type SlackRequest = FastifyRequest<{ Params: { agentId?: unknown } }>;

interface SlackRequestContext {
  request: SlackRequest;
  reply: FastifyReply;
  inbound: SlackInboundTrace;
  retry: SlackRetryMetadata | undefined;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function signatureHeaders(request: SlackRequest) {
  return {
    timestamp: headerValue(request.headers["x-slack-request-timestamp"]),
    signature: headerValue(request.headers["x-slack-signature"]),
  };
}

function parseEnvelope(rawBody: Buffer): SlackEnvelopeBase | undefined {
  try {
    return JSON.parse(rawBody.toString("utf8")) as SlackEnvelopeBase;
  } catch {
    return undefined;
  }
}

/**
 * Slack counts every non-2xx toward the 95%-per-hour failure budget that disables the event subscription.
 * Only permanent rejections (wrong signature, unroutable or mismatched binding) answer with a 4xx, and
 * those also carry `x-slack-no-retry` because a redelivery would fail identically. Transient failures
 * keep the default retry behaviour and never send that header.
 */
function rejectPermanently(
  context: SlackRequestContext,
  statusCode: number,
  error: string,
  code: SlackInboundFailureCode,
): FastifyReply {
  context.inbound.reject(code);
  return context.reply.code(statusCode).header("x-slack-no-retry", "1").send({ error });
}

/** Acknowledges traffic OpenTag deliberately does not process so Slack neither retries nor counts a failure. */
function acknowledgeIgnored(
  context: SlackRequestContext,
  reason: string,
  code?: SlackInboundFailureCode,
): FastifyReply {
  context.inbound.ignore(reason, code);
  return context.reply.code(200).send({ ok: true, ignored: reason });
}

function persistenceFailureCode(error: unknown): SlackInboundFailureCode {
  const code = classifyImInboundPersistenceError(error);
  if (code === "IM_INBOUND_IDENTITY_MISMATCH") return "SLACK_INBOUND_IDENTITY_MISMATCH";
  if (code === "IM_INBOUND_DATABASE_FAILED") return "SLACK_INBOUND_DATABASE_FAILED";
  return "SLACK_INBOUND_FAILED";
}

export function registerSlackEventsRoute(app: FastifyInstance, options: SlackEventsRouteOptions): void {
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer", bodyLimit: 1024 * 1024 },
    (_request, body, done) => {
      done(null, body);
    },
  );

  const processEnvelope = async (
    context: SlackRequestContext,
    binding: SlackIngressBinding,
    envelope: SlackEnvelopeBase,
  ): Promise<FastifyReply> => {
    context.inbound.setAttributes(
      slackInboundAttrs({
        bindingId: binding.imBindingId,
        providerEventId: envelope.event_id,
        envelopeType: envelope.type,
        eventType: envelope.event?.type,
        subtype: typeof envelope.event?.subtype === "string" ? envelope.event.subtype : undefined,
      }),
    );
    if (envelope.type === "app_rate_limited") {
      // Slack stopped delivering events for this workspace for the current minute; nothing to ingest,
      // but operators need to see it. No binding column records this today, so it is span-only.
      context.inbound.recordRateLimited(envelope.minute_rate_limited);
      context.request.log.warn(
        { code: "SLACK_APP_RATE_LIMITED", imBindingId: binding.imBindingId },
        "Slack reported the App as rate limited",
      );
      return acknowledgeIgnored(context, "app_rate_limited");
    }
    if (envelope.type !== "event_callback") {
      return acknowledgeIgnored(context, "unsupported_envelope", "SLACK_INBOUND_UNSUPPORTED_EVENT");
    }
    if (!envelope.event_id || !envelope.event) {
      return acknowledgeIgnored(context, "malformed_envelope", "SLACK_INBOUND_UNSUPPORTED_EVENT");
    }
    if (envelope.event.type === "app_uninstalled") {
      await options.imBindings.disableFromProvider(binding.imBindingId);
      return context.reply.code(200).send({ ok: true });
    }
    if (envelope.event.type === "tokens_revoked") {
      if (envelope.event.tokens?.bot?.includes(binding.botUserId)) {
        await options.imBindings.requireReauthorization(binding.imBindingId, "SLACK_TOKEN_REVOKED");
      }
      return context.reply.code(200).send({ ok: true });
    }

    let adapter: SlackAdapter;
    try {
      adapter = options.createAdapter(binding);
    } catch {
      throw new SlackEventProcessingError();
    }
    const classification = adapter.classifyInbound(envelope.event);
    if (!classification.accepted) {
      return acknowledgeIgnored(
        context,
        classification.reason,
        classification.reason === "unsupported_event" ? "SLACK_INBOUND_UNSUPPORTED_EVENT" : undefined,
      );
    }

    let events: ReturnType<SlackAdapter["normalizeInbound"]>;
    try {
      context.inbound.setFailureCode("SLACK_INBOUND_NORMALIZE_FAILED");
      events = adapter.normalizeInbound({
        eventId: envelope.event_id,
        appId: binding.appId,
        teamId: binding.teamId,
        botUserId: binding.botUserId,
        botId: binding.botId,
        event: envelope.event,
        eventTime: envelope.event_time,
      });
    } catch {
      throw new SlackEventProcessingError();
    }
    try {
      context.inbound.setFailureCode("SLACK_INBOUND_DATABASE_FAILED");
      await context.inbound.measureIngest(async () => {
        for (const event of events) {
          await options.inbox.ingest(binding.imBindingId, binding.generation, event, undefined, {
            provider: "slack",
            ...(context.retry ? { retry: context.retry } : {}),
          });
        }
      });
    } catch (error) {
      context.inbound.setFailureCode(persistenceFailureCode(error));
      throw new SlackEventProcessingError();
    }
    return context.reply.code(200).send({ ok: true });
  };

  const withInboundTrace = (
    request: SlackRequest,
    reply: FastifyReply,
    handle: (context: SlackRequestContext) => Promise<FastifyReply>,
  ): Promise<FastifyReply> => {
    const retry = parseSlackRetryHeaders(request.headers);
    return traceSlackInbound(slackInboundAttrs({ retry }), (inbound) => handle({ request, reply, inbound, retry }));
  };

  app.post(AGENT_SLACK_EVENTS_TEMPLATE, async (request: SlackRequest, reply) =>
    withInboundTrace(request, reply, async (context) => {
      if (!Buffer.isBuffer(request.body)) {
        return rejectPermanently(context, 400, "invalid_body", "SLACK_INBOUND_UNROUTABLE");
      }
      const envelope = parseEnvelope(request.body);
      if (!envelope) return rejectPermanently(context, 400, "invalid_json", "SLACK_INBOUND_UNROUTABLE");
      const agentId = request.params.agentId;
      if (typeof agentId !== "string") {
        return rejectPermanently(context, 400, "invalid_route", "SLACK_INBOUND_UNROUTABLE");
      }
      const requestHeaders = signatureHeaders(request);
      if (envelope.type === "url_verification") {
        if (!options.setup) return rejectPermanently(context, 404, "setup_unavailable", "SLACK_INBOUND_UNROUTABLE");
        const challenge = await options.setup.verifyChallenge({
          agentId,
          rawBody: request.body,
          ...requestHeaders,
        });
        return reply.code(200).send({ challenge });
      }
      if (!envelope.api_app_id || !envelope.team_id) {
        return rejectPermanently(context, 400, "invalid_route", "SLACK_INBOUND_UNROUTABLE");
      }
      const outcome = (await options.setup?.tryActivateFromEvent({
        agentId,
        appId: envelope.api_app_id,
        teamId: envelope.team_id,
        rawBody: request.body,
        ...requestHeaders,
      })) ?? { status: "unmatched" };
      const activated = outcome.status === "activated" ? outcome.binding : undefined;
      const binding = activated ?? (await options.imBindings.findSlackIngressBindingForAgent(agentId));
      if (!binding) {
        // A signed event for an attempt that still awaits URL verification is not a delivery failure:
        // acknowledge it so Slack keeps the subscription alive, but ingest nothing before activation.
        if (outcome.status === "awaiting_challenge") {
          context.inbound.ignore("url_verification_pending");
          return reply.code(200).send({ ok: true, pending: "url_verification" });
        }
        return rejectPermanently(context, 404, "binding_not_found", "SLACK_INBOUND_UNROUTABLE");
      }
      if (
        !activated &&
        !verifySlackSignature({
          rawBody: request.body,
          ...requestHeaders,
          signingSecret: binding.signingSecret,
          now: options.now?.(),
        })
      ) {
        return rejectPermanently(context, 401, "invalid_signature", "SLACK_INBOUND_SIGNATURE_INVALID");
      }
      if (envelope.api_app_id !== binding.appId || envelope.team_id !== binding.teamId) {
        return rejectPermanently(context, 401, "binding_mismatch", "SLACK_INBOUND_IDENTITY_MISMATCH");
      }
      return processEnvelope(context, binding, envelope);
    }),
  );

  app.post(SLACK_EVENTS_PATH, async (request: SlackRequest, reply) =>
    withInboundTrace(request, reply, async (context) => {
      if (!Buffer.isBuffer(request.body)) {
        return rejectPermanently(context, 400, "invalid_body", "SLACK_INBOUND_UNROUTABLE");
      }
      const route = preparseSlackRoute(request.body);
      if (!route) return rejectPermanently(context, 400, "invalid_route", "SLACK_INBOUND_UNROUTABLE");
      const binding = await options.imBindings.findSlackIngressBinding(route.appId, route.teamId);
      if (!binding) return rejectPermanently(context, 404, "binding_not_found", "SLACK_INBOUND_UNROUTABLE");
      const requestHeaders = signatureHeaders(request);
      if (
        !verifySlackSignature({
          rawBody: request.body,
          ...requestHeaders,
          signingSecret: binding.signingSecret,
          now: options.now?.(),
        })
      ) {
        return rejectPermanently(context, 401, "invalid_signature", "SLACK_INBOUND_SIGNATURE_INVALID");
      }

      const envelope = parseEnvelope(request.body);
      if (!envelope) return rejectPermanently(context, 400, "invalid_json", "SLACK_INBOUND_UNROUTABLE");
      if (envelope.api_app_id !== binding.appId || envelope.team_id !== binding.teamId) {
        return rejectPermanently(context, 401, "binding_mismatch", "SLACK_INBOUND_IDENTITY_MISMATCH");
      }
      if (envelope.type === "url_verification") {
        return typeof envelope.challenge === "string"
          ? reply.code(200).send({ challenge: envelope.challenge })
          : rejectPermanently(context, 400, "invalid_challenge", "SLACK_INBOUND_UNROUTABLE");
      }
      return processEnvelope(context, binding, envelope);
    }),
  );
}
