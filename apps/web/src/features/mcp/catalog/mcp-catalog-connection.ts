import type { MCPAgentServer, MCPServer } from "@opentag/shared/browser";
import { useEffect, useRef, useState } from "react";
import { browserApi } from "../../../api.js";
import {
  type ConnectionAttempt,
  connectionFailure,
  isKeyFailure,
  requiresOAuth,
  useMcpConnectionOperation,
} from "../mcp-connection.js";
import { connectionAuthKind } from "../mcp-connection-model.js";
import { closeMcpOAuthWindow, prepareMcpOAuthWindow } from "../mcp-oauth-window.js";

/** Page-owned recovery for installed connections; errors remain visible outside dialogs. */
export function useMcpCatalogConnection(agentId: string) {
  const operation = useMcpConnectionOperation(agentId);
  const inFlight = useRef(false);
  const alive = useRef(true);
  const [connectingId, setConnectingId] = useState<string>();
  const [failure, setFailure] = useState<{ binding: MCPAgentServer; message: string }>();
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const connect = async (binding: MCPAgentServer, token?: string, definition?: MCPServer, reauthorize = false) => {
    if (inFlight.current || !binding.enabled) return "busy" as const;
    const kind = connectionAuthKind(binding.effective.url, binding, definition);
    const oauthWindow = requiresOAuth({ binding, kind }, reauthorize) ? prepareMcpOAuthWindow() : undefined;
    inFlight.current = true;
    setConnectingId(binding.mcpServerId);
    setFailure(undefined);
    try {
      const attempt = await resolveAttempt(binding, definition);
      const result = await operation.run(attempt, {
        token,
        reauthorize,
        source: "authorize",
        isAlive: () => alive.current,
        oauthWindow,
      });
      return alive.current ? result : ("busy" as const);
    } catch (cause) {
      return reportFailure(binding, cause, definition);
    } finally {
      closeMcpOAuthWindow(oauthWindow?.popup);
      inFlight.current = false;
      if (alive.current) setConnectingId(undefined);
    }
  };
  function reportFailure(binding: MCPAgentServer, cause: unknown, definition?: MCPServer) {
    if (!alive.current) return "busy" as const;
    setFailure({
      binding,
      message: connectionFailure(cause, connectionAuthKind(binding.effective.url, binding, definition)),
    });
    return isKeyFailure(cause) ? ("key" as const) : ("failed" as const);
  }
  return {
    connect,
    oauth: operation.oauth,
    connectingId,
    failure,
    clearFailure: () => setFailure(undefined),
    errorFor: (id: string) => (failure?.binding.mcpServerId === id ? failure.message : undefined),
  };
}

async function resolveAttempt(binding: MCPAgentServer, definition?: MCPServer): Promise<ConnectionAttempt> {
  const server =
    definition ?? (binding.authorization ? undefined : (await browserApi.mcpServer(binding.mcpServerId)).server);
  return { binding, kind: connectionAuthKind(binding.effective.url, binding, server) };
}
