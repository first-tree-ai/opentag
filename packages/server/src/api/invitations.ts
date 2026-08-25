import {
  ADMIN_INVITATION_ACCEPT_TEMPLATE,
  ADMIN_INVITATION_PREVIEW_TEMPLATE,
  AdminInvitationSchema,
  InvitationAcceptanceResponseSchema,
  InvitationPreviewSchema,
  WORKSPACE_ADMIN_INVITATIONS_TEMPLATE,
} from "@opentag/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { createUserAuthPreHandler } from "../plugins/user-auth.js";
import type { UserAuthService } from "../services/auth/index.js";
import type { InvitationService } from "../services/invitations/index.js";
import { parseRequest } from "./request-validation.js";

const WorkspaceParamsSchema = z.object({ workspaceId: z.string().uuid() }).strict();
const InvitationParamsSchema = z.object({ token: z.string().min(1).max(512) }).strict();

function accountId(request: FastifyRequest): string {
  const value = request.authContext?.me.user.id;
  if (!value) throw new Error("Authenticated Account context is missing");
  return value;
}

export function registerInvitationRoutes(
  app: FastifyInstance,
  authService: UserAuthService,
  invitationService: InvitationService,
  publicOrigin?: string,
): void {
  const preHandler = createUserAuthPreHandler(authService, { publicOrigin });

  app.post(WORKSPACE_ADMIN_INVITATIONS_TEMPLATE, { preHandler }, async (request, reply) => {
    const { workspaceId } = parseRequest(WorkspaceParamsSchema, request.params);
    return reply
      .header("Cache-Control", "no-store")
      .code(201)
      .send(AdminInvitationSchema.parse(await invitationService.create(accountId(request), workspaceId)));
  });

  app.get(ADMIN_INVITATION_PREVIEW_TEMPLATE, async (request, reply) => {
    const { token } = parseRequest(InvitationParamsSchema, request.params);
    return reply.code(200).send(InvitationPreviewSchema.parse(await invitationService.preview(token)));
  });

  app.post(ADMIN_INVITATION_ACCEPT_TEMPLATE, { preHandler }, async (request, reply) => {
    const { token } = parseRequest(InvitationParamsSchema, request.params);
    return reply
      .code(200)
      .send(InvitationAcceptanceResponseSchema.parse(await invitationService.accept(accountId(request), token)));
  });
}
