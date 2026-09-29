import {
  AGENT_SCHEDULE_PAUSE_TEMPLATE,
  AGENT_SCHEDULE_RESUME_TEMPLATE,
  AGENT_SCHEDULE_TEMPLATE,
  AGENT_SCHEDULES_TEMPLATE,
  AgentScheduleDeleteQuerySchema,
  AgentScheduleListQuerySchema,
  AgentScheduleListResponseSchema,
  AgentSchedulePreviewSchema,
  AgentScheduleRevisionRequestSchema,
  AgentScheduleSchema,
  CreateAgentScheduleRequestSchema,
  PreviewAgentScheduleRequestSchema,
  RUNTIME_AGENT_SCHEDULE_PAUSE_TEMPLATE,
  RUNTIME_AGENT_SCHEDULE_PREVIEW_PATH,
  RUNTIME_AGENT_SCHEDULE_RESUME_TEMPLATE,
  RUNTIME_AGENT_SCHEDULE_TEMPLATE,
  RUNTIME_AGENT_SCHEDULES_PATH,
  SESSION_CLI_PROOF_HEADER,
  UpdateAgentScheduleRequestSchema,
} from "@opentag/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { createUserAuthPreHandler, type UserAuthPreHandlerOptions } from "../plugins/user-auth.js";
import type { UserAuthService } from "../services/auth/index.js";
import type { ScheduleService } from "../services/schedules/index.js";
import { parseRequest } from "./request-validation.js";

/*
 * Agent Schedule management routes.
 *
 * Two surfaces over one service:
 *
 * - `/api/v1/runtime/agent/schedules` — Session-proof authenticated. The proof authenticates
 *   BEFORE any body, params, or query are interpreted, and the proof's Agent is the only Agent
 *   reachable; the create target is resolved Server-side from the proof's Session, never from
 *   caller input. Full CRUD plus preview.
 * - `/api/v1/agents/:agentId/schedules` — Account authenticated, read/pause/resume/delete only.
 *   There is deliberately no Account create/update/preview route.
 *
 * Requests and responses are the strict shared schemas; responses are re-parsed on the way out so
 * a serialization drift fails closed instead of leaking an unexpected shape.
 */

export interface RuntimeAgentScheduleRoutesOptions {
  service: Pick<
    ScheduleService,
    | "authenticate"
    | "createForAgent"
    | "listForAgent"
    | "getForAgent"
    | "updateForAgent"
    | "pauseForAgent"
    | "resumeForAgent"
    | "deleteForAgent"
    | "previewForAgent"
  >;
}

export interface AccountAgentScheduleRoutesOptions {
  authOptions?: UserAuthPreHandlerOptions;
  service: Pick<
    ScheduleService,
    "listForAccount" | "getForAccount" | "pauseForAccount" | "resumeForAccount" | "deleteForAccount"
  >;
}

const ScheduleParamsSchema = z.object({ scheduleId: z.string().uuid() }).strict();
const AccountScheduleParamsSchema = z.object({ agentId: z.string().uuid(), scheduleId: z.string().uuid() }).strict();
const AccountAgentParamsSchema = z.object({ agentId: z.string().uuid() }).strict();

