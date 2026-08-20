import {
  CreateTeamRequestSchema,
  CreateTeamResponseSchema,
  ListTeamComputersConfigResponseSchema,
  ListTeamComputersResponseSchema,
  ListTeamMembersConfigResponseSchema,
  ListTeamMembersResponseSchema,
  RestoreTeamMemberRequestSchema,
  TEAM_BY_ID_TEMPLATE,
  TEAM_COMPUTERS_CONFIG_TEMPLATE,
  TEAM_COMPUTERS_TEMPLATE,
  TEAM_MEMBER_TEMPLATE,
  TEAM_MEMBERS_CONFIG_TEMPLATE,
  TEAM_MEMBERS_TEMPLATE,
  TEAMS_TEMPLATE,
  TeamMemberAdminConfigSchema,
  TeamProfileSchema,
  UpdateTeamMemberRequestSchema,
  UpdateTeamProfileRequestSchema,
} from "@opentag/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { createUserAuthPreHandler } from "../plugins/user-auth.js";
import type { UserAuthService } from "../services/auth/index.js";
import type { TeamMembershipService } from "../services/teams/index.js";
import { parseRequest } from "./request-validation.js";

const TeamParamsSchema = z.object({ teamId: z.string().uuid() }).strict();
const MemberParamsSchema = z.object({ teamId: z.string().uuid(), userId: z.string().uuid() }).strict();

function userId(request: FastifyRequest): string {
  const value = request.authContext?.me.user.id;
  if (!value) throw new Error("Authenticated user context is missing");
  return value;
}

export function registerTeamRoutes(
  app: FastifyInstance,
  authService: UserAuthService,
  teamService: TeamMembershipService,
  publicOrigin?: string,
): void {
  const preHandler = createUserAuthPreHandler(authService, { publicOrigin });

  app.post(TEAMS_TEMPLATE, { preHandler }, async (request, reply) => {
    const input = parseRequest(CreateTeamRequestSchema, request.body);
    return reply.code(201).send(CreateTeamResponseSchema.parse(await teamService.createTeam(userId(request), input)));
  });

  app.patch(TEAM_BY_ID_TEMPLATE, { preHandler }, async (request, reply) => {
    const { teamId } = parseRequest(TeamParamsSchema, request.params);
    const input = parseRequest(UpdateTeamProfileRequestSchema, request.body);
    return reply
      .code(200)
      .send(TeamProfileSchema.parse(await teamService.updateTeamProfile(userId(request), teamId, input)));
  });

  app.get(TEAM_MEMBERS_TEMPLATE, { preHandler }, async (request, reply) => {
    const { teamId } = parseRequest(TeamParamsSchema, request.params);
    return reply
      .code(200)
      .send(ListTeamMembersResponseSchema.parse(await teamService.listMembers(userId(request), teamId)));
  });

  app.get(TEAM_MEMBERS_CONFIG_TEMPLATE, { preHandler }, async (request, reply) => {
    const { teamId } = parseRequest(TeamParamsSchema, request.params);
    return reply
      .code(200)
      .send(ListTeamMembersConfigResponseSchema.parse(await teamService.listMembersConfig(userId(request), teamId)));
  });

  app.patch(TEAM_MEMBER_TEMPLATE, { preHandler }, async (request, reply) => {
    const { teamId, userId: targetUserId } = parseRequest(MemberParamsSchema, request.params);
    const input = parseRequest(UpdateTeamMemberRequestSchema, request.body);
    return reply
      .code(200)
      .send(
        TeamMemberAdminConfigSchema.parse(
          await teamService.changeRole(userId(request), teamId, targetUserId, input.role),
        ),
      );
  });

  app.post(`${TEAM_MEMBER_TEMPLATE}/remove`, { preHandler }, async (request, reply) => {
    const { teamId, userId: targetUserId } = parseRequest(MemberParamsSchema, request.params);
    await teamService.remove(userId(request), teamId, targetUserId);
    return reply.code(204).send();
  });

  app.post(`${TEAM_MEMBER_TEMPLATE}/restore`, { preHandler }, async (request, reply) => {
    const { teamId, userId: targetUserId } = parseRequest(MemberParamsSchema, request.params);
    const input = parseRequest(RestoreTeamMemberRequestSchema, request.body);
    return reply
      .code(200)
      .send(
        TeamMemberAdminConfigSchema.parse(await teamService.restore(userId(request), teamId, targetUserId, input.role)),
      );
  });

  app.post("/api/v1/teams/:teamId/leave", { preHandler }, async (request, reply) => {
    const { teamId } = parseRequest(TeamParamsSchema, request.params);
    await teamService.leave(userId(request), teamId);
    return reply.code(204).send();
  });

  app.get(TEAM_COMPUTERS_TEMPLATE, { preHandler }, async (request, reply) => {
    const { teamId } = parseRequest(TeamParamsSchema, request.params);
    return reply
      .code(200)
      .send(ListTeamComputersResponseSchema.parse(await teamService.listComputers(userId(request), teamId)));
  });

  app.get(TEAM_COMPUTERS_CONFIG_TEMPLATE, { preHandler }, async (request, reply) => {
    const { teamId } = parseRequest(TeamParamsSchema, request.params);
    return reply
      .code(200)
      .send(
        ListTeamComputersConfigResponseSchema.parse(await teamService.listComputersConfig(userId(request), teamId)),
      );
  });
}
