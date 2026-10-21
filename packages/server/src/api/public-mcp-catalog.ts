import { PUBLIC_MCP_CATALOG_PATH, PUBLIC_MCP_CATALOG_REQUEST_MAX_BYTES } from "@opentag/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { dispatchInboundRequest, jsonRpcError, parseInboundRequest } from "../services/mcp/mcp-inbound-protocol.js";
import { createPublicCatalogHandlers } from "../services/mcp-catalog/public-catalog-mcp.js";
import { type BrowserAuthRateLimiter, RouteRateLimiter } from "./browser-auth.js";

/**
 * The anonymous catalog MCP endpoint.
 *
 * The repo-shipped marketplace, served over the same inbound MCP protocol the runtime gateway uses,
 * so a user's own Agent (Claude Code, Cursor, any MCP client) can search it and paste back a working
 * configuration. Three deliberate differences from `api/public-catalog.ts`:
 *
 * - **Always registered.** That one is a browser read gated on website origins; this one is a
 *   protocol endpoint whose callers are not browsers, and everything it serves is public.
 * - **No CORS.** An MCP client is not a web page, and granting a browser origin would only invite the
 *   page to use this deployment as a catalog proxy.
 * - **It carries endpoints.** `url`, `keyAuth`, and the auth methods are the whole point here, and
 *   they are already public in `packages/mcp-presets/mcp-catalog.yaml`.
 *
 * It authenticates nobody and reads nothing about the caller, so the only protection it needs is a
 * request budget.
 */

export interface PublicMcpCatalogRoutesOptions {
  /** Injected by tests and by a deployment with a shared budget; otherwise a per-process one. */
  rateLimiter?: BrowserAuthRateLimiter;
}

const RATE_LIMIT = 120;
const RATE_LIMIT_WINDOW_MS = 60_000;

/** JSON-RPC codes for the failures that happen before a method is even known. */
const RPC_PARSE_ERROR = -32700;
const RPC_INVALID_REQUEST = -32600;
const RPC_INTERNAL_ERROR = -32603;
/** The implementation-defined server-error band, for a budget the caller has spent. */
const RPC_RATE_LIMITED = -32000;

export function registerPublicMcpCatalogRoutes(
  app: FastifyInstance,
  options: PublicMcpCatalogRoutesOptions = {},
): void {
  const handlers = createPublicCatalogHandlers();
  const limiter = options.rateLimiter ?? new RouteRateLimiter(RATE_LIMIT, RATE_LIMIT_WINDOW_MS);

  /*
   * Its own encapsulated scope, for the same reason the gateway has one: the app's error handler
   * answers in OpenTag's `{ error: { code, category } }` envelope, which is right everywhere else and
   * unreadable to the only caller this route has. Without the scope, a body Fastify's JSON parser
   * rejects — the one failure this route cannot intercept, because it happens before the handler —
   * would escape as that envelope.
   */
  app.register(async (scope) => {
    scope.setErrorHandler(async (error, _request, reply) => sendFailure(reply, error));

    /*
     * The Streamable HTTP client may open a GET for a server-initiated stream or DELETE to end a
     * session. This endpoint has neither — every reply is one JSON object and no session is kept — so
     * the honest answer is "not allowed here" rather than Fastify's route-not-found, which reads as
     * the endpoint being absent entirely.
     */
    for (const method of ["GET", "DELETE"] as const) {
      scope.route({
        method,
        url: PUBLIC_MCP_CATALOG_PATH,
        handler: async (_request, reply) =>
          reply
            .status(405)
            .header("Allow", "POST")
            .header("Cache-Control", "no-store")
            .send(jsonRpcError(null, RPC_INVALID_REQUEST, "The catalog MCP endpoint accepts POST only")),
      });
    }

    scope.post(
      PUBLIC_MCP_CATALOG_PATH,
      // Rejected before the body is parsed: a caller over budget must not cost a parse.
      { onRequest: rateLimit(limiter), bodyLimit: PUBLIC_MCP_CATALOG_REQUEST_MAX_BYTES },
      handleCatalogRequest,
    );
  });

  async function handleCatalogRequest(request: FastifyRequest, reply: FastifyReply): Promise<unknown> {
    reply.header("Cache-Control", "no-store");
    const rpc = parseInboundRequest(request.body);
    if (!rpc) {
      return reply.status(400).send(jsonRpcError(null, RPC_INVALID_REQUEST, "Invalid JSON-RPC request"));
    }
    const outcome = await dispatchInboundRequest(rpc, handlers);
    if (outcome.kind === "accepted") return reply.status(202).send();
    return reply.status(outcome.status).send(outcome.body);
  }
}

/**
 * The per-caller budget, sent from the hook rather than thrown.
 *
 * The limiter is shared with browser sign-in, whose message names that flow; a catalog caller needs
 * its own, so the answer is built here and the limiter's text is not used.
 */
function rateLimit(limiter: BrowserAuthRateLimiter) {
  return async function catalogRateLimit(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      limiter.check(request.ip);
    } catch {
      reply
        .status(429)
        .header("Cache-Control", "no-store")
        .header("Retry-After", String(Math.ceil(RATE_LIMIT_WINDOW_MS / 1000)))
        .send(jsonRpcError(null, RPC_RATE_LIMITED, "Too many catalog requests"));
    }
  };
}

/** Turn every failure into JSON-RPC: this caller cannot read any other envelope. */
function sendFailure(reply: FastifyReply, error: unknown): unknown {
  /*
   * Fastify's own content-type failures — an unparseable body, an empty one, one past the size bound.
   * The family is matched by prefix and the status taken from the error itself, as the gateway route
   * does, rather than enumerating codes that shift between Fastify versions.
   */
  const code = (error as { code?: string } | null)?.code;
  if (error instanceof SyntaxError || (typeof code === "string" && code.startsWith("FST_ERR_CTP_"))) {
    const status = (error as { statusCode?: number }).statusCode;
    const bounded = typeof status === "number" && status >= 400 && status < 500 ? status : 400;
    return reply.status(bounded).send(jsonRpcError(null, RPC_PARSE_ERROR, "The request body could not be read"));
  }
  return reply.status(500).send(jsonRpcError(null, RPC_INTERNAL_ERROR, "Internal error"));
}
