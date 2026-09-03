import {
  AGENT_SLACK_OAUTH_START_TEMPLATE,
  type AgentSetupReturnSurface,
  AgentSetupReturnSurfaceSchema,
  SLACK_OAUTH_CALLBACK_PATH,
  StartSlackOAuthRequestSchema,
  StartSlackOAuthResponseSchema,
} from "@opentag/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  createUserAuthPreHandler,
  resolveAuthenticatedUserId,
  type UserAuthPreHandlerOptions,
} from "../plugins/user-auth.js";
import {
  BROWSER_COOKIE_NAMES,
  clearSlackOAuthContextCookie,
  parseCookies,
  setSlackOAuthContextCookie,
} from "../services/auth/browser-cookies.js";
import { AuthServiceError } from "../services/auth/errors.js";
import type { UserAuthService } from "../services/auth/index.js";
import { ImBindingServiceError } from "../services/im-bindings/index.js";
import { SlackConfigurationServiceError, type SlackOAuthService } from "../services/im-bindings/slack/index.js";
import { parseRequest } from "./request-validation.js";

const AgentParamsSchema = z.object({ agentId: z.string().uuid() }).strict();
const CallbackQuerySchema = z.object({
  code: z.string().min(1).max(4096).optional(),
  error: z.string().min(1).max(256).optional(),
  error_description: z.string().max(1024).optional(),
  state: z.string().min(1).max(8192),
});

export interface SlackOAuthRouteOptions {
  authService: UserAuthService;
  authOptions?: UserAuthPreHandlerOptions;
  publicOrigin: string;
  secureCookies: boolean;
  slackOAuth: SlackOAuthService;
}

function authenticatedUserId(request: FastifyRequest): string {
  const userId = request.authContext?.me.user.id;
  if (!userId) throw new Error("Authenticated user context is missing");
  return userId;
}

/**
 * The callback returns only to a fixed surface the signed state named: the Agent's messaging settings or
 * the canonical `/agents/setup?agentId=<exact-agent>` setup page. There is no caller-controlled return URL.
 */
function resultRedirect(
  publicOrigin: string,
  target: { agentId?: string; returnSurface?: AgentSetupReturnSurface },
  errorCode?: string,
): string {
  const url = new URL("/", publicOrigin);
  if (target.agentId && target.returnSurface === "agent-setup") {
    url.pathname = "/agents/setup";
    url.searchParams.set("agentId", target.agentId);
  } else if (target.agentId) {
    url.pathname = `/agents/${encodeURIComponent(target.agentId)}/settings/messaging`;
  } else {
    url.pathname = "/agents";
  }
  if (errorCode) url.searchParams.set("slack_oauth_error", errorCode);
  else url.searchParams.set("slack_oauth", "success");
  return url.toString();
}

function publicErrorCode(error: unknown): string {
  if (
    error instanceof SlackConfigurationServiceError ||
    error instanceof AuthServiceError ||
    error instanceof ImBindingServiceError
  ) {
    return error.code;
  }
  return "SLACK_OAUTH_FAILED";
}

function errorAgentId(error: unknown): string | undefined {
  if (
    typeof error === "object" &&
    error !== null &&
    "slackOAuthAgentId" in error &&
    typeof error.slackOAuthAgentId === "string"
  ) {
    return error.slackOAuthAgentId;
  }
  return undefined;
}

function errorReturnSurface(error: unknown): AgentSetupReturnSurface | undefined {
  if (typeof error === "object" && error !== null && "slackOAuthReturnSurface" in error) {
    const parsed = AgentSetupReturnSurfaceSchema.safeParse(error.slackOAuthReturnSurface);
    if (parsed.success) return parsed.data;
  }
  return undefined;
}

export function registerSlackOAuthRoutes(app: FastifyInstance, options: SlackOAuthRouteOptions): void {
  const preHandler = createUserAuthPreHandler(options.authService, options.authOptions ?? {});

  app.post(AGENT_SLACK_OAUTH_START_TEMPLATE, { preHandler }, async (request, reply) => {
    const { agentId } = parseRequest(AgentParamsSchema, request.params);
    const input = parseRequest(StartSlackOAuthRequestSchema, request.body ?? {});
    const started = await options.slackOAuth.start(
      authenticatedUserId(request),
      agentId,
      input.intent,
      input.returnSurface,
      input.expectedMessaging,
    );
    setSlackOAuthContextCookie(reply, started.sessionBinding, {
      path: SLACK_OAUTH_CALLBACK_PATH,
      secure: options.secureCookies,
    });
    return reply.code(200).send(
      StartSlackOAuthResponseSchema.parse({
        authorizationUrl: started.authorizationUrl,
        expiresAt: started.expiresAt,
      }),
    );
  });

  app.get(SLACK_OAUTH_CALLBACK_PATH, async (request, reply) => {
    const cookies = parseCookies(request.headers.cookie);
    clearSlackOAuthContextCookie(reply, SLACK_OAUTH_CALLBACK_PATH, options.secureCookies);
    try {
      const query = parseRequest(CallbackQuerySchema, request.query);
      // Resolved through the shared resolver so a browser holding either credential completes authorization.
      const authenticatedUserId = await resolveAuthenticatedUserId(request, options.authService, options.authOptions);
      const result = await options.slackOAuth.callback({
        ...(authenticatedUserId === undefined ? {} : { authenticatedUserId }),
        ...(query.code !== undefined ? { code: query.code } : {}),
        ...(query.error !== undefined ? { error: query.error } : {}),
        sessionBinding: cookies[BROWSER_COOKIE_NAMES.slackOAuthContext],
        state: query.state,
      });
      return reply.redirect(
        resultRedirect(options.publicOrigin, { agentId: result.agentId, returnSurface: result.returnSurface }),
        302,
      );
    } catch (error) {
      const callbackQuery = request.query as { code?: unknown; error?: unknown };
      request.log.error(
        {
          callbackHadCode: typeof callbackQuery.code === "string" && callbackQuery.code.length > 0,
          callbackSlackError: typeof callbackQuery.error === "string" ? callbackQuery.error.slice(0, 128) : undefined,
          errorCode:
            typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
              ? error.code
              : undefined,
          errorMessage: error instanceof Error ? error.message : "Unknown Slack OAuth callback failure",
          errorName: error instanceof Error ? error.name : typeof error,
          upstreamSlackError:
            typeof error === "object" &&
            error !== null &&
            "upstreamSlackError" in error &&
            typeof error.upstreamSlackError === "string"
              ? error.upstreamSlackError
              : undefined,
        },
        "Slack OAuth callback failed",
      );
      return redirectOAuthFailure(reply, options.publicOrigin, errorAgentId(error), error);
    }
  });
}

function redirectOAuthFailure(
  reply: FastifyReply,
  publicOrigin: string,
  agentId: string | undefined,
  error: unknown,
): FastifyReply {
  const returnSurface = errorReturnSurface(error);
  return reply.redirect(
    resultRedirect(
      publicOrigin,
      {
        ...(agentId ? { agentId } : {}),
        ...(returnSurface ? { returnSurface } : {}),
      },
      publicErrorCode(error),
    ),
    302,
  );
}
