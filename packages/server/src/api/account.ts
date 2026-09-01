import {
  ACCOUNT_COMPUTER_BY_ID_TEMPLATE,
  ACCOUNT_COMPUTER_CONNECT_CODE_TEMPLATE,
  AccountComputerConnectCodeIssueRequestSchema,
  AccountSetupResetRequestSchema,
  AgentAdminConfigSchema,
  type ChannelName,
  CompleteWorkspaceSetupRequestSchema,
  ComputerConnectCodeIssueResponseSchema,
  ComputerConnectCodeStatusSchema,
  CreateAgentRequestSchema,
  HTTP_PATHS,
  ListAgentsResponseSchema,
  ListTasksResponseSchema,
  ListWorkspaceComputersResponseSchema,
  PROVIDER_READINESS_V1_HEADER,
  TASK_BY_ID_TEMPLATE,
  TaskDetailSchema,
  TaskTitleUpdateRequestSchema,
  TaskTitleUpdateResponseSchema,
  WorkspaceSetupCompletionSchema,
} from "@opentag/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { createUserAuthPreHandler, type UserAuthPreHandlerOptions } from "../plugins/user-auth.js";
import type { AgentService } from "../services/agents/index.js";
import { AuthServiceError, type UserAuthService } from "../services/auth/index.js";
import {
  buildComputerConnectCommand,
  type ComputerService,
  type MachineAuthService,
} from "../services/computers/index.js";
import type { TaskService } from "../services/tasks/index.js";
import type { WorkspaceSetupService } from "../services/workspaces/index.js";
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
const ConnectCodeParamsSchema = z.object({ connectCodeId: z.string().uuid() }).strict();
const ComputerParamsSchema = z.object({ computerId: z.string().uuid() }).strict();

export interface AccountRoutesOptions {
  agentService?: AgentService;
  computerConnectCode?: { environment: ChannelName; publicUrl: string };
  computerService?: ComputerService;
  machineAuthService?: MachineAuthService;
  authOptions?: UserAuthPreHandlerOptions;
  /**
   * Undoing setup so onboarding can be walked again. Staging decides whether it exists at all: the
   * routes are registered only where the service is supplied, and each one re-checks `enabled`
   * before doing anything, so a deployment that has the routes but not the feature answers exactly
   * like one that never registered them.
   */
  setupResetService?: AccountSetupResetService;
  taskService?: TaskService;
  workspaceSetupService?: WorkspaceSetupService;
}

/** The two ways to undo setup. Both act on the authenticated Account and never a chosen one. */
export interface AccountSetupResetService {
  /** Whether this deployment offers the reset at all; false outside staging. */
  readonly enabled: boolean;
  reboard(accountId: string): Promise<void>;
  resetOnboarding(accountId: string): Promise<void>;
}

function accountId(request: FastifyRequest): string {
  const value = request.authContext?.me.user.id;
  if (!value) throw new Error("Authenticated Account context is missing");
  return value;
}

/**
 * Account-native management collections. Ownership comes only from the authenticated Account: these routes
 * accept neither a management `workspaceId` nor a client-selected `accountId`.
 */
