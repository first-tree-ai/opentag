import {
  ComputerConnectCodeExchangeRequestSchema,
  ComputerConnectCodeExchangeResponseSchema,
  HTTP_PATHS,
} from "@opentag/shared";
import type { FastifyInstance } from "fastify";
import type { MachineAuthService } from "../services/computers/index.js";
import { parseRequest } from "./request-validation.js";

export function registerComputerRoutes(app: FastifyInstance, machineAuthService: MachineAuthService): void {
  app.post(HTTP_PATHS.computerConnectExchange, async (request, reply) => {
    const input = parseRequest(ComputerConnectCodeExchangeRequestSchema, request.body);
    const { credentialId: _credentialId, ...result } = await machineAuthService.exchangeConnectCode(input);
    return reply
      .header("Cache-Control", "no-store")
      .code(200)
      .send(ComputerConnectCodeExchangeResponseSchema.parse(result));
  });
}
