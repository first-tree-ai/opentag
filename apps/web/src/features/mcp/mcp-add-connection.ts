import { MCP_CATALOG_ENTRIES } from "@opentag/mcp-presets";
import { type MCPAgentServer, type MCPAuthKind, type MCPServer, MCPServerUrlSchema } from "@opentag/shared/browser";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, browserApi } from "../../api.js";
import { comparableUrl, findCatalogBinding, findCatalogEntryByUrl } from "./catalog/mcp-catalog-model.js";
import type { McpAddProps } from "./mcp-add-dialog.js";
import {
  connectionFailure,
  McpConnectionError,
  requiresConnectionKey,
  useMcpConnectionOperation,
} from "./mcp-connection.js";
import { allowsOAuthDiscovery, connectionAuthKind, connectionPreset } from "./mcp-connection-model.js";
import { suggestServerName } from "./mcp-form-model.js";
import { createMcpInstallation } from "./mcp-installation.js";
import { closeMcpOAuthWindow, type McpOAuthWindow, prepareMcpOAuthWindow } from "./mcp-oauth-window.js";
import {
  useAttachMcpServer,
  useCreateMcpServer,
  useDetachMcpServer,
  useMcpInstallationDefinitions,
} from "./mcp-queries.js";
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
  const [restoreId, setRestoreId] = useState(props.initialServerId);
  const definitions = useMcpInstallationDefinitions(props.mounted, restoreId);
  const create = useCreateMcpServer(props.agentId);
  const attach = useAttachMcpServer(props.agentId);
  const detach = useDetachMcpServer(props.agentId);
  const operation = useMcpConnectionOperation(props.agentId);
  const [url, setUrl] = useState("");
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
    const server = definitions.servers.find((server) => server.id === props.initialServerId);
    if (!server) return;
    restored.current = true;
    const binding = props.mounted.find((entry) => entry.mcpServerId === server.id);
    const value = binding?.effective.url ?? server.url;
    setUrl(value);
    attempt.current = { url: value, server, binding, kind: connectionAuthKind(value, binding, server) };
  }, [definitions.servers, props.initialServerId, props.mounted]);
  const reset = (value: string) => {
    if (inFlight.current) return;
    restored.current = true;
    setRestoreId(undefined);
    setUrl(value);
    setNeedsKey(false);
    setKey("");
    setError(undefined);
    setUrlInvalid(false);
    attempt.current = { url: value.trim() };
  };
  const validUrl =
    MCPServerUrlSchema.safeParse(url).success && /^https?:\/\/[^/\\?#\s]+(?:[/?][^\s\\]*)?$/i.test(url.trim());

  async function resolveServer(current: Attempt): Promise<MCPServer> {
    if (current.server) return current.server;
    return await createMcpInstallation(newServerInput(current), create.mutateAsync);
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
    current.kind ??= connectionAuthKind(current.url, current.binding, current.server);
    current.allowOAuthDiscovery ??= allowsOAuthDiscovery(current.url, current.kind);
  }
  function installedBinding(value: string) {
    const preset = findCatalogEntryByUrl(value, MCP_CATALOG_ENTRIES);
    // Locating this dialog's temporary setup would close and discard the same mount.
    const installed = props.mounted.filter(
      (entry) => !discarded.current.has(entry.mcpServerId) && !provisional.current.has(entry.mcpServerId),
    );
    return (
      installed.find((entry) => comparableUrl(entry.effective.url) === comparableUrl(value)) ??
      (preset ? findCatalogBinding(preset, definitions.servers, installed) : undefined)
    );
  }
  function locateInstalled(current: Attempt): boolean {
    if (current.server || current.binding) return false;
    const installed = installedBinding(current.url);
    if (!installed) return false;
    props.onLocate(installed.mcpServerId);
    return true;
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
    setError(connectionFailure(cause, attempt.current.kind));
  }
  async function connect(focusKey: () => void) {
    if (inFlight.current || !url.trim() || definitions.isPending || definitions.isError) return;
    if (!validUrl) {
      setUrlInvalid(true);
      return;
    }
    if (locateInstalled(attempt.current)) return;
    oauthWindow.current =
      connectionAuthKind(url, attempt.current.binding, attempt.current.server) === "oauth"
        ? prepareMcpOAuthWindow()
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
      setError(connectionFailure(cause, current.kind));
    } finally {
      inFlight.current = false;
      if (alive.current) setPhase("idle");
    }
  }
  return {
    close,
    definitions,
    oauth: operation.oauth,
    url,
    key,
    needsKey,
    urlInvalid,
    error,
    phase,
    busy: phase !== "idle",
    connect,
    validateUrl: () => setUrlInvalid(Boolean(url.trim()) && !validUrl),
    changeUrl: (value: string) => reset(value),
    changeKey: (value: string) => {
      setKey(value);
      setError(undefined);
    },
    canConnect:
      phase === "idle" &&
      !definitions.isPending &&
      !definitions.isError &&
      Boolean(url.trim()) &&
      (!needsKey || Boolean(key.trim())),
  };
}

function newServerInput(current: Attempt) {
  const preset = connectionPreset(current.url);
  const input = {
    name: preset?.name ?? suggestServerName(current.url, []),
    url: current.url,
    defaultAuthKind: current.kind ?? ("none" as const),
    ...(preset?.authHeader ? { authHeader: preset.authHeader } : {}),
    ...(preset?.authScheme !== undefined ? { authScheme: preset.authScheme } : {}),
    ...(preset?.extraHeaders ? { extraHeaders: preset.extraHeaders } : {}),
  };
  return input;
}
