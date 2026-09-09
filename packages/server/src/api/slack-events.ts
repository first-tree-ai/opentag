import { AGENT_SLACK_EVENTS_TEMPLATE, SLACK_EVENTS_PATH } from "@opentag/shared";
import type { FastifyInstance, FastifyReply } from "fastify";
import { createServiceLoggerPort } from "../observability/service-logger.js";
import type { ImMessageInbox } from "../services/im/index.js";
import type { ImBindingService, SlackInstallationIngress } from "../services/im-bindings/index.js";
import type { SlackAdapter } from "../services/im-bindings/slack/adapter.js";
import { preparseSlackRoute, verifySlackSignature } from "../services/im-bindings/slack/signature.js";
import type { SlackWebhookReceiptStore } from "../services/im-bindings/slack/webhook-receipt-store.js";

interface SlackEnvelopeBase {
  type?: string;
  api_app_id?: string;
  team_id?: string;
  event_id?: string;
  event_time?: number;
  challenge?: string;
  authorizations?: Array<{ team_id?: string; user_id?: string; is_bot?: boolean }>;
  event?: { type?: string; tokens?: { oauth?: string[]; bot?: string[] } } & Record<string, unknown>;
}

class SlackEventProcessingError extends Error {
  readonly code = "SLACK_EVENT_PROCESSING_FAILED";

  constructor(readonly stage: "normalize" | "inbox") {
    super("SLACK_EVENT_PROCESSING_FAILED");
    this.name = "SlackEventProcessingError";
  }
}

function isIdentityLessUrlVerification(rawBody: Buffer): boolean {
  try {
    const value = JSON.parse(rawBody.toString("utf8")) as Record<string, unknown>;
    return (
      value.type === "url_verification" &&
      typeof value.api_app_id !== "string" &&
      typeof value.team_id !== "string" &&
      typeof value.workspace !== "string"
    );
  } catch {
    return false;
  }
}

export type SlackWebhookReceiptStoreLike = Pick<SlackWebhookReceiptStore, "claim" | "markProcessed" | "markFailed">;

type SlackEventsReceiptOptions = { receipts?: SlackWebhookReceiptStoreLike };

export interface SlackEventsRouteOptions extends SlackEventsReceiptOptions {
  imBindings: ImBindingService;
  inbox: ImMessageInbox;
  createAdapter(installation: SlackInstallationIngress): SlackAdapter;
  firstPartySigningSecret?: string;
  now?: () => Date;
}

function slackEventLogContext(installation: SlackInstallationIngress, envelope: SlackEnvelopeBase) {
  return {
    provider: "slack",
    eventId: envelope.event_id?.slice(0, 128),
    installationId: installation.installationId,
    generation: installation.generation,
  };
}

