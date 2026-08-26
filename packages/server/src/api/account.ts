import {
  AgentAdminConfigSchema,
  type ChannelName,
  CompleteWorkspaceSetupRequestSchema,
  ComputerConnectCodeIssueResponseSchema,
  CreateAgentRequestSchema,
  HTTP_PATHS,
  ListAgentsResponseSchema,
  ListWorkspaceComputersResponseSchema,
  PROVIDER_READINESS_V1_HEADER,
  WorkspaceSetupCompletionSchema,
} from "@opentag/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { createUserAuthPreHandler } from "../plugins/user-auth.js";
import type { AgentService } from "../services/agents/index.js";
import type { UserAuthService } from "../services/auth/index.js";
import { buildComputerConnectCommand, type MachineAuthService } from "../services/computers/index.js";
import type { WorkspaceAdminService, WorkspaceSetupService } from "../services/workspaces/index.js";
import { parseRequest } from "./request-validation.js";

/**
 * Resolves the authenticated Account to the compatibility Workspace that still backs management storage.
 * `WorkspaceAdminAccess` is the only implementation; the seam exists so that removing it is a single
 * deletion once Agents and enrollments carry a direct Account owner.
 */
export interface AccountScopeResolver {
  resolveCompatibilityWorkspaceId(accountId: string): Promise<string>;
}

export interface AccountRoutesOptions {
  accountScope: AccountScopeResolver;
  agentService?: AgentService;
  computerConnectCode?: { environment: ChannelName; publicUrl: string };
  machineAuthService?: MachineAuthService;
  publicOrigin?: string;
  workspaceService?: WorkspaceAdminService;
  workspaceSetupService?: WorkspaceSetupService;
}

function accountId(request: FastifyRequest): string {
  const value = request.authContext?.me.user.id;
  if (!value) throw new Error("Authenticated Account context is missing");
  return value;
}

/**
 * Account-native management collections. Ownership comes only from the authenticated Account: these routes
 * accept neither a management `workspaceId` nor a client-selected `accountId`, and the legacy
 * Workspace-scoped routes stay registered alongside them for the compatibility window.
 */
export function registerAccountRoutes(
  app: FastifyInstance,
  authService: UserAuthService,
  options: AccountRoutesOptions,
): void {
  const preHandler = createUserAuthPreHandler(authService, { publicOrigin: options.publicOrigin });
  const { accountScope } = options;

  async function scopeOf(request: FastifyRequest): Promise<{ accountId: string; workspaceId: string }> {
    const account = accountId(request);
    return { accountId: account, workspaceId: await accountScope.resolveCompatibilityWorkspaceId(account) };
  }

  if (options.agentService) {
    const agentService = options.agentService;

    app.post(HTTP_PATHS.accountAgents, { preHandler }, async (request, reply) => {
      const input = parseRequest(CreateAgentRequestSchema, request.body);
      const scope = await scopeOf(request);
      return reply
        .code(201)
        .send(
          AgentAdminConfigSchema.parse(
            await agentService.createForWorkspace(scope.accountId, scope.workspaceId, input),
          ),
        );
    });

    app.get(HTTP_PATHS.accountAgents, { preHandler }, async (request, reply) => {
      const scope = await scopeOf(request);
      return reply
        .code(200)
        .send(ListAgentsResponseSchema.parse(await agentService.listForWorkspace(scope.accountId, scope.workspaceId)));
    });
  }

  if (options.workspaceService) {
    const workspaceService = options.workspaceService;

    app.get(HTTP_PATHS.accountComputers, { preHandler }, async (request, reply) => {
      const scope = await scopeOf(request);
      return reply
        .code(200)
        .send(
          ListWorkspaceComputersResponseSchema.parse(
            await workspaceService.listComputers(
              scope.accountId,
              scope.workspaceId,
              request.headers[PROVIDER_READINESS_V1_HEADER] === "1",
            ),
          ),
        );
    });
  }

  if (options.machineAuthService && options.computerConnectCode) {
    const machineAuthService = options.machineAuthService;
    const { environment, publicUrl } = options.computerConnectCode;

    app.post(HTTP_PATHS.accountComputerConnectCodes, { preHandler }, async (request, reply) => {
      const scope = await scopeOf(request);
      const issued = await machineAuthService.issueForWorkspaceAdmin(scope.accountId, scope.workspaceId);
      return reply
        .header("Cache-Control", "no-store")
        .code(201)
        .send(
          ComputerConnectCodeIssueResponseSchema.parse({
            bootstrapCommand: buildComputerConnectCommand({ code: issued.code, environment, publicUrl }),
            expiresIn: issued.expiresIn,
            issuedAt: issued.issuedAt.toISOString(),
          }),
        );
    });
  }

  if (options.workspaceSetupService) {
    const workspaceSetupService = options.workspaceSetupService;

    app.post(HTTP_PATHS.accountSetupComplete, { preHandler }, async (request, reply) => {
      const { agentId } = parseRequest(CompleteWorkspaceSetupRequestSchema, request.body);
      const scope = await scopeOf(request);
      return reply
        .code(200)
        .send(
          WorkspaceSetupCompletionSchema.parse(
            await workspaceSetupService.complete(scope.accountId, scope.workspaceId, agentId),
          ),
        );
    });
  }
}
