import { AGENT_SLACK_EVENTS_TEMPLATE, hasRequiredSlackBotScopes, SLACK_EVENTS_PATH } from "@opentag/shared";
import type { FastifyInstance, FastifyReply } from "fastify";
import { createServiceLoggerPort } from "../observability/service-logger.js";
import type { RuntimeApprovalOwner } from "../runtime/runtime-approval-owner.js";
import type { InboundReceiptAttempt } from "../services/im/inbound-receipt-work-store.js";

import { classifyImInboundPersistenceError, type ImMessageInbox } from "../services/im/index.js";
import type { ImBindingService, SlackInstallationIngress } from "../services/im-bindings/index.js";
import type { SlackAdapter } from "../services/im-bindings/slack/adapter.js";
import {
  createSlackInboundWork,
  hasSlackBotAuthorization,
  matchesSlackInstallation,
  recoveredSlackEnvelope,
  type SlackEventEnvelope as SlackEnvelopeBase,
} from "../services/im-bindings/slack/inbound-work.js";
import { preparseSlackRoute, verifySlackSignature } from "../services/im-bindings/slack/signature.js";
import type { SlackWebhookReceiptStore } from "../services/im-bindings/slack/webhook-receipt-store.js";
import { registerSlackInteractionsRoute } from "./slack-interactions.js";

class SlackEventProcessingError extends Error {
  readonly code: string;
  readonly retry: boolean;

  constructor(
    readonly stage: "normalize" | "inbox",
    error: unknown,
  ) {
    const code = classifyImInboundPersistenceError(error);
    const errorCode = code === "IM_INBOUND_DATABASE_FAILED" ? "SLACK_EVENT_PROCESSING_FAILED" : code;
    super(errorCode);
    this.name = "SlackEventProcessingError";
    this.code = errorCode;
    this.retry = code !== "IM_INBOUND_BINDING_STALE" && code !== "IM_INBOUND_IDENTITY_MISMATCH";
  }
}

class SlackInboundCredentialsError extends Error {
  readonly code: string;
  readonly retry: boolean;

  constructor(grantedCapabilities: string[]) {
    const retry = hasRequiredSlackBotScopes(grantedCapabilities);
    const code = retry ? "SLACK_INBOUND_CREDENTIALS_UNAVAILABLE" : "SLACK_INBOUND_SCOPES_MISSING";
    super(code);
    this.name = "SlackInboundCredentialsError";
    this.code = code;
    this.retry = retry;
  }
}

