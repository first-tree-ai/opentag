import { MCP_CATALOG_ENTRIES } from "@opentag/mcp-presets";
import { type MCPAgentServer, type MCPAuthKind, type MCPServer, MCPServerUrlSchema } from "@opentag/shared/browser";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, browserApi } from "../../api.js";
import * as m from "../../paraglide/messages.js";
import { comparableUrl, findCatalogBinding, findCatalogEntryByUrl } from "./catalog/mcp-catalog-model.js";
import type { McpAddProps } from "./mcp-add-dialog.js";
import {
  connectionFailure,
  McpConnectionError,
  requiresConnectionKey,
  requiresOAuth,
  useMcpConnectionOperation,
} from "./mcp-connection.js";
import { connectionAuthKind, connectionPreset } from "./mcp-connection-model.js";
import { connectorFeedback } from "./mcp-feedback.js";
import {
  authDraft,
  bindingPatch,
  defaultConnection,
  headersFromRows,
  suggestServerName,
  validHeaders,
  validTokenSettings,
} from "./mcp-form-model.js";
import { createMcpInstallation } from "./mcp-installation.js";
import { closeMcpOAuthWindow, type McpOAuthWindow, prepareMcpOAuthWindow } from "./mcp-oauth-window.js";
import {
  useAttachMcpServer,
  useCreateMcpServer,
  useDetachMcpServer,
  useMcpInstallationDefinitions,
  useUpdateMcpBinding,
} from "./mcp-queries.js";
import { discardMcpSetup } from "./mcp-setup-cleanup.js";

