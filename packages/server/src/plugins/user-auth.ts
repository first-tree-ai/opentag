import type { FastifyReply, FastifyRequest } from "fastify";
import { invalidCredential } from "../services/auth/errors.js";
import type { AuthenticatedUser, UserAuthService } from "../services/auth/index.js";

declare module "fastify" {
  interface FastifyRequest {
    authContext?: AuthenticatedUser;
  }
}

export function createUserAuthPreHandler(authService: UserAuthService) {
  return async function userAuthPreHandler(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith("Bearer ")) {
      throw invalidCredential("AUTH_INVALID_TOKEN", "Authentication is required");
    }
    const token = authorization.slice("Bearer ".length).trim();
    if (!token) {
      throw invalidCredential("AUTH_INVALID_TOKEN", "Authentication is required");
    }
    request.authContext = await authService.getAuthenticatedUser(token);
  };
}
