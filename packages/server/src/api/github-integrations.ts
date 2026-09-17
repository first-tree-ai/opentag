/*
 * Account-facing GitHub integration management routes.
 *
 * Every management route requires an authenticated Account and follows the existing CSRF/origin
 * patterns through the shared user-auth preHandler. The two public paths verify their own callers:
 * the OAuth callback claims its one-time state against the persisted flow and the login-session
 * cookie, and the webhook verifies the raw-body HMAC with the deployment secret. Responses are the
 * shared safe DTOs only — no credential ciphertext, key IDs, state, session values, or tokens ever
 * cross this boundary, and the callback redirects only to fixed local return surfaces with a
 * bounded outcome parameter.
 */

import {
  GITHUB_INTEGRATION_AUTHORIZATION_PATH,
  GITHUB_INTEGRATION_BINDINGS_PATH,
  GITHUB_INTEGRATION_DISCONNECT_PATH,
  GITHUB_INTEGRATION_PATH,
  GITHUB_INTEGRATION_REPOSITORIES_PATH,
  GITHUB_OAUTH_CALLBACK_PATH,
  GITHUB_OAUTH_ERROR_PARAM,
  GITHUB_OAUTH_OUTCOME_ERROR,
  GITHUB_OAUTH_OUTCOME_PARAM,
  GITHUB_OAUTH_OUTCOME_SUCCESS,
  GITHUB_WEBHOOK_PATH,
  GitHubConnectionStatusSchema,
  type GitHubIntegrationAvailability,
  GitHubIntegrationOverviewSchema,
  type GitHubOAuthReturnSurface,
  GitHubRepositoryDiscoveryPageSchema,
  GitHubRepositoryDiscoveryQuerySchema,
  StartGitHubAuthorizationRequestSchema,
  StartGitHubAuthorizationResponseSchema,
  UpdateGitHubConnectionBindingsRequestSchema,
} from "@opentag/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { createServiceLoggerPort } from "../observability/service-logger.js";
import {
  createUserAuthPreHandler,
  resolveAuthenticatedUserId,
  type UserAuthPreHandlerOptions,
} from "../plugins/user-auth.js";
import { appendSetCookies, parseCookies } from "../services/auth/browser-cookies.js";
import type { UserAuthService } from "../services/auth/index.js";
import { generateSecret, hashSecret } from "../services/auth/security.js";
import {
  GITHUB_CONNECTION_ERROR_CODES,
  GitHubConnectionServiceError,
  type GitHubManagementService,
  type GitHubWebhookService,
} from "../services/github/index.js";
import { parseRequest } from "./request-validation.js";

/** The HttpOnly login-session proof carried through the OAuth round trip; only its hash persists. */
const GITHUB_OAUTH_CONTEXT_COOKIE = "opentag_github_oauth_context";
const GITHUB_OAUTH_CONTEXT_COOKIE_MAX_AGE_SECONDS = 10 * 60;

const CallbackQuerySchema = z
  .object({
    code: z.string().min(1).max(4096).optional(),
    state: z.string().min(1).max(512),
    error: z.string().min(1).max(256).optional(),
    error_description: z.string().max(1024).optional(),
  })
  .strict();

export interface GitHubIntegrationsRouteOptions {
  authService: UserAuthService;
  authOptions?: UserAuthPreHandlerOptions;
  publicOrigin: string;
  secureCookies: boolean;
  /** Precomputed deployment availability; the UI explains an unavailable integration with it. */
  availability: GitHubIntegrationAvailability;
  /** Present exactly when the deployment GitHub App is configured. */
  management?: GitHubManagementService;
  webhook?: GitHubWebhookService;
}

function authenticatedUserId(request: FastifyRequest): string {
  const userId = request.authContext?.me.user.id;
  if (!userId) throw new Error("Authenticated user context is missing");
  return userId;
}

function unavailable(): GitHubConnectionServiceError {
  return new GitHubConnectionServiceError(
    GITHUB_CONNECTION_ERROR_CODES.INTEGRATION_UNAVAILABLE,
    503,
    "The GitHub integration is not configured on this deployment",
    "deterministic",
  );
}

function setGitHubOAuthContextCookie(reply: FastifyReply, value: string, secure: boolean): void {
  appendSetCookies(reply, [
    `${GITHUB_OAUTH_CONTEXT_COOKIE}=${encodeURIComponent(value)}; Path=${GITHUB_OAUTH_CALLBACK_PATH}; SameSite=Lax; HttpOnly; Max-Age=${GITHUB_OAUTH_CONTEXT_COOKIE_MAX_AGE_SECONDS}${secure ? "; Secure" : ""}`,
  ]);
}

