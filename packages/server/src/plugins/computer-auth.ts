import type { FastifyReply, FastifyRequest } from "fastify";
import { AuthServiceError } from "../services/auth/index.js";
import type { ComputerAuthContext, ComputerAuthVerifier } from "../services/computers/index.js";

declare module "fastify" {
  interface FastifyRequest {
    computerAuthContext?: ComputerAuthContext;
  }
}

export function createComputerAuthPreHandler(verifier: ComputerAuthVerifier) {
  return async function computerAuthPreHandler(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith("Bearer ")) {
      throw new AuthServiceError("AUTH_INVALID_TOKEN", "credential", "Machine authentication is required", 401);
    }
    const token = authorization.slice("Bearer ".length).trim();
    if (!token) {
      throw new AuthServiceError("AUTH_INVALID_TOKEN", "credential", "Machine authentication is required", 401);
    }
    request.computerAuthContext = await verifier.verifyMachineToken(token);
  };
}
