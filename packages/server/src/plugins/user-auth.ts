import type { FastifyReply, FastifyRequest } from "fastify";
import {
  BROWSER_COOKIE_NAMES,
  parseCookies,
  requireBrowserMutationSecurity,
} from "../services/auth/browser-cookies.js";
import { invalidCredential } from "../services/auth/errors.js";
import type { AuthenticatedUser, UserAuthService } from "../services/auth/index.js";

declare module "fastify" {
  interface FastifyRequest {
    authContext?: AuthenticatedUser;
  }
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function createUserAuthPreHandler(authService: UserAuthService, options: { publicOrigin?: string } = {}) {
  return async function userAuthPreHandler(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const authorization = request.headers.authorization;
    if (authorization?.startsWith("Bearer ")) {
      const token = authorization.slice("Bearer ".length).trim();
      if (!token) throw invalidCredential("AUTH_INVALID_TOKEN", "Authentication is required");
      request.authContext = await authService.getAuthenticatedUser(token);
      return;
    }
    const accessCookie = parseCookies(request.headers.cookie)[BROWSER_COOKIE_NAMES.access];
    if (!accessCookie || !options.publicOrigin) {
      throw invalidCredential("AUTH_INVALID_TOKEN", "Authentication is required");
    }
    if (!SAFE_METHODS.has(request.method)) requireBrowserMutationSecurity(request, options.publicOrigin);
    request.authContext = await authService.getAuthenticatedUser(accessCookie);
  };
}
