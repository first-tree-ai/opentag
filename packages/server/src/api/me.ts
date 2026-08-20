import {
  type ChannelName,
  ConnectCodeIssueRequestSchema,
  ConnectCodeIssueResponseSchema,
  HTTP_PATHS,
  MeResponseSchema,
  UpdateUserProfileRequestSchema,
  UserProfileSchema,
} from "@opentag/shared";
import type { FastifyInstance } from "fastify";
import { createUserAuthPreHandler } from "../plugins/user-auth.js";
import { buildConnectBootstrapCommand, type ConnectCodeIssuer, type UserAuthService } from "../services/auth/index.js";
import { parseRequest } from "./request-validation.js";

export interface MeRoutesOptions {
  connectCodeIssuer?: ConnectCodeIssuer;
  environment?: ChannelName;
  publicOrigin?: string;
  publicUrl?: string;
}

export function registerMeRoutes(
  app: FastifyInstance,
  authService: UserAuthService,
  options: MeRoutesOptions = {},
): void {
  const preHandler = createUserAuthPreHandler(authService, { publicOrigin: options.publicOrigin });
  app.get(HTTP_PATHS.me, { preHandler }, async (request, reply) =>
    reply.code(200).send(MeResponseSchema.parse(request.authContext?.me)),
  );
  app.patch(HTTP_PATHS.me, { preHandler }, async (request, reply) => {
    const userId = request.authContext?.me.user.id;
    if (!userId) throw new Error("Authenticated user context is missing");
    const input = parseRequest(UpdateUserProfileRequestSchema, request.body);
    return reply.code(200).send(UserProfileSchema.parse(await authService.updateSelfProfile(userId, input)));
  });

  if (options.connectCodeIssuer && options.environment && options.publicUrl) {
    const connectCodeIssuer = options.connectCodeIssuer;
    const environment = options.environment;
    const publicUrl = options.publicUrl;
    app.post(HTTP_PATHS.meConnectCodes, { preHandler }, async (request, reply) => {
      const userId = request.authContext?.me.user.id;
      if (!userId) throw new Error("Authenticated user context is missing");
      const { teamId } = parseRequest(ConnectCodeIssueRequestSchema, request.body);
      const issued = await connectCodeIssuer.issueForTeamAdmin(userId, teamId);
      return reply
        .header("Cache-Control", "no-store")
        .code(201)
        .send(
          ConnectCodeIssueResponseSchema.parse({
            bootstrapCommand: buildConnectBootstrapCommand({ code: issued.code, environment, publicUrl }),
            expiresIn: issued.expiresIn,
            issuedAt: issued.issuedAt.toISOString(),
          }),
        );
    });
  }
}