export function registerAccountRoutes(
  app: FastifyInstance,
  authService: UserAuthService,
  options: AccountRoutesOptions,
): void {
  const preHandler = createUserAuthPreHandler(authService, options.authOptions ?? {});

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

    app.patch(TASK_BY_ID_TEMPLATE, { preHandler }, async (request, reply) => {
      const { sessionId } = parseRequest(TaskParamsSchema, request.params);
      const input = parseRequest(TaskTitleUpdateRequestSchema, request.body);
      const response = TaskTitleUpdateResponseSchema.parse({
        task: await taskService.updateTitle(accountId(request), sessionId, input.title),
      });
      return reply.header("Cache-Control", "no-store").code(200).send(response);
    });

    app.get(TASK_BY_ID_TEMPLATE, { preHandler }, async (request, reply) => {
      const { sessionId } = parseRequest(TaskParamsSchema, request.params);
      const query = parseRequest(TaskDetailQuerySchema, request.query);
      const response = TaskDetailSchema.parse(await taskService.get(accountId(request), sessionId, query));
      return reply.header("Cache-Control", "no-store").code(200).send(response);
    });
  }

  if (options.computerService) {
    const computerService = options.computerService;

    app.get(HTTP_PATHS.accountComputers, { preHandler }, async (request, reply) => {
      const account = accountId(request);
      return reply
        .code(200)
        .send(
          ListWorkspaceComputersResponseSchema.parse(
            await computerService.listAccountComputers(account, request.headers[PROVIDER_READINESS_V1_HEADER] === "1"),
          ),
        );
    });

    app.delete(ACCOUNT_COMPUTER_BY_ID_TEMPLATE, { preHandler }, async (request, reply) => {
      const { computerId } = parseRequest(ComputerParamsSchema, request.params);
      await computerService.removeFromAccount(accountId(request), computerId);
      return reply.code(204).send();
    });
  }

  if (options.machineAuthService && options.computerConnectCode) {
    const machineAuthService = options.machineAuthService;
    const { environment, publicUrl } = options.computerConnectCode;

    app.post(HTTP_PATHS.accountComputerConnectCodes, { preHandler }, async (request, reply) => {
      const input = parseRequest(AccountComputerConnectCodeIssueRequestSchema, request.body ?? {});
      const issued = await machineAuthService.issueForAccount(accountId(request), input);
      return reply
        .header("Cache-Control", "no-store")
        .code(201)
        .send(
          ComputerConnectCodeIssueResponseSchema.parse({
            connectCodeId: issued.connectCodeId,
            bootstrapCommand: buildComputerConnectCommand({ code: issued.code, environment, publicUrl }),
            expiresIn: issued.expiresIn,
            issuedAt: issued.issuedAt.toISOString(),
            mode: issued.mode,
          }),
        );
    });

    /*
     * The pollable correlation for a code this Account issued: pending until redemption, the exact
     * Computer after it. The id in the path is the only thing named, and ownership is checked
     * against the token's Account — a foreign id is indistinguishable from one that never existed.
     */
    app.get(ACCOUNT_COMPUTER_CONNECT_CODE_TEMPLATE, { preHandler }, async (request, reply) => {
      const { connectCodeId } = parseRequest(ConnectCodeParamsSchema, request.params);
      const status = await machineAuthService.getConnectCodeStatusForAccount(accountId(request), connectCodeId);
      return reply.header("Cache-Control", "no-store").code(200).send(ComputerConnectCodeStatusSchema.parse(status));
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

  if (options.setupResetService) {
    const setupResetService = options.setupResetService;

    /*
     * Reflexive by construction: the Account comes from the access token, and the body carries only
     * how much to undo. There is no field here that could name somebody else's Account, which is
     * what makes this safe to offer to every signed-in tester rather than to administrators.
     */
    /*
     * Reachability is the whole answer a client needs: outside staging the reset is absent rather
     * than closed, so a deployment that does not offer it is indistinguishable from one that never
     * had it. A caller asks this before offering the operations, rather than discovering the answer
     * by attempting one.
     */
    app.get(HTTP_PATHS.accountSetupReset, { preHandler }, async (_request, reply) => {
      if (!setupResetService.enabled) throw resetNotOffered();
      return reply.code(204).send();
    });

    app.post(HTTP_PATHS.accountSetupReset, { preHandler }, async (request, reply) => {
      // Checked before the body is read, so a malformed request cannot tell a deployment that has
      // the route but not the feature apart from one that never registered it.
      if (!setupResetService.enabled) throw resetNotOffered();
      const { mode } = parseRequest(AccountSetupResetRequestSchema, request.body);
      const account = accountId(request);
      if (mode === "all") await setupResetService.resetOnboarding(account);
      else await setupResetService.reboard(account);
      return reply.code(204).send();
    });
  }
}

function resetNotOffered(): AuthServiceError {
  return new AuthServiceError("RESOURCE_NOT_FOUND", "deterministic", "The requested resource was not found", 404);
}
