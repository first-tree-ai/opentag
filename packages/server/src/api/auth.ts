import {
  ConnectCodeExchangeRequestSchema,
  ConnectCodeExchangeResponseSchema,
  RefreshTokenRequestSchema,
  RefreshTokenResponseSchema,
} from "@opentag/shared";
import type { FastifyInstance } from "fastify";
import type { UserAuthService } from "../services/auth/index.js";

export function registerAuthRoutes(app: FastifyInstance, authService: UserAuthService): void {
  app.post("/v1/auth/connect/exchange", async (request, reply) => {
    const input = ConnectCodeExchangeRequestSchema.parse(request.body);
    const response = ConnectCodeExchangeResponseSchema.parse(await authService.exchangeConnectCode(input.code));
    return reply.code(200).send(response);
  });

  app.post("/v1/auth/refresh", async (request, reply) => {
    const input = RefreshTokenRequestSchema.parse(request.body);
    const response = RefreshTokenResponseSchema.parse(await authService.refresh(input.refreshToken));
    return reply.code(200).send(response);
  });
}
