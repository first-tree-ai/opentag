import type { McpCatalogEntry } from "@opentag/mcp-presets";
import { CreateMCPServerRequestSchema, type MCPAgentServer, type MCPServer } from "@opentag/shared/browser";
import { useEffect, useRef, useState } from "react";
import { browserApi } from "../../../api.js";
import * as m from "../../../paraglide/messages.js";
import { connectionFailure, useMcpConnectionOperation } from "../mcp-connection.js";
import { allowsOAuthDiscovery, connectionAuthKind } from "../mcp-connection-model.js";
import { actionError } from "../mcp-form-model.js";
import { mcpOAuthIdentity } from "../mcp-oauth-identity.js";
import { closeMcpOAuthWindow, type McpOAuthWindow, prepareMcpOAuthWindow } from "../mcp-oauth-window.js";
import { useAttachMcpServer, useCreateMcpServer, useDetachMcpServer, useMcpServers } from "../mcp-queries.js";
import type { McpReturnContext } from "../mcp-return-context.js";
import { discardMcpSetup } from "../mcp-setup-cleanup.js";
import { findAccountServer, findCatalogBinding } from "./mcp-catalog-model.js";

export type DiscoverProps = {
  agentId: string;
  agentName: string;
  mounted: MCPAgentServer[];
  onClose: () => void;
  onAdded: (entry: MCPAgentServer, catalog: McpCatalogEntry, server?: MCPServer) => void;
  initialContext?: McpReturnContext;
  initialOutcome?: "cancelled" | "failed";
};
type Setup = { catalog: McpCatalogEntry; binding: MCPAgentServer; server?: MCPServer; temporary: boolean };
const catalogAction = (binding?: MCPAgentServer): "add" | "connect" => (binding ? "connect" : "add");

