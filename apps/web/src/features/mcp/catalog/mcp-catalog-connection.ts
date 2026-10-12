import type { MCPAgentServer, MCPServer } from "@opentag/shared/browser";
import { useEffect, useRef, useState } from "react";
import { browserApi } from "../../../api.js";
import {
  type ConnectionAttempt,
  connectionFailure,
  isKeyFailure,
  useMcpConnectionOperation,
} from "../mcp-connection.js";
import { allowsOAuthDiscovery, connectionAuthKind } from "../mcp-connection-model.js";

/** Runs on the page so closing Discover cannot interrupt a connection or hide its error. */
export function useMcpCatalogConnection(agentId: string) {
  const operation = useMcpConnectionOperation(agentId);
  const inFlight = useRef(false);
  const alive = useRef(true);
  const attempts = useRef(new Map<string, ConnectionAttempt>());
  const [connectingId, setConnectingId] = useState<string>();
  const [failure, setFailure] = useState<{ binding: MCPAgentServer; message: string }>();
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const connect = async (binding: MCPAgentServer, token?: string, definition?: MCPServer) => {
    if (inFlight.current || !binding.enabled) return "busy" as const;
    inFlight.current = true;
    setConnectingId(binding.mcpServerId);
    setFailure(undefined);
    try {
      const attempt = await resolveAttempt(binding, definition, attempts.current.get(binding.mcpServerId));
      attempts.current.set(binding.mcpServerId, attempt);
      const result = await operation(attempt, { token, source: "authorize", isAlive: () => alive.current });
      return alive.current ? result : ("busy" as const);
    } catch (cause) {
      return reportFailure(binding, cause);
    } finally {
      inFlight.current = false;
      if (alive.current) setConnectingId(undefined);
    }
  };
  function reportFailure(binding: MCPAgentServer, cause: unknown) {
    if (!alive.current) return "busy" as const;
    setFailure({ binding, message: connectionFailure(cause, attempts.current.get(binding.mcpServerId)?.kind) });
    return isKeyFailure(cause) ? ("key" as const) : ("failed" as const);
  }
  return {
    connect,
    connectingId,
    failure,
    clearFailure: () => setFailure(undefined),
    errorFor: (id: string) => (failure?.binding.mcpServerId === id ? failure.message : undefined),
  };
}

function sameConfiguration(
  previous: ConnectionAttempt | undefined,
  binding: MCPAgentServer,
): previous is ConnectionAttempt {
  return Boolean(
    previous &&
      JSON.stringify(previous.binding.effective) === JSON.stringify(binding.effective) &&
      previous.binding.authorization?.kind === binding.authorization?.kind &&
      previous.binding.authorization?.revision === binding.authorization?.revision,
  );
}

async function resolveAttempt(
  binding: MCPAgentServer,
  definition: MCPServer | undefined,
  previous: ConnectionAttempt | undefined,
): Promise<ConnectionAttempt> {
  const server =
    definition ?? (binding.authorization ? undefined : (await browserApi.mcpServer(binding.mcpServerId)).server);
  const same = sameConfiguration(previous, binding);
  return {
    binding,
    kind:
      same && previous.kind === "oauth" && previous.allowOAuthDiscovery
        ? "oauth"
        : connectionAuthKind(binding.effective.url, binding, server),
    allowOAuthDiscovery: same
      ? previous.allowOAuthDiscovery
      : allowsOAuthDiscovery(binding.effective.url, connectionAuthKind(binding.effective.url, binding, server)),
  };
}
