import {
  CompleteWorkspaceSetupRequestSchema,
  ListWorkspaceComputersResponseSchema,
  PROVIDER_READINESS_V1_HEADER,
  WORKSPACE_COMPUTERS_TEMPLATE,
  WORKSPACE_SETUP_COMPLETE_TEMPLATE,
  WorkspaceSetupCompletionSchema,
} from "@opentag/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { createUserAuthPreHandler, type UserAuthPreHandlerOptions } from "../plugins/user-auth.js";
import type { UserAuthService } from "../services/auth/index.js";
import type { WorkspaceAdminService, WorkspaceSetupService } from "../services/workspaces/index.js";
import { parseRequest } from "./request-validation.js";

const WorkspaceParamsSchema = z.object({ workspaceId: z.string().uuid() }).strict();

function accountId(request: FastifyRequest): string {
  const value = request.authContext?.me.user.id;
  if (!value) throw new Error("Authenticated Account context is missing");
  return value;
}

export function registerWorkspaceRoutes(
  app: FastifyInstance,
  authService: UserAuthService,
  workspaceService: WorkspaceAdminService,
  authOptions?: UserAuthPreHandlerOptions,
  workspaceSetupService?: WorkspaceSetupService,
): void {
  const preHandler = createUserAuthPreHandler(authService, authOptions ?? {});

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
