import {
  type ChannelName,
  ComputerConnectCodeExchangeRequestSchema,
  ComputerConnectCodeExchangeResponseSchema,
  ComputerConnectCodeIssueResponseSchema,
  HTTP_PATHS,
  WORKSPACE_COMPUTER_CONNECT_CODES_TEMPLATE,
} from "@opentag/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createUserAuthPreHandler, type UserAuthPreHandlerOptions } from "../plugins/user-auth.js";
import type { UserAuthService } from "../services/auth/index.js";
import { buildComputerConnectCommand, type MachineAuthService } from "../services/computers/index.js";
import { parseRequest } from "./request-validation.js";

const WorkspaceParamsSchema = z.object({ workspaceId: z.string().uuid() }).strict();

export function registerComputerRoutes(
  app: FastifyInstance,
  authService: UserAuthService,
  machineAuthService: MachineAuthService,
  authOptions?: UserAuthPreHandlerOptions,
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
      WORKSPACE_COMPUTER_CONNECT_CODES_TEMPLATE,
      { preHandler: createUserAuthPreHandler(authService, authOptions ?? {}) },
      async (request, reply) => {
        const accountId = request.authContext?.me.user.id;
        if (!accountId) throw new Error("Authenticated Account context is missing");
        const { workspaceId } = parseRequest(WorkspaceParamsSchema, request.params);
        const issued = await machineAuthService.issueForWorkspaceAdmin(accountId, workspaceId);
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
      },
    );
  }
}
