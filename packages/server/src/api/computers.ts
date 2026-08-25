import {
  type ChannelName,
  ComputerConnectCodeExchangeRequestSchema,
  ComputerConnectCodeExchangeResponseSchema,
  ComputerConnectCodeIssueResponseSchema,
  HTTP_PATHS,
  ListComputersResponseSchema,
  PROVIDER_READINESS_V1_HEADER,
  TEAM_COMPUTER_CONNECT_CODES_TEMPLATE,
} from "@opentag/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createUserAuthPreHandler } from "../plugins/user-auth.js";
import type { UserAuthService } from "../services/auth/index.js";
import {
  buildComputerConnectCommand,
  type ComputerService,
  type MachineAuthService,
} from "../services/computers/index.js";
import { parseRequest } from "./request-validation.js";

const TeamParamsSchema = z.object({ teamId: z.string().uuid() }).strict();

export function registerComputerRoutes(
  app: FastifyInstance,
  authService: UserAuthService,
  computerService: ComputerService,
  machineAuthService: MachineAuthService,
  publicOrigin?: string,
  environment?: ChannelName,
  publicUrl?: string,
): void {
  app.post(HTTP_PATHS.computerConnectExchange, async (request, reply) => {
    const input = parseRequest(ComputerConnectCodeExchangeRequestSchema, request.body);
    const { credentialId: _credentialId, ...result } = await machineAuthService.exchangeConnectCode(input);
    return reply
      .header("Cache-Control", "no-store")
      .code(200)
      .send(ComputerConnectCodeExchangeResponseSchema.parse(result));
  });
  if (environment && publicUrl) {
    app.post(
      TEAM_COMPUTER_CONNECT_CODES_TEMPLATE,
      { preHandler: createUserAuthPreHandler(authService, { publicOrigin }) },
      async (request, reply) => {
        const accountId = request.authContext?.me.user.id;
        if (!accountId) throw new Error("Authenticated Account context is missing");
        const { teamId } = parseRequest(TeamParamsSchema, request.params);
        const issued = await machineAuthService.issueForTeamAdmin(accountId, teamId);
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
      },
    );
  }
  app.get(
    HTTP_PATHS.meComputers,
    { preHandler: createUserAuthPreHandler(authService, { publicOrigin }) },
    async (request, reply) => {
      const userId = request.authContext?.me.user.id;
      if (!userId) {
        throw new Error("Authenticated user context is missing");
      }
      return reply
        .code(200)
        .send(
          ListComputersResponseSchema.parse(
            await computerService.listForUser(userId, request.headers[PROVIDER_READINESS_V1_HEADER] === "1"),
          ),
        );
    },
  );
}