export function registerRuntimeAgentScheduleRoutes(
  app: FastifyInstance,
  options: RuntimeAgentScheduleRoutesOptions,
): void {
  const { service } = options;

  app.post(RUNTIME_AGENT_SCHEDULES_PATH, async (request, reply) => {
    const scope = await authenticate(request);
    const input = parseRequest(CreateAgentScheduleRequestSchema, request.body);
    const response = AgentScheduleSchema.parse(await service.createForAgent(scope, input));
    return reply.header("Cache-Control", "no-store").code(201).send(response);
  });

  app.get(RUNTIME_AGENT_SCHEDULES_PATH, async (request, reply) => {
    const scope = await authenticate(request);
    const query = parseRequest(AgentScheduleListQuerySchema, request.query);
    const response = AgentScheduleListResponseSchema.parse(await service.listForAgent(scope, query));
    return reply.header("Cache-Control", "no-store").code(200).send(response);
  });

  app.get(RUNTIME_AGENT_SCHEDULE_TEMPLATE, async (request, reply) => {
    const scope = await authenticate(request);
    const { scheduleId } = parseRequest(ScheduleParamsSchema, request.params);
    const response = AgentScheduleSchema.parse(await service.getForAgent(scope, scheduleId));
    return reply.header("Cache-Control", "no-store").code(200).send(response);
  });

  app.patch(RUNTIME_AGENT_SCHEDULE_TEMPLATE, async (request, reply) => {
    const scope = await authenticate(request);
    const { scheduleId } = parseRequest(ScheduleParamsSchema, request.params);
    const input = parseRequest(UpdateAgentScheduleRequestSchema, request.body);
    const response = AgentScheduleSchema.parse(await service.updateForAgent(scope, scheduleId, input));
    return reply.header("Cache-Control", "no-store").code(200).send(response);
  });

  app.post(RUNTIME_AGENT_SCHEDULE_PAUSE_TEMPLATE, async (request, reply) => {
    const scope = await authenticate(request);
    const { scheduleId } = parseRequest(ScheduleParamsSchema, request.params);
    const input = parseRequest(AgentScheduleRevisionRequestSchema, request.body);
    const response = AgentScheduleSchema.parse(await service.pauseForAgent(scope, scheduleId, input.expectedRevision));
    return reply.header("Cache-Control", "no-store").code(200).send(response);
  });

  app.post(RUNTIME_AGENT_SCHEDULE_RESUME_TEMPLATE, async (request, reply) => {
    const scope = await authenticate(request);
    const { scheduleId } = parseRequest(ScheduleParamsSchema, request.params);
    const input = parseRequest(AgentScheduleRevisionRequestSchema, request.body);
    const response = AgentScheduleSchema.parse(await service.resumeForAgent(scope, scheduleId, input.expectedRevision));
    return reply.header("Cache-Control", "no-store").code(200).send(response);
  });

  app.delete(RUNTIME_AGENT_SCHEDULE_TEMPLATE, async (request, reply) => {
    const scope = await authenticate(request);
    const { scheduleId } = parseRequest(ScheduleParamsSchema, request.params);
    const query = parseRequest(AgentScheduleDeleteQuerySchema, request.query);
    await service.deleteForAgent(scope, scheduleId, query.expectedRevision);
    return reply.header("Cache-Control", "no-store").code(204).send();
  });

  app.post(RUNTIME_AGENT_SCHEDULE_PREVIEW_PATH, async (request, reply) => {
    const scope = await authenticate(request);
    const input = parseRequest(PreviewAgentScheduleRequestSchema, request.body);
    const response = AgentSchedulePreviewSchema.parse(await service.previewForAgent(scope, input));
    return reply.header("Cache-Control", "no-store").code(200).send(response);
  });

  function authenticate(request: FastifyRequest) {
    const header = request.headers[SESSION_CLI_PROOF_HEADER];
    return service.authenticate(typeof header === "string" ? header : "");
  }
}

function authenticatedUserId(request: FastifyRequest): string {
  const userId = request.authContext?.me.user.id;
  if (!userId) throw new Error("Authenticated user context is missing");
  return userId;
}

export function registerAccountAgentScheduleRoutes(
  app: FastifyInstance,
  authService: UserAuthService,
  options: AccountAgentScheduleRoutesOptions,
): void {
  const preHandler = createUserAuthPreHandler(authService, options.authOptions ?? {});
  const { service } = options;

  app.get(AGENT_SCHEDULES_TEMPLATE, { preHandler }, async (request, reply) => {
    const { agentId } = parseRequest(AccountAgentParamsSchema, request.params);
    const query = parseRequest(AgentScheduleListQuerySchema, request.query);
    const response = AgentScheduleListResponseSchema.parse(
      await service.listForAccount(authenticatedUserId(request), agentId, query),
    );
    return reply.header("Cache-Control", "no-store").code(200).send(response);
  });

  app.get(AGENT_SCHEDULE_TEMPLATE, { preHandler }, async (request, reply) => {
    const { agentId, scheduleId } = parseRequest(AccountScheduleParamsSchema, request.params);
    const response = AgentScheduleSchema.parse(
      await service.getForAccount(authenticatedUserId(request), agentId, scheduleId),
    );
    return reply.header("Cache-Control", "no-store").code(200).send(response);
  });

  app.post(AGENT_SCHEDULE_PAUSE_TEMPLATE, { preHandler }, async (request, reply) => {
    const { agentId, scheduleId } = parseRequest(AccountScheduleParamsSchema, request.params);
    const input = parseRequest(AgentScheduleRevisionRequestSchema, request.body);
    const response = AgentScheduleSchema.parse(
      await service.pauseForAccount(authenticatedUserId(request), agentId, scheduleId, input.expectedRevision),
    );
    return reply.header("Cache-Control", "no-store").code(200).send(response);
  });

  app.post(AGENT_SCHEDULE_RESUME_TEMPLATE, { preHandler }, async (request, reply) => {
    const { agentId, scheduleId } = parseRequest(AccountScheduleParamsSchema, request.params);
    const input = parseRequest(AgentScheduleRevisionRequestSchema, request.body);
    const response = AgentScheduleSchema.parse(
      await service.resumeForAccount(authenticatedUserId(request), agentId, scheduleId, input.expectedRevision),
    );
    return reply.header("Cache-Control", "no-store").code(200).send(response);
  });

  app.delete(AGENT_SCHEDULE_TEMPLATE, { preHandler }, async (request, reply) => {
    const { agentId, scheduleId } = parseRequest(AccountScheduleParamsSchema, request.params);
    const query = parseRequest(AgentScheduleDeleteQuerySchema, request.query);
    await service.deleteForAccount(authenticatedUserId(request), agentId, scheduleId, query.expectedRevision);
    return reply.header("Cache-Control", "no-store").code(204).send();
  });
}
