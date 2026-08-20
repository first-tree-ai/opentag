import {
  INVITATION_PREVIEW_TEMPLATE,
  INVITATION_REDEEM_TEMPLATE,
  InvitationPreviewSchema,
  InvitationRedemptionResponseSchema,
  TEAM_INVITATION_TEMPLATE,
  TeamInvitationSchema,
} from "@opentag/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { createUserAuthPreHandler } from "../plugins/user-auth.js";
import type { UserAuthService } from "../services/auth/index.js";
import type { InvitationService } from "../services/invitations/index.js";
import { parseRequest } from "./request-validation.js";

const TeamParamsSchema = z.object({ teamId: z.string().uuid() }).strict();
const InvitationParamsSchema = z.object({ token: z.string().min(1).max(512) }).strict();

function userId(request: FastifyRequest): string {
  const value = request.authContext?.me.user.id;
  if (!value) throw new Error("Authenticated user context is missing");
  return value;
}

function audit(request: FastifyRequest) {
  const userAgent = request.headers["user-agent"];
  return { ip: request.ip.slice(0, 255), ...(userAgent ? { userAgent: userAgent.slice(0, 1024) } : {}) };
}

export function registerInvitationRoutes(
  app: FastifyInstance,
  authService: UserAuthService,
  invitationService: InvitationService,
  publicOrigin?: string,
): void {
  const preHandler = createUserAuthPreHandler(authService, { publicOrigin });

  app.get(TEAM_INVITATION_TEMPLATE, { preHandler }, async (request, reply) => {
    const { teamId } = parseRequest(TeamParamsSchema, request.params);
    const invitation = await invitationService.get(userId(request), teamId);
    return invitation ? reply.code(200).send(TeamInvitationSchema.parse(invitation)) : reply.code(204).send();
  });

  app.post(TEAM_INVITATION_TEMPLATE, { preHandler }, async (request, reply) => {
    const { teamId } = parseRequest(TeamParamsSchema, request.params);
    return reply.code(201).send(TeamInvitationSchema.parse(await invitationService.create(userId(request), teamId)));
  });

  app.post(`${TEAM_INVITATION_TEMPLATE}/rotate`, { preHandler }, async (request, reply) => {
    const { teamId } = parseRequest(TeamParamsSchema, request.params);
    return reply.code(200).send(TeamInvitationSchema.parse(await invitationService.rotate(userId(request), teamId)));
  });

  app.get(INVITATION_PREVIEW_TEMPLATE, async (request, reply) => {
    const { token } = parseRequest(InvitationParamsSchema, request.params);
    return reply.code(200).send(InvitationPreviewSchema.parse(await invitationService.preview(token)));
  });

  app.post(INVITATION_REDEEM_TEMPLATE, { preHandler }, async (request, reply) => {
    const { token } = parseRequest(InvitationParamsSchema, request.params);
    return reply
      .code(200)
      .send(
        InvitationRedemptionResponseSchema.parse(
          await invitationService.redeem(userId(request), token, audit(request)),
        ),
      );
  });
}
