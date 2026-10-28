import {
  type MCPAgentServer,
  MCPAuthSchemeSchema,
  MCPCustomAuthHeaderSchema,
  type MCPEffectiveConfig,
} from "@opentag/shared/browser";
import { useRef } from "react";
import { browserApi } from "../../api.js";
import { type AuthDraft, bindingPatch, headerRows } from "./mcp-form-model.js";
import { type McpOAuthSession, useMcpOAuthSession } from "./mcp-oauth-session.js";
import { closeMcpOAuthWindow, prepareMcpOAuthWindow } from "./mcp-oauth-window.js";
import { useSetMcpAuthorization, useUpdateMcpBinding } from "./mcp-queries.js";
import type { McpReturnContext } from "./mcp-return-context.js";

export function validAuth(draft: AuthDraft): boolean {
  return (
    draft.kind !== "bearer" ||
    Boolean(
      draft.token.trim() &&
        MCPCustomAuthHeaderSchema.safeParse(draft.authHeader).success &&
        MCPAuthSchemeSchema.safeParse(draft.authScheme).success,
    )
  );
}

/** Settings take effect on submission; no candidate credentials or rollback state are stored. */
export function useMcpAuthorization(agentId: string, session?: McpOAuthSession) {
  const authorize = useSetMcpAuthorization(agentId);
  const update = useUpdateMcpBinding(agentId);
  const localSession = useMcpOAuthSession(agentId);
  const oauth = session ?? localSession;
  const inFlight = useRef(false);
  const prepareConfiguration = async (entry: MCPAgentServer, draft: AuthDraft, config?: MCPEffectiveConfig) => {
    const patch = config ? bindingPatch(entry, { ...config, headers: headerRows(config.extraHeaders) }) : {};
    if (entry.authorization && (entry.authorization.kind !== draft.kind || patch.url !== undefined)) {
      await browserApi.revokeMcpAuthorization(agentId, entry.mcpServerId);
    }
    if (Object.keys(patch).length) await update.mutateAsync({ mcpServerId: entry.mcpServerId, ...patch });
  };
  const run = async (
    entry: MCPAgentServer,
    draft: AuthDraft,
    oauthScopes?: readonly string[],
    options?: {
      returnContext?: () => McpReturnContext;
      config?: MCPEffectiveConfig;
    },
  ) => {
    if (inFlight.current) return "cancelled" as const;
    inFlight.current = true;
    const prepared = draft.kind === "oauth" ? prepareMcpOAuthWindow() : undefined;
    try {
      await prepareConfiguration(entry, draft, options?.config);
      if (draft.kind === "oauth") {
        return await oauth.start(
          options?.returnContext?.() ?? { agentId, serverId: entry.mcpServerId, source: "edit" },
          oauthScopes,
          prepared,
        );
      }
      return await authorize.mutateAsync({
        mcpServerId: entry.mcpServerId,
        kind: draft.kind,
        ...(draft.kind === "bearer" ? { bearerKey: draft.token.trim() } : {}),
      });
    } finally {
      closeMcpOAuthWindow(prepared?.popup);
      inFlight.current = false;
    }
  };
  return { run, oauth };
}
