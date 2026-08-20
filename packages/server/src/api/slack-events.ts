import { SLACK_EVENTS_PATH } from "@opentag/shared";
import type { FastifyInstance } from "fastify";
import type { ImMessageInbox } from "../services/im/index.js";
import type { ImBindingService, SlackIngressBinding } from "../services/im-bindings/index.js";
import type { SlackAdapter } from "../services/im-bindings/slack/adapter.js";
import { preparseSlackRoute, verifySlackSignature } from "../services/im-bindings/slack/signature.js";

interface SlackEnvelopeBase {
  type?: string;
  api_app_id?: string;
  team_id?: string;
  event_id?: string;
  event_time?: number;
  challenge?: string;
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
  now?: () => Date;
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

  app.post(SLACK_EVENTS_PATH, async (request, reply) => {
    if (!Buffer.isBuffer(request.body)) return reply.code(400).send({ error: "invalid_body" });
    const route = preparseSlackRoute(request.body);
    if (!route) return reply.code(400).send({ error: "invalid_route" });
    const binding = await options.imBindings.findSlackIngressBinding(route.appId, route.teamId);
    if (!binding) return reply.code(404).send({ error: "binding_not_found" });
    const timestampHeader = request.headers["x-slack-request-timestamp"];
    const signatureHeader = request.headers["x-slack-signature"];
    if (
      !verifySlackSignature({
        rawBody: request.body,
        timestamp: Array.isArray(timestampHeader) ? timestampHeader[0] : timestampHeader,
        signature: Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader,
        signingSecret: binding.signingSecret,
        now: options.now?.(),
      })
    ) {
      return reply.code(401).send({ error: "invalid_signature" });
    }

    let envelope: SlackEnvelopeBase;
    try {
      envelope = JSON.parse(request.body.toString("utf8")) as SlackEnvelopeBase;
    } catch {
      return reply.code(400).send({ error: "invalid_json" });
    }
    if (envelope.api_app_id !== binding.appId || envelope.team_id !== binding.teamId) {
      return reply.code(401).send({ error: "binding_mismatch" });
    }
    if (envelope.type === "url_verification") {
      return typeof envelope.challenge === "string"
        ? reply.code(200).send({ challenge: envelope.challenge })
        : reply.code(400).send({ error: "invalid_challenge" });
    }
    if (envelope.type !== "event_callback" || !envelope.event_id || !envelope.event) {
      return reply.code(400).send({ error: "unsupported_envelope" });
    }
    if (envelope.event.type === "app_uninstalled") {
      await options.imBindings.disableFromProvider(binding.imBindingId);
      return reply.code(200).send({ ok: true });
    }
    if (envelope.event.type === "tokens_revoked") {
      if (envelope.event.tokens?.bot?.includes(binding.botUserId)) {
        await options.imBindings.requireReauthorization(binding.imBindingId, "SLACK_TOKEN_REVOKED");
      }
      return reply.code(200).send({ ok: true });
    }

    try {
      const adapter = options.createAdapter(binding);
      const events = adapter.normalizeInbound({
        eventId: envelope.event_id,
        appId: binding.appId,
        teamId: binding.teamId,
        botUserId: binding.botUserId,
        event: envelope.event,
        eventTime: envelope.event_time,
      });
      for (const event of events) {
        await options.inbox.ingest(binding.imBindingId, binding.generation, event, undefined, { provider: "slack" });
      }
    } catch {
      throw new SlackEventProcessingError();
    }
    return reply.code(200).send({ ok: true });
  });
}
