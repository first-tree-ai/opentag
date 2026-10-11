import type { McpCatalogEntry } from "@opentag/mcp-presets";
import type { MCPAgentServer } from "@opentag/shared/browser";
import { useRef, useState } from "react";
import * as m from "../../../paraglide/messages.js";
import { useMcpAuthorization } from "../mcp-authorize-dialog.js";
import { actionError, authDraft, connectionHeaderMode } from "../mcp-form-model.js";
import { useProbeMcpServer } from "../mcp-queries.js";
import { rememberMcpReturn } from "../mcp-return-context.js";
import { comparableUrl } from "./mcp-catalog-model.js";

/** Runs on the page so closing Discover cannot interrupt the connection or hide its error. */
export function useMcpCatalogConnection(agentId: string) {
  const authorize = useMcpAuthorization(agentId);
  const probe = useProbeMcpServer(agentId);
  const inFlight = useRef(false);
  const [connectingId, setConnectingId] = useState<string>();
  const [failure, setFailure] = useState<{ binding: MCPAgentServer; catalog: McpCatalogEntry; message: string }>();
  const connect = async (binding: MCPAgentServer, catalog: McpCatalogEntry) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setConnectingId(binding.mcpServerId);
    setFailure(undefined);
    try {
      if (binding.authorization?.status === "active") {
        if (binding.authorization.probeState === "pending") await probe.mutateAsync(binding.mcpServerId);
        return;
      }
      const kind = binding.authorization?.kind ?? catalog.defaultAuthKind;
      const draft = { ...authDraft(binding.effective, kind), headerMode: connectionHeaderMode(binding) };
      const scopes =
        comparableUrl(binding.effective.url) === comparableUrl(catalog.url) ? catalog.oauthScopes : undefined;
      await authorize(binding, draft, scopes, {
        connectionSettings: false,
        onBeforeOAuth: () => rememberMcpReturn({ agentId, serverId: binding.mcpServerId, source: "authorize" }),
      });
    } catch (cause) {
      setFailure({ binding, catalog, message: actionError(cause, m.mcp_authorize_failed()) });
    } finally {
      inFlight.current = false;
      setConnectingId(undefined);
    }
  };
  return {
    connect,
    connectingId,
    failure,
    clearFailure: () => setFailure(undefined),
    errorFor: (id: string) => (failure?.binding.mcpServerId === id ? failure.message : undefined),
  };
}
