import {
  ConnectCodeExchangeRequestSchema,
  ConnectCodeExchangeResponseSchema,
  HTTP_PATHS,
  RefreshTokenRequestSchema,
  RefreshTokenResponseSchema,
} from "@opentag/shared";
import type { FastifyInstance } from "fastify";
import type { UserAuthService } from "../services/auth/index.js";
import { parseRequest } from "./request-validation.js";

export function registerAuthRoutes(app: FastifyInstance, authService: UserAuthService): void {
  app.post(HTTP_PATHS.authConnectExchange, async (request, reply) => {
    const input = parseRequest(ConnectCodeExchangeRequestSchema, request.body);
    const response = ConnectCodeExchangeResponseSchema.parse(
      await authService.exchangeConnectCode(input.code, input.expectedUserId),
    );
    return reply.code(200).send(response);
  });

  app.post(HTTP_PATHS.authRefresh, async (request, reply) => {
    const input = parseRequest(RefreshTokenRequestSchema, request.body);
    const response = RefreshTokenResponseSchema.parse(await authService.refresh(input.refreshToken));
    return reply.code(200).send(response);
  });
}
