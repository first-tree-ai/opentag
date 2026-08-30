import {
  AccountComputerConnectCodeIssueRequestSchema,
  AgentAdminConfigSchema,
  type ChannelName,
  CompleteWorkspaceSetupRequestSchema,
  ComputerConnectCodeIssueResponseSchema,
  CreateAgentRequestSchema,
  HTTP_PATHS,
  ListAgentsResponseSchema,
  ListTasksResponseSchema,
  ListWorkspaceComputersResponseSchema,
  PROVIDER_READINESS_V1_HEADER,
  TASK_BY_ID_TEMPLATE,
  TaskDetailSchema,
  WorkspaceSetupCompletionSchema,
} from "@opentag/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { createUserAuthPreHandler, type UserAuthPreHandlerOptions } from "../plugins/user-auth.js";
import type { AgentService } from "../services/agents/index.js";
import type { UserAuthService } from "../services/auth/index.js";
import { buildComputerConnectCommand, type MachineAuthService } from "../services/computers/index.js";
import type { TaskService } from "../services/tasks/index.js";
import type { WorkspaceAdminService, WorkspaceSetupService } from "../services/workspaces/index.js";
import { parseRequest } from "./request-validation.js";

const TaskListQuerySchema = z
  .object({
    agentId: z.string().uuid().optional(),
    cursor: z.string().min(1).max(1024).optional(),
    kind: z.enum(["channel", "thread"]).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();
const TaskDetailQuerySchema = z
  .object({
    cursor: z.string().min(1).max(1024).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();
const TaskParamsSchema = z.object({ sessionId: z.string().uuid() }).strict();

/**
 * Resolves the authenticated Account to the compatibility Workspace that still backs hidden dual-write
 * persistence. Canonical Account resource authority uses `created_by_user_id` and `owner_account_id`.
 */
export interface AccountScopeResolver {
  resolveCompatibilityWorkspaceId(accountId: string): Promise<string>;
}

export interface AccountRoutesOptions {
  accountScope?: AccountScopeResolver;
  agentService?: AgentService;
  computerConnectCode?: { environment: ChannelName; publicUrl: string };
  machineAuthService?: MachineAuthService;
  authOptions?: UserAuthPreHandlerOptions;
  taskService?: TaskService;
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
  const preHandler = createUserAuthPreHandler(authService, options.authOptions ?? {});
  const { accountScope } = options;

  if (options.agentService) {
    const agentService = options.agentService;

    app.post(HTTP_PATHS.accountAgents, { preHandler }, async (request, reply) => {
      const input = parseRequest(CreateAgentRequestSchema, request.body);
      const account = accountId(request);
      return reply.code(201).send(AgentAdminConfigSchema.parse(await agentService.createForAccount(account, input)));
    });

    app.get(HTTP_PATHS.accountAgents, { preHandler }, async (request, reply) => {
      const account = accountId(request);
      return reply.code(200).send(ListAgentsResponseSchema.parse(await agentService.listForAccount(account)));
    });
  }

  if (options.taskService) {
    const taskService = options.taskService;

    app.get(HTTP_PATHS.accountTasks, { preHandler }, async (request, reply) => {
      const query = parseRequest(TaskListQuerySchema, request.query);
      const response = ListTasksResponseSchema.parse(await taskService.list(accountId(request), query));
      return reply.header("Cache-Control", "no-store").code(200).send(response);
    });

    app.get(TASK_BY_ID_TEMPLATE, { preHandler }, async (request, reply) => {
      const { sessionId } = parseRequest(TaskParamsSchema, request.params);
      const query = parseRequest(TaskDetailQuerySchema, request.query);
      const response = TaskDetailSchema.parse(await taskService.get(accountId(request), sessionId, query));
      return reply.header("Cache-Control", "no-store").code(200).send(response);
    });
  }

  if (options.workspaceService) {
    const workspaceService = options.workspaceService;

    app.get(HTTP_PATHS.accountComputers, { preHandler }, async (request, reply) => {
      const account = accountId(request);
      return reply
        .code(200)
        .send(
          ListWorkspaceComputersResponseSchema.parse(
            await workspaceService.listAccountComputers(account, request.headers[PROVIDER_READINESS_V1_HEADER] === "1"),
          ),
        );
    });
  }

  if (options.machineAuthService && options.computerConnectCode) {
    const machineAuthService = options.machineAuthService;
    const { environment, publicUrl } = options.computerConnectCode;

    app.post(HTTP_PATHS.accountComputerConnectCodes, { preHandler }, async (request, reply) => {
      const input = parseRequest(AccountComputerConnectCodeIssueRequestSchema, request.body ?? {});
      const account = accountId(request);
      const issued =
        input.mode === "repair"
          ? await machineAuthService.issueForAccount(account, input)
          : await machineAuthService.issueForAccount(
              account,
              input,
              await accountScope?.resolveCompatibilityWorkspaceId(account),
            );
      return reply
        .header("Cache-Control", "no-store")
        .code(201)
        .send(
          ComputerConnectCodeIssueResponseSchema.parse({
            bootstrapCommand: buildComputerConnectCommand({ code: issued.code, environment, publicUrl }),
            expiresIn: issued.expiresIn,
            issuedAt: issued.issuedAt.toISOString(),
            mode: issued.mode,
          }),
        );
    });
  }

  if (options.workspaceSetupService) {
    const workspaceSetupService = options.workspaceSetupService;

    app.post(HTTP_PATHS.accountSetupComplete, { preHandler }, async (request, reply) => {
      const { agentId } = parseRequest(CompleteWorkspaceSetupRequestSchema, request.body);
      return reply
        .code(200)
        .send(
          WorkspaceSetupCompletionSchema.parse(
            await workspaceSetupService.completeForAccount(accountId(request), agentId),
          ),
        );
    });
  }
}