function slackRecoveryFailure(error: unknown, validWork: boolean) {
  if (!validWork) return { code: "SLACK_INBOUND_WORK_INVALID", retry: false };
  if (error instanceof SlackEventProcessingError || error instanceof SlackInboundCredentialsError)
    return { code: error.code, retry: error.retry };
  return { code: "SLACK_EVENT_PROCESSING_FAILED", retry: true };
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

export type SlackWebhookReceiptStoreLike = Pick<SlackWebhookReceiptStore, "claim" | "markProcessed" | "markFailed"> &
  Partial<Pick<SlackWebhookReceiptStore, "recovery">>;

type SlackEventsReceiptOptions = { receipts?: SlackWebhookReceiptStoreLike };

export interface SlackEventsRouteOptions extends SlackEventsReceiptOptions {
  approvalOwner?: Pick<RuntimeApprovalOwner, "decide">;
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

export function registerSlackEventsRoute(app: FastifyInstance, options: SlackEventsRouteOptions) {
  registerSlackInteractionsRoute(app, options);
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

  const originalRoute = async (installation: SlackInstallationIngress, bindingId: string | null | undefined) => {
    if (bindingId === undefined) return options.imBindings.resolveSlackDefaultRoute(installation.installationId);
    return bindingId ? { imBindingId: bindingId } : undefined;
  };

  const processEnvelope = async (
    installation: SlackInstallationIngress,
    envelope: SlackEnvelopeBase,
    reply: FastifyReply,
    work?: { bindingId?: string | null; receivedAt: Date },
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
    const identityClosed = hasSlackBotAuthorization(installation, envelope);
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
    const routed = await originalRoute(installation, work?.bindingId);
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
          receivedAt: work?.receivedAt,
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
    } catch (error) {
      throw new SlackEventProcessingError(stage, error);
    }
    return reply.code(200).send({ ok: true });
  };

  const pending = new Set<Promise<unknown>>();
  let closing = false;
  let recovery: Promise<void> | undefined;
  const backgroundReply = { code: () => backgroundReply, send: () => backgroundReply } as unknown as FastifyReply;
  const processRecovered = async (attempt: InboundReceiptAttempt): Promise<void> => {
    const receipts = options.receipts;
    const workStore = receipts?.recovery;
    if (!receipts || !workStore) return;
    let validWork = false;
    try {
      const work = workStore.parse(attempt);
      if (work.provider !== "slack" || work.eventId !== attempt.eventId)
        throw new Error("SLACK_INBOUND_WORK_IDENTITY_MISMATCH");
      validWork = true;
      const installation = await options.imBindings.findSlackInstallationIngress(work.appId, work.teamId);
      const current = installation ? undefined : await workStore.findCurrentSlackInstallation(attempt);
      if (current) throw new SlackInboundCredentialsError(current.grantedCapabilities);
      if (
        installation &&
        installation.installationId === attempt.scopeId &&
        installation.generation === attempt.credentialGeneration &&
        installation.botUserId === work.botUserId &&
        installation.botId === work.botId
      ) {
        await processEnvelope(installation, recoveredSlackEnvelope(work), backgroundReply, {
          bindingId: work.bindingId,
          receivedAt: attempt.receivedAt,
        });
      }
      await receipts.markProcessed(attempt.receiptId, attempt.attempt);
    } catch (error) {
      const { code, retry } = slackRecoveryFailure(error, validWork);
      await receipts.markFailed(attempt.receiptId, code, attempt.attempt, retry);
      logger.error(
        { provider: "slack", receiptId: attempt.receiptId, stage: "recovery", outcome: "failed" },
        "Slack inbound processing failed",
      );
    }
  };
  const recoverOnce = (): Promise<void> => {
    if (closing || !options.receipts?.recovery) return Promise.resolve();
    if (recovery) return recovery;
    const receipts = options.receipts;
    const workStore = receipts.recovery;
    if (!workStore) return Promise.resolve();
    recovery = (async () => {
      for (let count = 0; count < 8 && !closing; count++) {
        const attempt = await workStore.claimNext();
        if (!attempt) break;
        await processRecovered(attempt);
      }
    })().finally(() => {
      recovery = undefined;
    });
    return recovery;
  };
  let recoveryTimer: ReturnType<typeof setInterval> | undefined;
  app.addHook("onReady", async () => {
    if (!options.receipts?.recovery) return;
    recoveryTimer = setInterval(() => {
      void recoverOnce().catch(() =>
        logger.error({ provider: "slack", stage: "recovery", outcome: "failed" }, "Slack inbound recovery failed"),
      );
    }, 5_000);
    recoveryTimer.unref();
  });
  app.addHook("onClose", async () => {
    closing = true;
    if (recoveryTimer) clearInterval(recoveryTimer);
    await Promise.allSettled([...pending, ...(recovery ? [recovery] : [])]);
  });

  const receiptWork = async (installation: SlackInstallationIngress, envelope: SlackEnvelopeBase) => {
    const event = envelope.event;
    if (!event) throw new Error("SLACK_EVENT_MISSING");
    const identityClosed = hasSlackBotAuthorization(installation, envelope);
    const control = event.type === "app_uninstalled" || event.type === "tokens_revoked";
    let bindingId: string | null | undefined = null;
    if (!control && identityClosed) {
      try {
        bindingId =
          (await options.imBindings.resolveSlackDefaultRoute(installation.installationId))?.imBindingId ?? null;
      } catch {
        bindingId = undefined;
        logger.warn(
          { ...slackEventLogContext(installation, envelope), stage: "route", reason: "route_snapshot_unavailable" },
          "Slack inbound route snapshot deferred",
        );
      }
    }
    const work = createSlackInboundWork(installation, envelope, bindingId);
    return { work, bindingId };
  };

  const processWithReceipt = async (
    installation: SlackInstallationIngress,
    envelope: SlackEnvelopeBase,
    reply: FastifyReply,
  ) => {
    if (!options.receipts || envelope.type !== "event_callback" || !envelope.event_id || !envelope.event) {
      return processEnvelope(installation, envelope, reply);
    }
    const { work, bindingId } = await receiptWork(installation, envelope);
    const claim = await options.receipts.claim({
      installationId: installation.installationId,
      credentialGeneration: installation.generation,
      eventId: envelope.event_id,
      work,
    });
    const logContext = { ...slackEventLogContext(installation, envelope), receiptId: claim.receiptId };
    if (!claim.accepted || !claim.receiptId) {
      logger.info(
        { ...logContext, stage: "receipt", outcome: "ignored", reason: "duplicate_receipt" },
        "Slack inbound ignored",
      );
      return reply.code(200).send({ ok: true });
    }
    let stage = "process";
    const operation = processEnvelope(installation, recoveredSlackEnvelope(work), backgroundReply, {
      ...(bindingId === undefined ? {} : { bindingId }),
      receivedAt: claim.receivedAt ?? options.now?.() ?? new Date(),
    })
      .then(() => {
        stage = "receipt";
        return claim.attempt === undefined
          ? options.receipts?.markProcessed(claim.receiptId as string)
          : options.receipts?.markProcessed(claim.receiptId as string, claim.attempt);
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
        await (claim.attempt === undefined
          ? options.receipts?.markFailed(claim.receiptId as string, code)
          : options.receipts?.markFailed(
              claim.receiptId as string,
              code,
              claim.attempt,
              !(error instanceof SlackEventProcessingError) || error.retry,
            )
        )?.catch(() => {
          logger.error(
            { ...logContext, stage: "receipt", outcome: "failed", reason: "receipt_persist_failed" },
            "Slack inbound receipt persistence failed",
          );
        });
      });
    pending.add(operation);
    void operation.finally(() => pending.delete(operation));
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
    if (!matchesSlackInstallation(installation, envelope)) {
      return reply.code(401).send({ error: "binding_mismatch" });
    }
    return processWithReceipt(installation, envelope, reply);
  });

  const firstPartyChallenge = (rawBody: Buffer, requestHeaders: ReturnType<typeof headers>, reply: FastifyReply) => {
    if (!options.firstPartySigningSecret || !isIdentityLessUrlVerification(rawBody)) return undefined;
    if (
      !verifySlackSignature({
        rawBody,
        ...requestHeaders,
        signingSecret: options.firstPartySigningSecret,
        now: options.now?.(),
      })
    ) {
      return reply.code(401).send({ error: "invalid_signature" });
    }
    const envelope = parseEnvelope(rawBody);
    if (typeof envelope?.challenge !== "string") return reply.code(400).send({ error: "invalid_challenge" });
    return reply.code(200).send({ challenge: envelope.challenge });
  };

  app.post(SLACK_EVENTS_PATH, async (request, reply) => {
    if (!Buffer.isBuffer(request.body)) return reply.code(400).send({ error: "invalid_body" });
    const requestHeaders = headers(request);
    const challenge = firstPartyChallenge(request.body, requestHeaders, reply);
    if (challenge) return challenge;
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
    if (!matchesSlackInstallation(installation, envelope)) {
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
  return { recoverOnce };
}
