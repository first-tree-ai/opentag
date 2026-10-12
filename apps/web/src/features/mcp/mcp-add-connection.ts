import { type MCPAgentServer, type MCPAuthKind, type MCPServer, MCPServerUrlSchema } from "@opentag/shared/browser";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, browserApi } from "../../api.js";
import * as m from "../../paraglide/messages.js";
import { comparableUrl } from "./catalog/mcp-catalog-model.js";
import type { McpAddProps } from "./mcp-add-dialog.js";
import {
  connectionFailure,
  McpConnectionError,
  requiresConnectionKey,
  useMcpConnectionOperation,
} from "./mcp-connection.js";
import { allowsOAuthDiscovery, connectionAuthKind, connectionPreset } from "./mcp-connection-model.js";
import { suggestServerName } from "./mcp-form-model.js";
import { mcpOAuthIdentity } from "./mcp-oauth-identity.js";
import { closeMcpOAuthWindow, type McpOAuthWindow, prepareMcpOAuthWindow } from "./mcp-oauth-window.js";
import { useAttachMcpServer, useCreateMcpServer, useDetachMcpServer, useMcpServers } from "./mcp-queries.js";
import { discardMcpSetup } from "./mcp-setup-cleanup.js";

type Attempt = {
  url: string;
  kind?: MCPAuthKind;
  server?: MCPServer;
  binding?: MCPAgentServer;
  allowOAuthDiscovery?: boolean;
  temporary?: boolean;
};
export function useMcpAddConnection(props: McpAddProps) {
  const account = useMcpServers();
  const [openingServers, setOpeningServers] = useState<MCPServer[]>();
  const openingMounted = useRef(props.mounted);
  useEffect(() => {
    if (!openingServers && account.data) setOpeningServers(account.data.servers);
  }, [account.data, openingServers]);
  const servers = [...(openingServers ?? account.data?.servers ?? [])].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  );
  const create = useCreateMcpServer(props.agentId);
  const attach = useAttachMcpServer(props.agentId);
  const detach = useDetachMcpServer(props.agentId);
  const operation = useMcpConnectionOperation(props.agentId);
  const [url, setUrl] = useState("");
  const [selectedId, setSelectedId] = useState<string>();
  const [key, setKey] = useState("");
  const [needsKey, setNeedsKey] = useState(false);
  const [urlInvalid, setUrlInvalid] = useState(false);
  const [error, setError] = useState(props.initialError);
  const [phase, setPhase] = useState<"idle" | "connecting" | "tools">("idle");
  const attempt = useRef<Attempt>({ url: "" });
  const provisional = useRef(new Set<string>());
  const discarded = useRef(new Set<string>());
  const inFlight = useRef(false);
  const oauthWindow = useRef<McpOAuthWindow | undefined>(undefined);
  const alive = useRef(true);
  const restored = useRef(false);
  const detachSetup = detach.mutateAsync;
  const discardTemporary = useCallback(
    async (id: string) => {
      if (!provisional.current.delete(id)) return;
      try {
        const removed = await discardMcpSetup(props.agentId, id, (serverId) => detachSetup(serverId));
        if (removed) discarded.current.add(id);
      } catch (cause) {
        provisional.current.add(id);
        throw cause;
      }
    },
    [props.agentId, detachSetup],
  );
  const discardOtherSetups = useCallback(
    async (keep?: string) => {
      for (const id of [...provisional.current]) {
        if (id !== keep) await discardTemporary(id);
      }
    },
    [discardTemporary],
  );
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      closeMcpOAuthWindow(oauthWindow.current?.popup);
      void discardOtherSetups().catch(() => console.warn("Could not clear abandoned MCP setup."));
    };
  }, [discardOtherSetups]);
  useEffect(() => {
    if (restored.current || !props.initialServerId) return;
    const server = account.data?.servers.find((value) => value.id === props.initialServerId);
    if (!server) return;
    restored.current = true;
    const binding = props.mounted.find((entry) => entry.mcpServerId === server.id);
    const value = binding?.effective.url ?? server.url;
    setUrl(value);
    setSelectedId(server.id);
    attempt.current = { url: value, server, binding, kind: connectionAuthKind(value, binding, server) };
  }, [account.data, props.initialServerId, props.mounted]);
  const isAdded = (id: string) => {
    const binding = openingMounted.current.find((entry) => entry.mcpServerId === id);
    return Boolean(
      binding &&
        (!binding.enabled ||
          (binding.authorization?.status === "active" &&
            binding.authorization.probeState === "succeeded" &&
            (binding.authorization.toolsCount ?? 0) > 0)),
    );
  };
  const reset = (value: string, server?: MCPServer) => {
    if (inFlight.current) return;
    restored.current = true;
    const binding = server ? props.mounted.find((entry) => entry.mcpServerId === server.id) : undefined;
    setUrl(value);
    setSelectedId(server?.id);
    setNeedsKey(false);
    setKey("");
    setError(undefined);
    setUrlInvalid(false);
    attempt.current = {
      url: value.trim(),
      server,
      binding,
      temporary: binding ? provisional.current.has(binding.mcpServerId) : undefined,
      kind: server ? connectionAuthKind(value, binding, server) : undefined,
    };
  };
  const choose = (server: MCPServer) => {
    if (selectedId !== server.id)
      reset(props.mounted.find((entry) => entry.mcpServerId === server.id)?.effective.url ?? server.url, server);
  };
  const validUrl =
    MCPServerUrlSchema.safeParse(url).success && /^https?:\/\/[^/\\?#\s]+(?:[/?][^\s\\]*)?$/i.test(url.trim());

  async function resolveServer(current: Attempt): Promise<MCPServer> {
    if (current.server) return current.server;
    const input = newServerInput(current, servers);
    try {
      return await create.mutateAsync(input);
    } catch (cause) {
      if (!(cause instanceof ApiError) || cause.code !== "MCP_SERVER_NAME_CONFLICT") throw cause;
      const latest = await browserApi.mcpServers();
      const matches = latest.servers.filter((server) => comparableUrl(server.url) === comparableUrl(current.url));
      if (matches.length === 1) return matches[0] as MCPServer;
      if (matches.length > 1) throw new Error("ambiguous");
      return await create.mutateAsync({ ...input, name: suggestServerName(current.url, latest.servers) });
    }
  }
  async function resolveBinding(current: Attempt) {
    if (current.binding) return current.binding;
    const server = current.server;
    if (!server) throw new Error("missing_server");
    try {
      const binding = await attach.mutateAsync(server.id);
      provisional.current.add(server.id);
      discarded.current.delete(server.id);
      current.temporary = true;
      return binding;
    } catch (cause) {
      if (!(cause instanceof ApiError) || cause.code !== "MCP_BINDING_CONFLICT") throw cause;
      const latest = await browserApi.agentMcpServers(props.agentId);
      const binding = latest.servers.find((entry) => entry.mcpServerId === server.id);
      if (!binding) throw cause;
      return binding;
    }
  }
  function prepareAttempt(current: Attempt) {
    if (!current.server) {
      const match = uniqueServer(current.url, account.data?.servers ?? servers);
      if (match) {
        current.server = match;
        setSelectedId(match.id);
      }
    }
    current.binding ??= props.mounted.find(
      (entry) => entry.mcpServerId === current.server?.id && !discarded.current.has(entry.mcpServerId),
    );
    current.kind ??= connectionAuthKind(current.url, current.binding, current.server);
    current.allowOAuthDiscovery ??= allowsOAuthDiscovery(current.url, current.kind);
  }
  function requireKey(current: Attempt, focusKey: () => void) {
    if (!requiresConnectionKey(current.kind, current.binding, key)) return false;
    setNeedsKey(true);
    requestAnimationFrame(focusKey);
    return true;
  }
  async function authorizeConnection(current: Attempt) {
    if (!current.binding || !current.kind) return;
    const pending = { binding: current.binding, kind: current.kind, allowOAuthDiscovery: current.allowOAuthDiscovery };
    try {
      const result = await operation.run(pending, {
        oauthWindow: oauthWindow.current,
        token: key,
        source: "add",
        returnContext: { newBinding: current.temporary },
        onTools: () => setPhase("tools"),
        isAlive: () => alive.current,
      });
      if (alive.current && result === "connected") {
        provisional.current.delete(pending.binding.mcpServerId);
        await discardOtherSetups();
        props.onAdded(pending.binding);
      } else if (result === "cancelled" && current.temporary) {
        await discardTemporary(pending.binding.mcpServerId);
        current.binding = undefined;
        current.temporary = false;
      }
    } finally {
      if (current.temporary !== false) current.binding = pending.binding;
      current.kind = pending.kind;
    }
  }
  async function runConnection(current: Attempt, focusKey: () => void) {
    prepareAttempt(current);
    if (current.binding && !current.binding.enabled) {
      props.onLocate(current.binding.mcpServerId);
      return;
    }
    if (requireKey(current, focusKey)) return;
    current.server = await resolveServer(current);
    if (!alive.current) return;
    current.binding = await resolveBinding(current);
    if (alive.current) await authorizeConnection(current);
    else if (current.temporary) await discardTemporary(current.binding.mcpServerId);
  }
  function reportFailure(cause: unknown) {
    if (!alive.current) return;
    if (cause instanceof McpConnectionError && cause.reason === "key") setNeedsKey(true);
    setError(connectionError(cause, attempt.current.kind));
  }
  async function connect(focusKey: () => void) {
    if (inFlight.current || !url.trim() || !account.data) return;
    if (!validUrl) {
      setUrlInvalid(true);
      return;
    }
    oauthWindow.current =
      connectionAuthKind(url, attempt.current.binding, attempt.current.server) === "oauth"
        ? prepareMcpOAuthWindow(mcpOAuthIdentity(url, attempt.current.server?.name))
        : undefined;
    inFlight.current = true;
    setPhase("connecting");
    setError(undefined);
    try {
      await discardOtherSetups(attempt.current.binding?.mcpServerId ?? attempt.current.server?.id);
      await runConnection(attempt.current, focusKey);
    } catch (cause) {
      reportFailure(cause);
    } finally {
      closeMcpOAuthWindow(oauthWindow.current?.popup);
      inFlight.current = false;
      if (alive.current) setPhase("idle");
    }
  }

  async function close() {
    if (inFlight.current) return;
    const current = attempt.current;
    if (!provisional.current.size) {
      props.onClose();
      return;
    }
    inFlight.current = true;
    setPhase("connecting");
    try {
      await discardOtherSetups();
      props.onClose();
    } catch (cause) {
      setError(connectionError(cause, current.kind));
    } finally {
      inFlight.current = false;
      if (alive.current) setPhase("idle");
    }
  }
  return {
    close,
    account,
    oauth: operation.oauth,
    servers,
    selectedId,
    url,
    key,
    needsKey,
    urlInvalid,
    error,
    phase,
    busy: phase !== "idle",
    choose,
    isAdded,
    connect,
    validateUrl: () => setUrlInvalid(Boolean(url.trim()) && !validUrl),
    changeUrl: (value: string) => reset(value),
    changeKey: (value: string) => {
      setKey(value);
      setError(undefined);
    },
    canConnect: phase === "idle" && Boolean(url.trim()) && Boolean(account.data) && (!needsKey || Boolean(key.trim())),
  };
}

function connectionError(cause: unknown, kind?: MCPAuthKind): string {
  if (cause instanceof Error && cause.message === "ambiguous") return m.mcp_add_choose_existing();
  return connectionFailure(cause, kind);
}

function uniqueServer(url: string, servers: readonly MCPServer[]): MCPServer | undefined {
  const matches = servers.filter((server) => comparableUrl(server.url) === comparableUrl(url));
  if (matches.length > 1) throw new Error("ambiguous");
  return matches[0];
}
function newServerInput(current: Attempt, servers: readonly MCPServer[]) {
  const preset = connectionPreset(current.url);
  const input = {
    name:
      preset && !servers.some((server) => server.name === preset.name)
        ? preset.name
        : suggestServerName(current.url, servers),
    url: current.url,
    defaultAuthKind: current.kind ?? ("none" as const),
    ...(preset?.authHeader ? { authHeader: preset.authHeader } : {}),
    ...(preset?.authScheme !== undefined ? { authScheme: preset.authScheme } : {}),
    ...(preset?.extraHeaders ? { extraHeaders: preset.extraHeaders } : {}),
  };
  return input;
}
