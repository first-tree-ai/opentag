/*
 * The two unauthenticated MCP paths.
 *
 * `/api/v1/mcp-servers/oauth/callback` verifies its own caller: the one-time `state` the flow row
 * holds (stored hashed), plus the flow secret issued to the initiating browser as a cookie. The
 * state alone would not be enough — it travels in a URL that can be forwarded to anyone — so the
 * cookie is what binds the callback to the browser that started the flow, following the Slack
 * context cookie precedent. It redirects only to a fixed local surface carrying a bounded outcome,
 * and it never echoes the authorization server's `error_description` back to the browser.
 *
 * `/oauth/client-metadata.json` is this deployment's public Client ID Metadata Document. It contains
 * only what the specification requires of a public client: the client ID (this same URL), a name,
 * and the redirect URIs. Nothing here is a secret, and nothing here names an Account.
 */

import { MCP_CLIENT_METADATA_PATH, MCP_ERROR_CODES, MCP_OAUTH_CALLBACK_PATH } from "@opentag/shared";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { BROWSER_COOKIE_NAMES, clearMcpOAuthContextCookie, parseCookies } from "../services/auth/browser-cookies.js";
import type { McpOAuthFlowService } from "../services/mcp/index.js";
import { McpServiceError } from "../services/mcp/index.js";
import { parseRequest } from "./request-validation.js";

const CallbackQuerySchema = z
  .object({
    code: z.string().min(1).max(8192).optional(),
    state: z.string().min(1).max(512),
    error: z.string().min(1).max(256).optional(),
    // Accepted and discarded: a bounded value is never shown to the browser.
    error_description: z.string().max(2048).optional(),
    iss: z.string().min(1).max(2048).optional(),
  })
  .strict();

export interface McpOAuthRoutesOptions {
  /**
   * Fired after a callback stores a credential.
   *
   * The callback itself does not probe: that would hold the browser for the duration of an upstream
   * round trip. But something must, or the row stays `pending` forever — the comment promising the
   * probe "runs backstage" was true of nothing, and both the UI's tool count and the CLI's
   * `mcp authorize` wait (which requires `probeState !== "pending"`) depended on it happening.
   *
   * The Account comes from the flow rather than from the request: the callback has no session, and
   * the row it just wrote already proved which Account owns the pair.
   */
  onCredentialStored?: (accountId: string, agentId: string, mcpServerId: string) => void;
  flows: McpOAuthFlowService;
  publicOrigin: string;
  secureCookies: boolean;
}

export function registerMcpOAuthRoutes(app: FastifyInstance, options: McpOAuthRoutesOptions): void {
  app.get(MCP_OAUTH_CALLBACK_PATH, async (request, reply) => {
    let agentId: string | undefined;
    let mcpServerId: string | undefined;
    /*
     * The cookie is read once and cleared immediately, on every path including the failures: it is
     * single-use by construction, and leaving it would let a reload of the callback URL try again
     * with the same browser binding.
     */
    const flowSecret = parseCookies(request.headers.cookie)[BROWSER_COOKIE_NAMES.mcpOAuthContext];
    clearMcpOAuthContextCookie(reply, MCP_OAUTH_CALLBACK_PATH, options.secureCookies);
    try {
      const query = parseRequest(CallbackQuerySchema, request.query);
      const result = await options.flows.callback(
        {
          state: query.state,
          ...(query.code === undefined ? {} : { code: query.code }),
          ...(query.error === undefined ? {} : { error: query.error }),
          ...(query.iss === undefined ? {} : { iss: query.iss }),
        },
        flowSecret,
        (target) => {
          agentId = target.agentId;
          mcpServerId = target.mcpServerId;
        },
      );
      agentId = result.agentId;
      mcpServerId = result.mcpServerId;
      /*
       * Landing on the Agent's MCP page proves only that a credential was stored. The probe runs
       * backstage so the browser is not held for the upstream round trip; the page polls
       * `probeState` and shows the tool count when it arrives.
       */
      options.onCredentialStored?.(result.accountId, agentId, mcpServerId);
      return reply.redirect(options.flows.redirectFor(agentId, mcpServerId), 302);
    } catch (error) {
      request.log.error({ errorCode: publicCode(error) }, "MCP OAuth callback failed");
      return redirectFailure(reply, options.publicOrigin, agentId, mcpServerId, publicCode(error));
    }
  });

  /*
   * The CIMD document. `client_id` must be this exact URL, so the value is derived from the
   * configured public origin rather than from the request: a spoofed Host header must not be able to
   * change what the document claims to be.
   */
  app.get(MCP_CLIENT_METADATA_PATH, async (_request, reply) => {
    const clientId = new URL(MCP_CLIENT_METADATA_PATH, options.publicOrigin).toString();
    const callback = new URL(MCP_OAUTH_CALLBACK_PATH, options.publicOrigin).toString();
    return reply
      .header("Cache-Control", "public, max-age=3600")
      .code(200)
      .send({
        client_id: clientId,
        client_name: "OpenTag",
        redirect_uris: [callback],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        application_type: "web",
      });
  });
}

/** Only a bounded public code ever reaches the browser; upstream text never does. */
function publicCode(error: unknown): string {
  if (error instanceof McpServiceError) return error.code;
  return MCP_ERROR_CODES.OAUTH_FAILED;
}

function redirectFailure(
  reply: FastifyReply,
  publicOrigin: string,
  agentId: string | undefined,
  mcpServerId: string | undefined,
  code: string,
): FastifyReply {
  if (!agentId) {
    const url = new URL("/agents", publicOrigin);
    url.searchParams.set("mcp_oauth", "error");
    url.searchParams.set("mcp_oauth_error", code);
    return reply.redirect(url.toString(), 302);
  }
  return reply.redirect(flowsRedirect(publicOrigin, agentId, mcpServerId, code), 302);
}

function flowsRedirect(publicOrigin: string, agentId: string, mcpServerId: string | undefined, code: string): string {
  const url = new URL(`/agents/${encodeURIComponent(agentId)}/mcp`, publicOrigin);
  if (mcpServerId) url.searchParams.set("server", mcpServerId);
  url.searchParams.set("mcp_oauth", "error");
  url.searchParams.set("mcp_oauth_error", code);
  return url.toString();
}
