import {
  ACCOUNT_AGENT_CREATION_INTENT_TEMPLATE,
  ACCOUNT_COMPUTER_CONNECT_CODE_TEMPLATE,
  ACCOUNT_SANDBOX_RUNNER_ACCEPTANCE_TEMPLATE,
  ACCOUNT_SANDBOX_RUNNER_START_TEMPLATE,
  ACCOUNT_SANDBOX_RUNNER_STOP_TEMPLATE,
  ACCOUNT_SANDBOX_RUNNER_TEMPLATE,
  ACCOUNT_SANDBOX_TEMPLATE,
  AccountCloudComputerEnsureResponseSchema,
  AccountComputerConnectCodeIssueRequestSchema,
  AccountSandboxEnsureRequestSchema,
  AccountSandboxResponseSchema,
  AccountSandboxRunnerAcceptanceRequestSchema,
  AccountSandboxRunnerAcceptanceResponseSchema,
  AccountSandboxRunnerStatusResponseSchema,
  AccountSandboxRunnerStopRequestSchema,
  AccountSetupCompletionSchema,
  AccountSetupResetRequestSchema,
  AgentAdminConfigSchema,
  AgentCreationIntentIdSchema,
  AgentCreationIntentResultSchema,
  type ChannelName,
  CLOUD_IDENTITY_CAPABILITY_HEADER,
  CompleteAccountSetupRequestSchema,
  ComputerConnectCodeIssueResponseSchema,
  ComputerConnectCodeStatusSchema,
  CreateAgentRequestSchema,
  HTTP_PATHS,
  type InternalNavigationVisibility,
  InternalNavigationVisibilitySchema,
  type ListAccountComputersResponse,
  ListAccountComputersResponseSchema,
  ListAgentsResponseSchema,
  ListTasksResponseSchema,
  negotiateProviderReadinessFromHeaders,
  type RuntimeProviderReadinessNegotiation,
  requestsCloudIdentityV1,
  TASK_BY_ID_TEMPLATE,
  TASK_CANCEL_TEMPLATE,
  TaskCancelResponseSchema,
  TaskDetailSchema,
  TaskTitleUpdateRequestSchema,
  TaskTitleUpdateResponseSchema,
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
import { SERVER_ADMITTED_AGENT_RUNTIME_PROVIDERS } from "../services/runtime-config/index.js";
import type { SandboxService } from "../services/sandboxes/index.js";
import type { SandboxRunnerService } from "../services/sandboxes/sandbox-runner-service.js";
import type { AccountSetupService } from "../services/setup/index.js";
import type { TaskService } from "../services/tasks/index.js";
import {
  projectListAccountComputersResponseForHttp,
  requestIncludesProviderCliReasonV2,
} from "./provider-cli-reason.js";
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
const CreationIntentParamsSchema = z.object({ creationIntentId: AgentCreationIntentIdSchema }).strict();
const SandboxParamsSchema = z.object({ sandboxId: z.string().uuid() }).strict();
const EmptyBodySchema = z.object({}).strict();

export interface AccountRoutesOptions {
  agentService?: AgentService;
  computerConnectCode?: { downloadBaseUrl: string; environment: ChannelName; publicUrl: string };
  computerService?: ComputerService;
  sandboxService?: SandboxService;
  sandboxRunnerService?: SandboxRunnerService;
  machineAuthService?: MachineAuthService;
  authOptions?: UserAuthPreHandlerOptions;
  /**
   * Undoing setup so onboarding can be walked again. The environment decides whether it exists: the
   * routes are registered only where the service is supplied, and each one re-checks `enabled`
   * before doing anything, so a deployment that has the routes but not the feature answers exactly
   * like one that never registered them.
   */
  setupResetService?: AccountSetupResetService;
  /** Process-wide preview state; absent everywhere the internal tools are absent. */
  internalNavigationService?: InternalNavigationVisibilityService | undefined;
  taskService?: TaskService;
  accountSetupService?: AccountSetupService;
}

/** The two ways to undo setup. Both act on the authenticated Account and never a chosen one. */
export interface AccountSetupResetService {
  /** Whether this deployment offers the reset; production always refuses it. */
  readonly enabled: boolean;
  reboard(accountId: string): Promise<void>;
  resetOnboarding(accountId: string): Promise<void>;
}

export interface InternalNavigationVisibilityService {
  read(): InternalNavigationVisibility;
  update(value: InternalNavigationVisibility): InternalNavigationVisibility;
}

function accountId(request: FastifyRequest): string {
  const value = request.authContext?.me.user.id;
  if (!value) throw new Error("Authenticated Account context is missing");
  return value;
}

/**
 * Account-native management collections. Ownership comes only from the authenticated Account; clients
 * cannot select another authority scope.
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

    app.get(ACCOUNT_AGENT_CREATION_INTENT_TEMPLATE, { preHandler }, async (request, reply) => {
      const { creationIntentId } = parseRequest(CreationIntentParamsSchema, request.params);
      const result = await agentService.getCreationIntentResultForAccount(accountId(request), creationIntentId);
      return reply.header("Cache-Control", "no-store").code(200).send(AgentCreationIntentResultSchema.parse(result));
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

    /*
     * Withdraws a Task that is still waiting in the queue. The service refuses anything that is not
     * queued with 409, so a caller whose Task started in the meantime learns to re-read it rather
     * than believing it stopped something.
     */
    app.post(TASK_CANCEL_TEMPLATE, { preHandler }, async (request, reply) => {
      const { sessionId } = parseRequest(TaskParamsSchema, request.params);
      const response = TaskCancelResponseSchema.parse({
        task: await taskService.cancel(accountId(request), sessionId),
      });
      return reply.header("Cache-Control", "no-store").code(200).send(response);
    });
  }

  if (options.computerService) {
    const computerService = options.computerService;

    app.get(HTTP_PATHS.accountComputers, { preHandler }, async (request, reply) => {
      const account = accountId(request);
      const readiness = negotiateProviderReadinessFromHeaders(request.headers, SERVER_ADMITTED_AGENT_RUNTIME_PROVIDERS);
      const includeCloudIdentities = requestsCloudIdentityV1(request.headers[CLOUD_IDENTITY_CAPABILITY_HEADER]);
      const listed = await computerService.listAccountComputers(
        account,
        readiness !== undefined,
        includeCloudIdentities,
      );
      return reply
        .code(200)
        .send(
          ListAccountComputersResponseSchema.parse(
            projectAccountComputerProviderReadinessForHttp(
              projectListAccountComputersResponseForHttp(listed, requestIncludesProviderCliReasonV2(request)),
              readiness,
            ),
          ),
        );
    });

    app.put(HTTP_PATHS.accountCloudComputer, { preHandler }, async (request, reply) => {
      parseRequest(EmptyBodySchema, request.body ?? {});
      const ensured = await computerService.ensureCloudComputerForAccount(accountId(request));
      return reply
        .header("Cache-Control", "no-store")
        .code(200)
        .send(AccountCloudComputerEnsureResponseSchema.parse(ensured));
    });
  }

  if (options.sandboxService) {
    const sandboxService = options.sandboxService;

    app.post(HTTP_PATHS.accountSandboxes, { preHandler }, async (request, reply) => {
      const input = parseRequest(AccountSandboxEnsureRequestSchema, request.body);
      const ensured = await sandboxService.ensureForAccount(accountId(request), input);
      return reply.header("Cache-Control", "no-store").code(200).send(AccountSandboxResponseSchema.parse(ensured));
    });

    app.get(ACCOUNT_SANDBOX_TEMPLATE, { preHandler }, async (request, reply) => {
      const { sandboxId } = parseRequest(SandboxParamsSchema, request.params);
      const sandbox = await sandboxService.getForAccount(accountId(request), sandboxId);
      return reply.header("Cache-Control", "no-store").code(200).send(AccountSandboxResponseSchema.parse(sandbox));
    });
  }

  if (options.sandboxRunnerService) {
    const sandboxRunnerService = options.sandboxRunnerService;

    app.post(ACCOUNT_SANDBOX_RUNNER_START_TEMPLATE, { preHandler }, async (request, reply) => {
      const { sandboxId } = parseRequest(SandboxParamsSchema, request.params);
      parseRequest(EmptyBodySchema, request.body ?? {});
      const status = await sandboxRunnerService.startForAccount(accountId(request), sandboxId);
      return reply
        .header("Cache-Control", "no-store")
        .code(200)
        .send(AccountSandboxRunnerStatusResponseSchema.parse(status));
    });

    app.get(ACCOUNT_SANDBOX_RUNNER_TEMPLATE, { preHandler }, async (request, reply) => {
      const { sandboxId } = parseRequest(SandboxParamsSchema, request.params);
      const status = await sandboxRunnerService.statusForAccount(accountId(request), sandboxId);
      return reply
        .header("Cache-Control", "no-store")
        .code(200)
        .send(AccountSandboxRunnerStatusResponseSchema.parse(status));
    });

    app.post(ACCOUNT_SANDBOX_RUNNER_STOP_TEMPLATE, { preHandler }, async (request, reply) => {
      const { sandboxId } = parseRequest(SandboxParamsSchema, request.params);
      const input = parseRequest(AccountSandboxRunnerStopRequestSchema, request.body ?? {});
      const status = await sandboxRunnerService.stopForAccount(accountId(request), sandboxId, input);
      return reply
        .header("Cache-Control", "no-store")
        .code(200)
        .send(AccountSandboxRunnerStatusResponseSchema.parse(status));
    });

    /*
     * Explicit bounded acceptance. The caller's disconnect cancels the run on the Runner; the
     * response is the correlated structured report only — request piConfig is never echoed,
     * logged, or persisted.
     */
    app.post(ACCOUNT_SANDBOX_RUNNER_ACCEPTANCE_TEMPLATE, { preHandler }, async (request, reply) => {
      const { sandboxId } = parseRequest(SandboxParamsSchema, request.params);
      const input = parseRequest(AccountSandboxRunnerAcceptanceRequestSchema, request.body);
      /*
       * Cancellation is driven by the RESPONSE closing before it finished, not by the request.
       * Node fires IncomingMessage 'close' when a normal request body completes, so hooking the
       * request would cancel every successful POST; the response only closes early on a real
       * client disconnect. Listeners are always removed, and a finished response never aborts.
       */
      const abort = new AbortController();
      const response = reply.raw;
      const onResponseClose = () => {
        if (!response.writableFinished) abort.abort();
      };
      response.on("close", onResponseClose);
      try {
        const result = await sandboxRunnerService.runAcceptanceForAccount(accountId(request), sandboxId, input, {
          signal: abort.signal,
        });
        return reply
          .header("Cache-Control", "no-store")
          .code(200)
          .send(AccountSandboxRunnerAcceptanceResponseSchema.parse(result));
      } finally {
        response.off("close", onResponseClose);
      }
    });
  }

  if (options.machineAuthService && options.computerConnectCode) {
    const machineAuthService = options.machineAuthService;
    const { downloadBaseUrl, environment, publicUrl } = options.computerConnectCode;

    app.post(HTTP_PATHS.accountComputerConnectCodes, { preHandler }, async (request, reply) => {
      const input = parseRequest(AccountComputerConnectCodeIssueRequestSchema, request.body ?? {});
      const issued = await machineAuthService.issueForAccount(accountId(request), input);
      return reply
        .header("Cache-Control", "no-store")
        .code(201)
        .send(
          ComputerConnectCodeIssueResponseSchema.parse({
            connectCodeId: issued.connectCodeId,
            bootstrapCommand: buildComputerConnectCommand({
              code: issued.code,
              downloadBaseUrl,
              environment,
              publicUrl,
            }),
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

  if (options.accountSetupService) {
    const accountSetupService = options.accountSetupService;

    app.post(HTTP_PATHS.accountSetupComplete, { preHandler }, async (request, reply) => {
      const { agentId } = parseRequest(CompleteAccountSetupRequestSchema, request.body);
      return reply
        .code(200)
        .send(
          AccountSetupCompletionSchema.parse(await accountSetupService.completeForAccount(accountId(request), agentId)),
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
     * Reachability is the whole answer a client needs: without Internal tools the reset is absent
     * rather than closed, so a deployment that does not offer it is indistinguishable from one that
     * never had it. A caller asks this before offering the operations, rather than discovering the answer
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

  if (options.internalNavigationService) {
    const internalNavigationService = options.internalNavigationService;

    app.get(HTTP_PATHS.internalNavigationVisibility, { preHandler }, async (_request, reply) =>
      reply
        .header("Cache-Control", "no-store")
        .code(200)
        .send(InternalNavigationVisibilitySchema.parse(internalNavigationService.read())),
    );

    app.put(HTTP_PATHS.internalNavigationVisibility, { preHandler }, async (request, reply) => {
      const input = parseRequest(InternalNavigationVisibilitySchema, request.body);
      return reply
        .header("Cache-Control", "no-store")
        .code(200)
        .send(InternalNavigationVisibilitySchema.parse(internalNavigationService.update(input)));
    });
  }
}

function resetNotOffered(): AuthServiceError {
  return new AuthServiceError("RESOURCE_NOT_FOUND", "deterministic", "The requested resource was not found", 404);
}

function projectAccountComputerProviderReadinessForHttp(
  response: ListAccountComputersResponse,
  readiness: RuntimeProviderReadinessNegotiation | undefined,
): ListAccountComputersResponse {
  const providers = new Set(readiness?.providers);
  return {
    computers: response.computers.map((computer) => {
      const { providerReadiness, ...rest } = computer;
      if (!readiness || providerReadiness === undefined) return rest;
      return {
        ...rest,
        providerReadiness: providerReadiness.filter((observation) => providers.has(observation.provider)),
      };
    }),
  };
}
