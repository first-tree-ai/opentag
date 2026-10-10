import { AGENT_SLACK_INTERACTIONS_TEMPLATE, SLACK_INTERACTIONS_PATH } from "@opentag/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { verifySlackSignature } from "../services/im-bindings/slack/signature.js";
import type { SlackEventsRouteOptions } from "./slack-events.js";

const PayloadSchema = z.object({
  type: z.literal("block_actions"),
  api_app_id: z.string().min(1).max(128),
  team: z.object({ id: z.string().min(1).max(128) }),
  user: z.object({ id: z.string().min(1).max(128) }),
  channel: z.object({ id: z.string().min(1).max(128) }),
  message: z.object({ ts: z.string().min(1).max(128) }),
  actions: z
    .array(
      z.object({
        action_id: z.enum(["opentag_approval_accept", "opentag_approval_decline"]),
        value: z.string().uuid(),
      }),
    )
    .length(1),
});

export function registerSlackInteractionsRoute(app: FastifyInstance, options: SlackEventsRouteOptions) {
  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "buffer", bodyLimit: 32_768 },
    (_request, body, done) => done(null, body),
  );
  for (const path of [SLACK_INTERACTIONS_PATH, AGENT_SLACK_INTERACTIONS_TEMPLATE]) {
    app.post(path, async (request, reply) => {
      if (!Buffer.isBuffer(request.body)) return reply.code(400).send();
      const payload = parsePayload(request.body);
      if (!payload) return reply.code(400).send();
      const installation = await verifiedInstallation(request, payload, options);
      if (!installation) return reply.code(401).send();
      await dispatchAction(options, payload, installation);
      return reply.code(200).send();
    });
  }
}

async function verifiedInstallation(
  request: FastifyRequest,
  payload: z.infer<typeof PayloadSchema>,
  options: SlackEventsRouteOptions,
) {
  if (!Buffer.isBuffer(request.body)) return undefined;
  const agentId = (request.params as { agentId?: string }).agentId;
  const installation = agentId
    ? await options.imBindings.findSlackInstallationIngressForAgent(agentId)
    : await options.imBindings.findSlackInstallationIngress(payload.api_app_id, payload.team.id);
  const timestamp = request.headers["x-slack-request-timestamp"];
  const signature = request.headers["x-slack-signature"];
  if (
    !installation ||
    installation.appId !== payload.api_app_id ||
    installation.teamId !== payload.team.id ||
    !verifySlackSignature({
      rawBody: request.body,
      signingSecret: installation.signingSecret,
      timestamp: typeof timestamp === "string" ? timestamp : undefined,
      signature: typeof signature === "string" ? signature : undefined,
      now: options.now?.(),
    })
  )
    return undefined;
  return installation;
}

function parsePayload(rawBody: Buffer) {
  try {
    return PayloadSchema.parse(JSON.parse(new URLSearchParams(rawBody.toString("utf8")).get("payload") ?? ""));
  } catch {
    return undefined;
  }
}

async function dispatchAction(
  options: SlackEventsRouteOptions,
  payload: z.infer<typeof PayloadSchema>,
  installation: import("../services/im-bindings/im-binding-service.js").SlackInstallationIngress,
) {
  const action = payload.actions[0];
  if (action)
    await options.approvalOwner?.decide({
      approvalId: action.value,
      decision: action.action_id === "opentag_approval_accept" ? "accept" : "decline",
      userId: payload.user.id,
      provider: "slack",
      generation: installation.generation,
      installationId: installation.installationId,
      messageId: payload.message.ts,
      channelId: payload.channel.id,
    });
}