type Attempt = {
  url: string;
  kind?: MCPAuthKind;
  server?: MCPServer;
  binding?: MCPAgentServer;
  temporary?: boolean;
  authHeader?: string;
  authScheme?: string;
  extraHeaders?: Record<string, string>;
  progressId?: string;
};
export function useMcpAddConnection(props: McpAddProps) {
  const [restoreId, setRestoreId] = useState(props.initialServerId);
  const definitions = useMcpInstallationDefinitions(props.mounted, restoreId);
  const create = useCreateMcpServer(props.agentId);
  const attach = useAttachMcpServer(props.agentId);
  const detach = useDetachMcpServer(props.agentId);
  const operation = useMcpConnectionOperation(props.agentId);
  const [sessionId, setSessionId] = useState(props.initialServerId);
  const [url, setUrl] = useState("");
  const [authentication, setAuthentication] = useState(() => authDraft(defaultConnection, "oauth"));
  const update = useUpdateMcpBinding(props.agentId);
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
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      // Submitted configuration remains installed when this view closes.
    };
  }, []);
  useEffect(() => {
    if (restored.current || !props.initialServerId) return;
    const server = definitions.servers.find((server) => server.id === props.initialServerId);
    if (!server) return;
    restored.current = true;
    const binding = props.mounted.find((entry) => entry.mcpServerId === server.id);
    const value = binding?.effective.url ?? server.url;
    setUrl(value);
    setAuthentication(
      authDraft(binding?.effective ?? { ...defaultConnection, url: value }, connectionAuthKind(value, binding, server)),
    );
    attempt.current = { url: value, server, binding, kind: connectionAuthKind(value, binding, server) };
  }, [definitions.servers, props.initialServerId, props.mounted]);
  const reset = (value: string) => {
    if (inFlight.current) return;
    restored.current = true;
    setRestoreId(undefined);
    setUrl(value);
    setNeedsKey(false);
    setError(undefined);
    setUrlInvalid(false);
    attempt.current = { url: value.trim(), kind: authentication.kind };
  };
  const validUrl =
    MCPServerUrlSchema.safeParse(url).success && /^https?:\/\/[^/\\?#\s]+(?:[/?][^\s\\]*)?$/i.test(url.trim());

  async function resolveServer(current: Attempt): Promise<MCPServer> {
    if (current.server) return current.server;
    if (current.binding) return (await browserApi.mcpServer(current.binding.mcpServerId)).server;
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
    if (current.binding) {
      const serverId = current.binding.mcpServerId;
      current.binding = props.mounted.find((entry) => entry.mcpServerId === serverId) ?? current.binding;
    }
    current.kind = authentication.kind;
    current.authHeader = authentication.authHeader;
    current.authScheme = authentication.authScheme;
    current.extraHeaders = headersFromRows(authentication.headers);
  }
  function installedBinding(value: string) {
    const preset = findCatalogEntryByUrl(value, MCP_CATALOG_ENTRIES);
    const installed = props.mounted.filter((entry) => !discarded.current.has(entry.mcpServerId));
    return (
      installed.find((entry) => comparableUrl(entry.effective.url) === comparableUrl(value)) ??
      (preset ? findCatalogBinding(preset, definitions.servers, installed) : undefined)
    );
  }
  function locateInstalled(current: Attempt): boolean {
    if (current.server || current.binding) return false;
    const installed = installedBinding(current.url);
    if (!installed) return false;
    if (provisional.current.has(installed.mcpServerId)) {
      current.binding = installed;
      current.temporary = true;
      return false;
    }
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
    const pending = { binding: current.binding, kind: current.kind };
    try {
      const result = await operation.run(pending, {
        oauthSession: props.oauthSessionFor?.(pending.binding.mcpServerId),
        oauthWindow: oauthWindow.current,
        reauthorize: connectorFeedback(pending.binding).action === "authorize",
        token: key,
        source: "add",
        returnContext: { newBinding: current.temporary },
        onTools: () => {
          if (alive.current) setPhase("tools");
        },
        isAlive: () => true,
      });
      if (result === "connected") {
        provisional.current.delete(pending.binding.mcpServerId);
        if (alive.current) props.onAdded(pending.binding);
      } else if (result === "cancelled") await cancelTemporary(current, pending.binding.mcpServerId);
    } finally {
      if (current.temporary !== false) current.binding = pending.binding;
      current.kind = pending.kind;
    }
  }
  async function cancelTemporary(current: Attempt, id: string) {
    if (!current.temporary) return;
    await discardTemporary(id);
    if (discarded.current.has(id)) {
      current.binding = undefined;
      current.server = undefined;
      current.temporary = false;
    }
  }
  async function applyConfiguration(current: Attempt) {
    if (!current.binding) return;
    const patch = bindingPatch(current.binding, {
      url: current.url,
      authHeader: authentication.authHeader,
      authScheme: authentication.authScheme,
      headers: authentication.headers,
    });
    if (current.binding.authorization && current.binding.authorization.kind !== current.kind) {
      await browserApi.revokeMcpAuthorization(props.agentId, current.binding.mcpServerId);
    }
    if (Object.keys(patch).length)
      current.binding = await update.mutateAsync({ mcpServerId: current.binding.mcpServerId, ...patch });
  }
  async function runConnection(current: Attempt, focusKey: () => void) {
    if (current.binding && !current.binding.enabled) {
      props.onLocate(current.binding.mcpServerId);
      return;
    }
    if (requireKey(current, focusKey)) return;
    try {
      current.server = await resolveServer(current);
      current.binding = await resolveBinding(current);
      current.progressId = current.binding.mcpServerId;
      setSessionId(current.binding.mcpServerId);
      props.onProgress?.(current.binding.mcpServerId, true);
      await applyConfiguration(current);
    } catch (cause) {
      reportFailure(cause, m.mcp_add_failed());
      return;
    }
    await authorizeConnection(current);
  }
  function reportFailure(cause: unknown, fallback?: string) {
    const label = connectionFailure(cause, attempt.current.kind, fallback);
    if (!alive.current) {
      const id = attempt.current.binding?.mcpServerId;
      if (id) props.onFailure?.(id, label);
      return;
    }
    if (cause instanceof McpConnectionError && cause.reason === "key") setNeedsKey(true);
    setError(label);
  }
  function clearProgress() {
    const id = attempt.current.progressId;
    if (id) props.onProgress?.(id, false);
    attempt.current.progressId = undefined;
  }
  async function connect(focusKey: () => void) {
    if (inFlight.current || !url.trim() || definitions.isPending || definitions.isError) return;
    if (!validUrl) {
      setUrlInvalid(true);
      return;
    }
    if (locateInstalled(attempt.current)) return;
    prepareAttempt(attempt.current);
    oauthWindow.current = needsOAuth(attempt.current) ? prepareMcpOAuthWindow() : undefined;
    inFlight.current = true;
    setPhase("connecting");
    setError(undefined);
    setNeedsKey(false);
    try {
      await runConnection(attempt.current, focusKey);
    } catch (cause) {
      reportFailure(cause);
    } finally {
      closeMcpOAuthWindow(oauthWindow.current?.popup);
      clearProgress();
      inFlight.current = false;
      if (alive.current) setPhase("idle");
    }
  }

  function close() {
    props.onClose();
  }
  return {
    close,
    definitions,
    oauth: (sessionId && props.oauthSessionFor?.(sessionId)) || operation.oauth,
    url,
    key,
    needsKey,
    authentication: { ...authentication, token: key },
    changeAuthentication: (next: typeof authentication) => {
      setAuthentication(next);
      setKey(next.token);
      attempt.current.kind = next.kind;
      setError(undefined);
    },
    configuration: {
      url,
      authHeader: authentication.authHeader,
      authScheme: authentication.authScheme,
      headers: authentication.headers,
    },
    changeConfiguration: (next: { authHeader: string; authScheme: string; headers: typeof authentication.headers }) => {
      setAuthentication((current) => ({ ...current, ...next }));
      setError(undefined);
    },
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
      (authentication.kind !== "bearer" || Boolean(key.trim())) &&
      (authentication.kind !== "bearer" || validTokenSettings(authentication)) &&
      validHeaders(
        authentication.headers,
        authentication.kind === "oauth"
          ? "authorization"
          : authentication.kind === "bearer"
            ? authentication.authHeader
            : "",
      ),
  };
}

function needsOAuth(current: Attempt): boolean {
  if (current.kind !== "oauth") return false;
  if (!current.binding) return true;
  return requiresOAuth(
    { binding: current.binding, kind: current.kind },
    connectorFeedback(current.binding).action === "authorize",
  );
}

function newServerInput(current: Attempt) {
  const preset = connectionPreset(current.url);
  const input = {
    name: preset?.name ?? suggestServerName(current.url, []),
    url: current.url,
    defaultAuthKind: current.kind ?? ("none" as const),
    authHeader: current.authHeader,
    authScheme: current.authScheme,
    extraHeaders: current.extraHeaders,
  };
  return input;
}