function clearGitHubOAuthContextCookie(reply: FastifyReply, secure: boolean): void {
  appendSetCookies(reply, [
    `${GITHUB_OAUTH_CONTEXT_COOKIE}=; Path=${GITHUB_OAUTH_CALLBACK_PATH}; SameSite=Lax; HttpOnly; Max-Age=0${secure ? "; Secure" : ""}`,
  ]);
}

/** The login-session hash binds the flow to this exact Account and this browser-held secret. */
function loginSessionHash(accountId: string, sessionSecret: string): string {
  return hashSecret(`${accountId}:${sessionSecret}`);
}

/** Fixed local return surfaces; the OAuth context's verified values choose between them. */
function returnSurfaceUrl(
  publicOrigin: string,
  surface: GitHubOAuthReturnSurface,
  agentId: string | null,
  outcome: { ok: true } | { ok: false; code: string },
): string {
  const url = new URL("/", publicOrigin);
  if (surface === "agent-integrations" && agentId !== null) {
    url.pathname = `/agents/${encodeURIComponent(agentId)}/integrations`;
  } else {
    url.pathname = "/account";
  }
  if (outcome.ok) {
    url.searchParams.set(GITHUB_OAUTH_OUTCOME_PARAM, GITHUB_OAUTH_OUTCOME_SUCCESS);
  } else {
    url.searchParams.set(GITHUB_OAUTH_OUTCOME_PARAM, GITHUB_OAUTH_OUTCOME_ERROR);
    url.searchParams.set(GITHUB_OAUTH_ERROR_PARAM, outcome.code);
  }
  return url.toString();
}

function publicErrorCode(error: unknown): string {
  if (error instanceof GitHubConnectionServiceError) return error.code;
  return "GITHUB_OAUTH_FLOW_INVALID";
}