export function registerSlackEventsRoute(app: FastifyInstance, options: SlackEventsRouteOptions): void {
  const logger = createServiceLoggerPort(() => app.log, "slack-events");
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer", bodyLimit: 1024 * 1024 },
    (_request, body, done) => {
      done(null, body);
    },
  );

  const headers = (request: { headers: Record<string, string | string[] | undefined> }) => {
    const timestampHeader = request.headers["x-slack-request-timestamp"];
    const signatureHeader = request.headers["x-slack-signature"];
    return {
      timestamp: Array.isArray(timestampHeader) ? timestampHeader[0] : timestampHeader,
      signature: Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader,
    };
  };

  const parseEnvelope = (rawBody: Buffer): SlackEnvelopeBase | undefined => {
    try {
      return JSON.parse(rawBody.toString("utf8")) as SlackEnvelopeBase;
    } catch {
      return undefined;
    }
  };

  const processEnvelope = async (
    installation: SlackInstallationIngress,
    envelope: SlackEnvelopeBase,
    reply: FastifyReply,
  ) => {
    if (envelope.type !== "event_callback" || !envelope.event_id || !envelope.event) {
      return reply.code(400).send({ error: "unsupported_envelope" });
    }
    if (envelope.event.type === "app_uninstalled") {
      await options.imBindings.disableSlackInstallationFromProvider(
        installation.installationId,
        installation.generation,
      );
      return reply.code(200).send({ ok: true });
    }
    if (envelope.event.type === "tokens_revoked") {
      if (envelope.event.tokens?.bot?.includes(installation.botUserId)) {
        await options.imBindings.requireSlackInstallationReauthorization(
          installation.installationId,
          installation.generation,
          "SLACK_TOKEN_REVOKED",
        );
      }
      return reply.code(200).send({ ok: true });
    }
    const identityClosed = envelope.authorizations?.some(
      (authorization) =>
        authorization.is_bot === true &&
        authorization.team_id === installation.teamId &&
        authorization.user_id === installation.botUserId,
    );
    const logContext = slackEventLogContext(installation, envelope);
    if (!identityClosed) {
      logger.info(
        { ...logContext, stage: "authorize", outcome: "ignored", reason: "identity_mismatch" },
        "Slack inbound ignored",
      );
      return reply.code(401).send({ error: "binding_mismatch" });
    }
    if (
      !(await options.imBindings.recordSlackInstallationIdentityClosure(
        installation.installationId,
        installation.generation,
      ))
    ) {
      logger.info(
        { ...logContext, stage: "authorize", outcome: "ignored", reason: "generation_changed" },
        "Slack inbound ignored",
      );
      return reply.code(200).send({ ok: true });
    }
    const routed = await options.imBindings.resolveSlackDefaultRoute(installation.installationId);
    if (!routed) {
      logger.info({ ...logContext, stage: "route", outcome: "ignored", reason: "no_route" }, "Slack inbound ignored");
      return reply.code(200).send({ ok: true });
    }

    let stage: "normalize" | "inbox" = "normalize";
    try {
      const adapter = options.createAdapter(installation);
      const events = adapter.normalizeInbound(
        {
          eventId: envelope.event_id,
          appId: installation.appId,
          teamId: installation.teamId,
          botUserId: installation.botUserId,
          botId: installation.botId,
          event: envelope.event,
          eventTime: envelope.event_time,
        },
        (reason) => {
          const invalid = reason === "malformed_supported_event";
          logger[invalid ? "warn" : "info"](
            { ...logContext, stage, outcome: invalid ? "invalid" : "ignored", reason },
            "Slack inbound rejected",
          );
        },
      );
      stage = "inbox";
      for (const event of events) {
        const result = await options.inbox.ingest(routed.imBindingId, installation.generation, event, undefined, {
          provider: "slack",
        });
        logger.info(
          {
            ...logContext,
            stage,
            messageId: result?.messageId,
            deliveryIds: result?.deliveryIds,
            duplicate: result?.duplicate,
          },
          "Slack inbound inbox result",
        );
      }
    } catch {
      throw new SlackEventProcessingError(stage);
    }
    return reply.code(200).send({ ok: true });
  };

  const processWithReceipt = async (
    installation: SlackInstallationIngress,
    envelope: SlackEnvelopeBase,
    reply: FastifyReply,
  ) => {
    if (!options.receipts || envelope.type !== "event_callback" || !envelope.event_id || !envelope.event) {
      return processEnvelope(installation, envelope, reply);
    }
    const claim = await options.receipts.claim({
      installationId: installation.installationId,
      credentialGeneration: installation.generation,
      eventId: envelope.event_id,
    });
    const logContext = { ...slackEventLogContext(installation, envelope), receiptId: claim.receiptId };
    if (!claim.accepted || !claim.receiptId) {
      logger.info(
        { ...logContext, stage: "receipt", outcome: "ignored", reason: "duplicate_receipt" },
        "Slack inbound ignored",
      );
      return reply.code(200).send({ ok: true });
    }
    // A real reply object cannot be used after the HTTP request is acknowledged. The work function
    // only uses it to construct status responses, so this sink keeps those responses off the wire.
    const backgroundReply = {
      code: () => backgroundReply,
      send: () => backgroundReply,
    } as unknown as FastifyReply;
    let stage = "process";
    void processEnvelope(installation, envelope, backgroundReply)
      .then(() => {
        stage = "receipt";
        return options.receipts?.markProcessed(claim.receiptId as string);
      })
      .catch(async (error: unknown) => {
        const code =
          error && typeof error === "object" && "code" in error && typeof error.code === "string"
            ? error.code
            : "SLACK_EVENT_PROCESSING_FAILED";
        logger.error(
          {
            ...logContext,
            stage: error instanceof SlackEventProcessingError ? error.stage : stage,
            outcome: "failed",
            reason: "processing_failed",
          },
          "Slack inbound processing failed",
        );
        await options.receipts?.markFailed(claim.receiptId as string, code).catch(() => {
          logger.error(
            { ...logContext, stage: "receipt", outcome: "failed", reason: "receipt_persist_failed" },
            "Slack inbound receipt persistence failed",
          );
        });
      });
    return reply.code(200).send({ ok: true });
  };

  app.post(AGENT_SLACK_EVENTS_TEMPLATE, async (request, reply) => {
    if (!Buffer.isBuffer(request.body)) return reply.code(400).send({ error: "invalid_body" });
    const agentId = (request.params as { agentId?: unknown }).agentId;
    if (typeof agentId !== "string") return reply.code(400).send({ error: "invalid_route" });
    const installation = await options.imBindings.findSlackInstallationIngressForAgent(agentId);
    if (!installation) return reply.code(404).send({ error: "binding_not_found" });
    const requestHeaders = headers(request);
    if (
      !verifySlackSignature({
        rawBody: request.body,
        ...requestHeaders,
        signingSecret: installation.signingSecret,
        now: options.now?.(),
      })
    ) {
      return reply.code(401).send({ error: "invalid_signature" });
    }
    const envelope = parseEnvelope(request.body);
    if (!envelope) return reply.code(400).send({ error: "invalid_json" });
    if (envelope.type === "url_verification") {
      if (typeof envelope.challenge !== "string") return reply.code(400).send({ error: "invalid_challenge" });
      // Slack's URL-verification protocol omits App and Team identity. The Agent-specific URL
      // supplies only the lookup key; a valid HMAC records an observation but never changes config.
      await options.imBindings.recordSlackInstallationObservation(installation.installationId, installation.generation);
      return reply.code(200).send({ challenge: envelope.challenge });
    }
    if (!envelope.api_app_id || !envelope.team_id) return reply.code(400).send({ error: "invalid_route" });
    if (envelope.api_app_id !== installation.appId || envelope.team_id !== installation.teamId) {
      return reply.code(401).send({ error: "binding_mismatch" });
    }
    return processWithReceipt(installation, envelope, reply);
  });

  app.post(SLACK_EVENTS_PATH, async (request, reply) => {
    if (!Buffer.isBuffer(request.body)) return reply.code(400).send({ error: "invalid_body" });
    const requestHeaders = headers(request);
    if (options.firstPartySigningSecret && isIdentityLessUrlVerification(request.body)) {
      if (
        !verifySlackSignature({
          rawBody: request.body,
          ...requestHeaders,
          signingSecret: options.firstPartySigningSecret,
          now: options.now?.(),
        })
      ) {
        return reply.code(401).send({ error: "invalid_signature" });
      }
      const envelope = parseEnvelope(request.body);
      if (typeof envelope?.challenge !== "string") return reply.code(400).send({ error: "invalid_challenge" });
      return reply.code(200).send({ challenge: envelope.challenge });
    }
    // Bounded App/Team fields are used only to locate the Signing Secret. The raw body is not
    // trusted until the HMAC below succeeds.
    const route = preparseSlackRoute(request.body);
    if (!route) return reply.code(400).send({ error: "invalid_route" });
    const installation = await options.imBindings.findSlackInstallationIngress(route.appId, route.teamId);
    if (!installation) return reply.code(404).send({ error: "binding_not_found" });
    if (
      !verifySlackSignature({
        rawBody: request.body,
        ...requestHeaders,
        signingSecret: installation.signingSecret,
        now: options.now?.(),
      })
    ) {
      return reply.code(401).send({ error: "invalid_signature" });
    }

    const envelope = parseEnvelope(request.body);
    if (!envelope) return reply.code(400).send({ error: "invalid_json" });
    if (envelope.api_app_id !== installation.appId || envelope.team_id !== installation.teamId) {
      return reply.code(401).send({ error: "binding_mismatch" });
    }
    if (envelope.type === "url_verification") {
      await options.imBindings.recordSlackInstallationObservation(installation.installationId, installation.generation);
      return typeof envelope.challenge === "string"
        ? reply.code(200).send({ challenge: envelope.challenge })
        : reply.code(400).send({ error: "invalid_challenge" });
    }
    return processWithReceipt(installation, envelope, reply);
  });
}