/** Keep Discover mounted until the user finishes, and never detach a pre-existing connection. */
export function useMcpDiscoverState(props: DiscoverProps) {
  const account = useMcpServers();
  const servers = account.data?.servers ?? [];
  const create = useCreateMcpServer(props.agentId);
  const attach = useAttachMcpServer(props.agentId);
  const detach = useDetachMcpServer(props.agentId);
  const operation = useMcpConnectionOperation(props.agentId);
  const [error, setError] = useState<string | undefined>(
    props.initialOutcome === "failed" ? m.mcp_oauth_return_failed() : undefined,
  );
  const [notice, setNotice] = useState<string | undefined>(
    props.initialOutcome === "cancelled" ? m.mcp_oauth_cancelled() : undefined,
  );
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [pendingEntryId, setPendingEntryId] = useState<string>();
  const [pendingAction, setPendingAction] = useState<"add" | "connect">();
  const [keySetup, setKeySetup] = useState<Setup>();
  const [connectedIds, setConnectedIds] = useState<string[]>([]);
  const created = useRef(new Map<string, MCPServer>());
  const inFlight = useRef(false);
  const alive = useRef(true);
  const preparedWindow = useRef<McpOAuthWindow | undefined>(undefined);
  const view = useRef({
    query: props.initialContext?.query ?? "",
    categoryId: props.initialContext?.categoryId ?? "",
    scrollTop: props.initialContext?.scrollTop ?? 0,
  });
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      closeMcpOAuthWindow(preparedWindow.current?.popup);
    };
  }, []);
  const restoreStarted = useRef(false);
  useEffect(() => {
    const context = props.initialContext;
    if (!context || restoreStarted.current || account.isPending) return;
    restoreStarted.current = true;
    if (!context.newBinding) return;
    setBusy(true);
    void (async () => {
      const current = (await browserApi.agentMcpServers(props.agentId)).servers.find(
        (entry) => entry.mcpServerId === context.serverId,
      );
      if (current && !current.authorization?.hasCredential) await detach.mutateAsync(context.serverId);
    })()
      .catch((cause) => setError(actionError(cause, m.mcp_setup_cleanup_failed())))
      .finally(() => setBusy(false));
  }, [props.initialContext, props.agentId, account.isPending, detach]);
  async function discard(setup: Setup) {
    if (setup.temporary)
      await discardMcpSetup(props.agentId, setup.binding.mcpServerId, (id) => detach.mutateAsync(id));
  }
  async function resolveSetup(catalog: McpCatalogEntry): Promise<Setup> {
    const existing = findCatalogBinding(catalog, servers, props.mounted);
    if (existing)
      return {
        catalog,
        binding: existing,
        temporary: false,
        server: servers.find((server) => server.id === existing.mcpServerId),
      };
    let server = findAccountServer(catalog, servers) ?? created.current.get(catalog.id);
    if (!server) {
      server = await create.mutateAsync(
        CreateMCPServerRequestSchema.parse({
          name: catalog.name,
          url: catalog.url,
          defaultAuthKind: catalog.defaultAuthKind,
          authHeader: catalog.authHeader,
          authScheme: catalog.authScheme,
          extraHeaders: catalog.extraHeaders,
        }),
      );
      created.current.set(catalog.id, server);
    }
    const binding = await attach.mutateAsync(server.id);
    return { catalog, binding, server, temporary: true };
  }
  async function runSetup(setup: Setup, prepared?: McpOAuthWindow, token?: string) {
    const kind = connectionAuthKind(setup.binding.effective.url, setup.binding, setup.server);
    const result = await operation.run(
      { binding: setup.binding, kind, allowOAuthDiscovery: allowsOAuthDiscovery(setup.binding.effective.url, kind) },
      {
        token,
        source: "discover",
        oauthWindow: prepared,
        isAlive: () => alive.current,
        returnContext: { ...view.current, newBinding: setup.temporary },
        onTools: () => setChecking(true),
      },
    );
    if (result === "key") setKeySetup(setup);
    else if (result === "cancelled") {
      await discard(setup);
      setKeySetup(undefined);
    } else if (result === "connected") {
      setKeySetup(undefined);
      setConnectedIds((ids) => [...new Set([...ids, setup.catalog.id])]);
      props.onAdded(setup.binding, setup.catalog, setup.server);
    }
    return result;
  }
  async function addFromCatalog(catalog: McpCatalogEntry, token?: string) {
    if (inFlight.current) return;
    inFlight.current = true;
    const knownBinding = findCatalogBinding(catalog, servers, props.mounted);
    const knownServer = findAccountServer(catalog, servers);
    const kind = connectionAuthKind(knownBinding?.effective.url ?? catalog.url, knownBinding, knownServer);
    const prepared = kind === "oauth" ? prepareMcpOAuthWindow(mcpOAuthIdentity(catalog.url)) : undefined;
    preparedWindow.current = prepared;
    setBusy(true);
    setChecking(false);
    setPendingEntryId(catalog.id);
    setPendingAction(catalogAction(knownBinding));
    setError(undefined);
    setNotice(undefined);
    let setup: Setup | undefined;
    try {
      setup = keySetup?.catalog.id === catalog.id ? keySetup : await resolveSetup(catalog);
      if (!alive.current) {
        await discard(setup);
        return;
      }
      await runSetup(setup, prepared, token);
    } catch (cause) {
      await reportFailure(cause, catalog, setup, token);
    } finally {
      closeMcpOAuthWindow(prepared?.popup);
      inFlight.current = false;
      if (alive.current) {
        setBusy(false);
        setChecking(false);
        setPendingEntryId(undefined);
        setPendingAction(undefined);
      }
    }
  }
  async function reportFailure(cause: unknown, catalog: McpCatalogEntry, setup?: Setup, token?: string) {
    setError(setup ? connectionFailure(cause, catalog.defaultAuthKind) : actionError(cause, m.mcp_create_failed()));
    if (!setup || token) return;
    try {
      await discard(setup);
      setKeySetup(undefined);
    } catch (cleanupError) {
      setError(actionError(cleanupError, m.mcp_setup_cleanup_failed()));
    }
  }
  async function cancelKey() {
    if (!keySetup || inFlight.current) return;
    setBusy(true);
    try {
      await discard(keySetup);
      setKeySetup(undefined);
      setError(undefined);
    } catch (cause) {
      setError(actionError(cause, m.mcp_setup_cleanup_failed()));
    } finally {
      setBusy(false);
    }
  }
  return {
    account,
    servers,
    error,
    notice,
    busy,
    checking,
    pendingEntryId,
    pendingAction,
    keySetup,
    connectedIds,
    addFromCatalog,
    cancelKey,
    oauth: operation.oauth,
    view,
  };
}