export function registerGitHubIntegrationsRoutes(app: FastifyInstance, options: GitHubIntegrationsRouteOptions): void {
  const preHandler = createUserAuthPreHandler(options.authService, options.authOptions ?? {});
  const logger = createServiceLoggerPort(() => app.log, "github-integrations");

  app.get(GITHUB_INTEGRATION_PATH, { preHandler }, async (request, reply) => {
    if (!options.management) {
      return reply.code(200).send(
        GitHubIntegrationOverviewSchema.parse({
          availability: options.availability,
          connection: null,
        }),
      );
    }
    const overview = await options.management.getOverview(authenticatedUserId(request));
    return reply.code(200).send(GitHubIntegrationOverviewSchema.parse(overview));
  });

  app.post(GITHUB_INTEGRATION_AUTHORIZATION_PATH, { preHandler }, async (request, reply) => {
    if (!options.management) throw unavailable();
    const accountId = authenticatedUserId(request);
    const input = parseRequest(StartGitHubAuthorizationRequestSchema, request.body ?? {});
    const sessionSecret = generateSecret(24);
    const started = await options.management.startAuthorization(accountId, {
      intent: input.intent,
      returnSurface: input.returnSurface,
      agentId: input.agentId,
      loginSessionHash: loginSessionHash(accountId, sessionSecret),
    });
    setGitHubOAuthContextCookie(reply, sessionSecret, options.secureCookies);
    return reply.code(200).send(
      StartGitHubAuthorizationResponseSchema.parse({
        connectionId: started.connectionId,
        authorizationUrl: started.authorizationUrl,
        expiresAt: started.expiresAt,
      }),
    );
  });

  app.get(GITHUB_INTEGRATION_REPOSITORIES_PATH, { preHandler }, async (request, reply) => {
    if (!options.management) throw unavailable();
    const query = parseRequest(GitHubRepositoryDiscoveryQuerySchema, request.query ?? {});
    const page = await options.management.discoverRepositories(authenticatedUserId(request), query.cursor);
    return reply.code(200).send(GitHubRepositoryDiscoveryPageSchema.parse(page));
  });

  app.put(GITHUB_INTEGRATION_BINDINGS_PATH, { preHandler }, async (request, reply) => {
    if (!options.management) throw unavailable();
    const input = parseRequest(UpdateGitHubConnectionBindingsRequestSchema, request.body ?? {});
    const status = await options.management.updateBindings(authenticatedUserId(request), input);
    return reply.code(200).send(GitHubConnectionStatusSchema.parse(status));
  });

  app.post(GITHUB_INTEGRATION_DISCONNECT_PATH, { preHandler }, async (request, reply) => {
    if (!options.management) throw unavailable();
    const status = await options.management.disconnect(authenticatedUserId(request));
    return status === null ? reply.code(204).send() : reply.code(200).send(GitHubConnectionStatusSchema.parse(status));
  });

  /*
   * The OAuth callback: public, but every path through it is verified — the flow's one-time state
   * against its persisted hash, the login-session cookie against the flow's session binding, and
   * the authenticated Account against the connection's owner. Raw code/state/session values are
   * never logged or redirected; the outcome is a fixed local surface plus a bounded code.
   */
  app.get(GITHUB_OAUTH_CALLBACK_PATH, async (request, reply) => {
    const cookies = parseCookies(request.headers.cookie);
    clearGitHubOAuthContextCookie(reply, options.secureCookies);
    const sessionSecret = cookies[GITHUB_OAUTH_CONTEXT_COOKIE];
    let surface: GitHubOAuthReturnSurface = "account-integrations";
    let agentId: string | null = null;
    try {
      const query = parseRequest(CallbackQuerySchema, request.query);
      const accountId = await resolveAuthenticatedUserId(request, options.authService, options.authOptions);
      if (!accountId || !sessionSecret) {
        // Login is mandatory: without the Account session or the flow's session proof there is
        // nothing safe to claim, and the flow itself expires shortly.
        return reply.redirect(
          returnSurfaceUrl(options.publicOrigin, surface, agentId, {
            ok: false,
            code: "GITHUB_OAUTH_AUTHENTICATION_REQUIRED",
          }),
          302,
        );
      }
      const sessionHash = loginSessionHash(accountId, sessionSecret);
      if (!options.management) throw unavailable();
      if (query.error !== undefined) {
        const aborted = await options.management.abortOAuthCallback(accountId, {
          state: query.state,
          loginSessionHash: sessionHash,
        });
        if (aborted) {
          surface = aborted.returnSurface;
          agentId = aborted.agentId;
        }
        return reply.redirect(
          returnSurfaceUrl(options.publicOrigin, surface, agentId, { ok: false, code: "GITHUB_OAUTH_DENIED" }),
          302,
        );
      }
      if (query.code === undefined) {
        return reply.redirect(
          returnSurfaceUrl(options.publicOrigin, surface, agentId, {
            ok: false,
            code: "GITHUB_OAUTH_FLOW_INVALID",
          }),
          302,
        );
      }
      const result = await options.management.completeOAuthCallback(accountId, {
        state: query.state,
        code: query.code,
        loginSessionHash: sessionHash,
      });
      return reply.redirect(
        returnSurfaceUrl(options.publicOrigin, result.returnSurface, result.agentId, { ok: true }),
        302,
      );
    } catch (error) {
      const query = request.query as Record<string, unknown>;
      logger.error(
        {
          callbackHadCode: typeof query.code === "string" && query.code.length > 0,
          callbackHadError: typeof query.error === "string",
          errorCode: publicErrorCode(error),
        },
        "GitHub OAuth callback failed",
      );
      return reply.redirect(
        returnSurfaceUrl(options.publicOrigin, surface, agentId, { ok: false, code: publicErrorCode(error) }),
        302,
      );
    }
  });

  /*
   * The webhook: raw-body HMAC verification local to this encapsulated scope's content parser.
   * Payload bodies are never logged; the handler only invalidates fail-closed or marks an
   * authoritative recheck.
   */
  if (options.webhook) {
    const webhook = options.webhook;
    app.register(async (webhookApp) => {
      webhookApp.removeContentTypeParser("application/json");
      webhookApp.addContentTypeParser(
        "application/json",
        { parseAs: "buffer", bodyLimit: 256 * 1024 },
        (_request, body, done) => {
          done(null, body);
        },
      );
      webhookApp.post(GITHUB_WEBHOOK_PATH, async (request, reply) => {
        const signature = firstHeader(request.headers["x-hub-signature-256"]);
        const event = firstHeader(request.headers["x-github-event"]);
        const deliveryId = firstHeader(request.headers["x-github-delivery"]);
        const rawBody = request.body;
        if (!Buffer.isBuffer(rawBody)) {
          return reply.code(400).send({ status: "rejected" });
        }
        const verdict = await webhook.handle({ rawBody, signature256: signature, event, deliveryId });
        if (verdict.status === "rejected") {
          logger.warn({ eventPresent: event !== undefined }, "GitHub webhook rejected");
          return reply.code(401).send({ status: "rejected" });
        }
        return reply.code(200).send(
          verdict.status === "processed"
            ? {
                status: "processed",
                invalidatedConnections: verdict.invalidatedConnections,
                recheckMarkedConnections: verdict.recheckMarkedConnections,
              }
            : { status: "ignored" },
        );
      });
    });
  }
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
