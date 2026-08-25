import {
  CompleteWorkspaceSetupRequestSchema,
  CreateWorkspaceRequestSchema,
  CreateWorkspaceResponseSchema,
  ListWorkspaceAdminsResponseSchema,
  ListWorkspaceComputersResponseSchema,
  PROVIDER_READINESS_V1_HEADER,
  UpdateWorkspaceProfileRequestSchema,
  WORKSPACE_ADMIN_TEMPLATE,
  WORKSPACE_ADMINS_TEMPLATE,
  WORKSPACE_BY_ID_TEMPLATE,
  WORKSPACE_COMPUTERS_TEMPLATE,
  WORKSPACE_SETUP_COMPLETE_TEMPLATE,
  WORKSPACES_TEMPLATE,
  WorkspaceProfileSchema,
  WorkspaceSetupCompletionSchema,
} from "@opentag/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { createUserAuthPreHandler } from "../plugins/user-auth.js";
import type { UserAuthService } from "../services/auth/index.js";
import type { WorkspaceAdminService, WorkspaceSetupService } from "../services/workspaces/index.js";
import { parseRequest } from "./request-validation.js";

const WorkspaceParamsSchema = z.object({ workspaceId: z.string().uuid() }).strict();
const AdminParamsSchema = z.object({ workspaceId: z.string().uuid(), accountId: z.string().uuid() }).strict();

function accountId(request: FastifyRequest): string {
  const value = request.authContext?.me.user.id;
  if (!value) throw new Error("Authenticated Account context is missing");
  return value;
}

export function registerWorkspaceRoutes(
  app: FastifyInstance,
  authService: UserAuthService,
  workspaceService: WorkspaceAdminService,
  publicOrigin?: string,
  workspaceSetupService?: WorkspaceSetupService,
): void {
  const preHandler = createUserAuthPreHandler(authService, { publicOrigin });

  app.post(WORKSPACES_TEMPLATE, { preHandler }, async (request, reply) => {
    const input = parseRequest(CreateWorkspaceRequestSchema, request.body);
    return reply
      .code(201)
      .send(CreateWorkspaceResponseSchema.parse(await workspaceService.createWorkspace(accountId(request), input)));
  });

  app.get(WORKSPACE_BY_ID_TEMPLATE, { preHandler }, async (request, reply) => {
    const { workspaceId } = parseRequest(WorkspaceParamsSchema, request.params);
    return reply
      .code(200)
      .send(WorkspaceProfileSchema.parse(await workspaceService.getWorkspaceProfile(accountId(request), workspaceId)));
  });

  app.patch(WORKSPACE_BY_ID_TEMPLATE, { preHandler }, async (request, reply) => {
    const { workspaceId } = parseRequest(WorkspaceParamsSchema, request.params);
    const input = parseRequest(UpdateWorkspaceProfileRequestSchema, request.body);
    return reply
      .code(200)
      .send(
        WorkspaceProfileSchema.parse(
          await workspaceService.updateWorkspaceProfile(accountId(request), workspaceId, input),
        ),
      );
  });

  if (workspaceSetupService) {
    app.post(WORKSPACE_SETUP_COMPLETE_TEMPLATE, { preHandler }, async (request, reply) => {
      const { workspaceId } = parseRequest(WorkspaceParamsSchema, request.params);
      const { agentId } = parseRequest(CompleteWorkspaceSetupRequestSchema, request.body);
      return reply
        .code(200)
        .send(
          WorkspaceSetupCompletionSchema.parse(
            await workspaceSetupService.complete(accountId(request), workspaceId, agentId),
          ),
        );
    });
  }

  app.get(WORKSPACE_ADMINS_TEMPLATE, { preHandler }, async (request, reply) => {
    const { workspaceId } = parseRequest(WorkspaceParamsSchema, request.params);
    return reply
      .code(200)
      .send(
        ListWorkspaceAdminsResponseSchema.parse(await workspaceService.listAdmins(accountId(request), workspaceId)),
      );
  });

  app.delete(WORKSPACE_ADMIN_TEMPLATE, { preHandler }, async (request, reply) => {
    const { workspaceId, accountId: targetAccountId } = parseRequest(AdminParamsSchema, request.params);
    await workspaceService.revokeAdmin(accountId(request), workspaceId, targetAccountId);
    return reply.code(204).send();
  });

  app.get(WORKSPACE_COMPUTERS_TEMPLATE, { preHandler }, async (request, reply) => {
    const { workspaceId } = parseRequest(WorkspaceParamsSchema, request.params);
    return reply
      .code(200)
      .send(
        ListWorkspaceComputersResponseSchema.parse(
          await workspaceService.listComputers(
            accountId(request),
            workspaceId,
            request.headers[PROVIDER_READINESS_V1_HEADER] === "1",
          ),
        ),
      );
  });
}
