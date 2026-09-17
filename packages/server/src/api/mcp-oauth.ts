/*
 * The two unauthenticated MCP paths.
 *
 * `/api/v1/mcp-servers/oauth/callback` authenticates its own caller with the one-time `state` the
 * flow row holds, exactly as the GitHub and Slack callbacks do — there is no session to lean on
 * because the browser arrives from the authorization server. It redirects only to a fixed local
 * surface carrying a bounded outcome, and it never echoes the authorization server's
 * `error_description` back to the browser.
 *
 * `/oauth/client-metadata.json` is this deployment's public Client ID Metadata Document. It contains
 * only what the specification requires of a public client: the client ID (this same URL), a name,
 * and the redirect URIs. Nothing here is a secret, and nothing here names an Account.
 */

import { MCP_CLIENT_METADATA_PATH, MCP_ERROR_CODES, MCP_OAUTH_CALLBACK_PATH } from "@opentag/shared";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
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
  flows: McpOAuthFlowService;
  publicOrigin: string;
}

export function registerMcpOAuthRoutes(app: FastifyInstance, options: McpOAuthRoutesOptions): void {
  app.get(MCP_OAUTH_CALLBACK_PATH, async (request, reply) => {
    let agentId: string | undefined;
    let mcpServerId: string | undefined;
    try {
      const query = parseRequest(CallbackQuerySchema, request.query);
      const result = await options.flows.callback({
        state: query.state,
        ...(query.code === undefined ? {} : { code: query.code }),
        ...(query.error === undefined ? {} : { error: query.error }),
        ...(query.iss === undefined ? {} : { iss: query.iss }),
      });
      agentId = result.agentId;
      mcpServerId = result.mcpServerId;
      /*
       * Landing on the Agent's MCP page proves only that a credential was stored. The probe runs
       * backstage so the browser is not held for the upstream round trip; the page polls
       * `probeState` and shows the tool count when it arrives.
       */
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
