import type { McpInstallableCatalogEntry } from "@opentag/mcp-presets";
import { CreateMCPServerRequestSchema, type MCPAgentServer, type MCPServer } from "@opentag/shared/browser";
import { useCallback, useEffect, useRef, useState } from "react";
import { browserApi } from "../../../api.js";
import * as m from "../../../paraglide/messages.js";
import { connectionFailure, useMcpConnectionOperation } from "../mcp-connection.js";
import { allowsOAuthDiscovery, connectionAuthKind } from "../mcp-connection-model.js";
import { actionError } from "../mcp-form-model.js";
import { createMcpInstallation } from "../mcp-installation.js";
import { useMcpOAuthSessions } from "../mcp-oauth-session.js";
import { closeMcpOAuthWindow, type McpOAuthWindow, prepareMcpOAuthWindow } from "../mcp-oauth-window.js";
import {
  useAttachMcpServer,
  useCreateMcpServer,
  useDetachMcpServer,
  useMcpInstallationDefinitions,
} from "../mcp-queries.js";
import type { McpReturnContext } from "../mcp-return-context.js";
import { discardMcpSetup } from "../mcp-setup-cleanup.js";
import { useMcpCatalogEntries } from "./mcp-catalog-entries.js";
import { catalogFailure, type McpCatalogFeedback } from "./mcp-catalog-feedback.js";
import { findCatalogBinding, findCatalogEntryByUrl } from "./mcp-catalog-model.js";

export type DiscoverProps = {
  agentId: string;
  agentName: string;
  mounted: MCPAgentServer[];
  onClose: () => void;
  onAdded: (entry: MCPAgentServer, catalog: McpInstallableCatalogEntry, server?: MCPServer) => void;
  initialContext?: McpReturnContext;
  initialOutcome?: "cancelled" | "failed";
};
type Setup = { catalog: McpInstallableCatalogEntry; binding: MCPAgentServer; server?: MCPServer; temporary: boolean };
type Pending = { checking: boolean; action: "add" | "connect" };
const catalogAction = (binding?: MCPAgentServer): "add" | "connect" => (binding ? "connect" : "add");

/** Keep Discover mounted until the user finishes, and never detach a pre-existing connection. */
export function useMcpDiscoverState(props: DiscoverProps) {
  const definitions = useMcpInstallationDefinitions(props.mounted, props.initialContext?.serverId);
  const servers = definitions.servers;
  const servedCatalog = useMcpCatalogEntries();
  // A card may still change its endpoint until the deployment's catalog endpoints have loaded.
  const loading = definitions.isPending || servedCatalog.isPending;
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
  const [restoring, setRestoring] = useState(false);
  const [pending, setPending] = useState<Record<string, Pending>>({});
  const [keySetups, setKeySetups] = useState<Record<string, Setup>>({});
  const keySetup = Object.values(keySetups)[0];
  const getSession = useMcpOAuthSessions(props.agentId);
  const busy = restoring || Object.keys(pending).length > 0;
  const sameTab = window.matchMedia("(max-width: 640px)").matches;
  const catalogBusy = restoring || (sameTab && busy);
  const keyBusy = Boolean(keySetup && pending[keySetup.catalog.id]);
  const setKeySetup = (id: string, setup?: Setup) =>
    setKeySetups((all) => {
      const next = { ...all };
      if (setup) next[id] = setup;
      else delete next[id];
      return next;
    });
  const [connectedIds, setConnectedIds] = useState<string[]>([]);
  const [failures, setFailures] = useState<Record<string, McpCatalogFeedback>>({});
  const setFailure = useCallback(
    (feedback: McpCatalogFeedback) => setFailures((all) => ({ ...all, [feedback.entryId]: feedback })),
    [],
  );
  const created = useRef(new Map<string, MCPServer>());
  const inFlight = useRef(new Set<string>());
  const alive = useRef(true);
  const preparedWindows = useRef(new Map<string, McpOAuthWindow>());
  const view = useRef({
    query: props.initialContext?.query ?? "",
    categoryId: props.initialContext?.categoryId ?? "",
    scrollTop: props.initialContext?.scrollTop ?? 0,
  });
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      for (const prepared of preparedWindows.current.values()) closeMcpOAuthWindow(prepared.popup);
    };
  }, []);
  const restoreStarted = useRef(false);
  useEffect(() => {
    const context = props.initialContext;
    if (!context || restoreStarted.current || definitions.isPending) return;
    restoreStarted.current = true;
    const catalog = findCatalogEntryByUrl(
      servers.find((server) => server.id === context.serverId)?.url ?? "",
      servedCatalog.entries,
    );
    if (props.initialOutcome === "failed" && catalog) {
      setFailure({ entryId: catalog.id, phase: "error", label: m.mcp_connection_failed() });
      setError(undefined);
    }
    if (!context.newBinding) return;
    setRestoring(true);
    void (async () => {
      const current = (await browserApi.agentMcpServers(props.agentId)).servers.find(
        (entry) => entry.mcpServerId === context.serverId,
      );
      if (current && !current.authorization?.hasCredential) await detach.mutateAsync(context.serverId);
    })()
      .catch((cause) => setError(actionError(cause, m.mcp_setup_cleanup_failed())))
      .finally(() => setRestoring(false));
  }, [
    props.initialContext,
    props.initialOutcome,
    props.agentId,
    definitions.isPending,
    servedCatalog.entries,
    detach,
    servers,
    setFailure,
  ]);
  async function discard(setup: Setup) {
    if (setup.temporary)
      await discardMcpSetup(props.agentId, setup.binding.mcpServerId, (id) => detach.mutateAsync(id));
  }
  async function resolveSetup(catalog: McpInstallableCatalogEntry): Promise<Setup> {
    const existing = findCatalogBinding(catalog, servers, props.mounted);
    if (existing)
      return {
        catalog,
        binding: existing,
        temporary: false,
        server: servers.find((server) => server.id === existing.mcpServerId),
      };
    let server = created.current.get(catalog.id);
    if (!server) {
      server = await createMcpInstallation(
        CreateMCPServerRequestSchema.parse({
          name: catalog.name,
          url: catalog.url,
          defaultAuthKind: catalog.defaultAuthKind,
          authHeader: catalog.authHeader,
          authScheme: catalog.authScheme,
          extraHeaders: catalog.extraHeaders,
        }),
        create.mutateAsync,
      );
      created.current.set(catalog.id, server);
    }
    const binding = await attach.mutateAsync(server.id);
    return { catalog, binding, server, temporary: true };
  }
  async function runSetup(setup: Setup, prepared?: McpOAuthWindow, token?: string) {
    const kind = connectionAuthKind(setup.binding.effective.url, setup.binding, setup.server);
    const session = getSession(setup.catalog.id);
    const result = await operation.run(
      { binding: setup.binding, kind, allowOAuthDiscovery: allowsOAuthDiscovery(setup.binding.effective.url, kind) },
      {
        oauthSession: session,
        token,
        source: "discover",
        oauthWindow: prepared,
        isAlive: () => alive.current,
        returnContext: { ...view.current, newBinding: setup.temporary },
        onTools: () =>
          setPending((all) => ({
            ...all,
            [setup.catalog.id]: { action: all[setup.catalog.id]?.action ?? "add", checking: true },
          })),
      },
    );
    if (result === "key") setKeySetup(setup.catalog.id, setup);
    else if (result === "cancelled") {
      await discard(setup);
      setKeySetup(setup.catalog.id);
      if (session.interruption.current === "timeout")
        setFailure({ entryId: setup.catalog.id, phase: "error", label: m.mcp_authorization_incomplete() });
    } else if (result === "connected") {
      setKeySetup(setup.catalog.id);
      setConnectedIds((ids) => [...new Set([...ids, setup.catalog.id])]);
      props.onAdded(setup.binding, setup.catalog, setup.server);
    }
    return result;
  }
  function cannotStart(id: string) {
    return (
      restoring ||
      inFlight.current.has(id) ||
      (window.matchMedia("(max-width: 640px)").matches && inFlight.current.size > 0)
    );
  }
  async function addFromCatalog(catalog: McpInstallableCatalogEntry, token?: string) {
    if (cannotStart(catalog.id)) return;
    inFlight.current.add(catalog.id);
    const knownBinding = findCatalogBinding(catalog, servers, props.mounted);
    const knownServer = servers.find((server) => server.id === knownBinding?.mcpServerId);
    const kind = connectionAuthKind(knownBinding?.effective.url ?? catalog.url, knownBinding, knownServer);
    const prepared = kind === "oauth" ? prepareMcpOAuthWindow() : undefined;
    if (prepared) preparedWindows.current.set(catalog.id, prepared);
    setPending((all) => ({ ...all, [catalog.id]: { checking: false, action: catalogAction(knownBinding) } }));
    setError(undefined);
    setNotice(undefined);
    setFailures((all) => {
      const next = { ...all };
      delete next[catalog.id];
      return next;
    });
    let setup: Setup | undefined;
    try {
      setup = keySetups[catalog.id] ?? (await resolveSetup(catalog));
      if (!alive.current) {
        await discard(setup);
        return;
      }
      await runSetup(setup, prepared, token);
    } catch (cause) {
      await reportFailure(cause, catalog, setup, token);
    } finally {
      closeMcpOAuthWindow(prepared?.popup);
      inFlight.current.delete(catalog.id);
      preparedWindows.current.delete(catalog.id);
      if (alive.current) {
        setPending((all) => {
          const next = { ...all };
          delete next[catalog.id];
          return next;
        });
      }
    }
  }
  async function reportFailure(cause: unknown, catalog: McpInstallableCatalogEntry, setup?: Setup, token?: string) {
    if (token) setError(connectionFailure(cause, catalog.defaultAuthKind));
    else
      setFailure({
        entryId: catalog.id,
        phase: "error",
        label: catalogFailure(cause),
      });
    if (!setup || token) return;
    try {
      await discard(setup);
      setKeySetup(setup.catalog.id);
    } catch {
      setFailure({ entryId: catalog.id, phase: "error", label: m.mcp_setup_cleanup_failed() });
    }
  }
  async function cancelKey() {
    const setup = keySetup;
    if (!setup || inFlight.current.has(setup.catalog.id)) return;
    const id = setup.catalog.id;
    inFlight.current.add(id);
    setPending((all) => ({ ...all, [id]: { checking: false, action: "add" } }));
    try {
      await discard(setup);
      setKeySetup(id);
      setError(undefined);
    } catch (cause) {
      setError(actionError(cause, m.mcp_setup_cleanup_failed()));
    } finally {
      inFlight.current.delete(id);
      setPending((all) => {
        const next = { ...all };
        delete next[id];
        return next;
      });
    }
  }
  const feedback = { ...failures };
  for (const [id, attempt] of Object.entries(pending)) {
    feedback[id] = discoverFeedback(id, attempt.checking, getSession(id));
  }
  return {
    definitions,
    catalog: servedCatalog,
    loading,
    servers,
    error,
    notice,
    busy,
    keyBusy,
    catalogBusy,
    pending,
    keySetup,
    connectedIds,
    feedback,
    addFromCatalog,
    cancelKey,
    view,
  };
}

function discoverFeedback(
  entryId: string,
  checking: boolean,
  oauth: ReturnType<typeof useMcpConnectionOperation>["oauth"],
): McpCatalogFeedback {
  const phase = oauth.blocked ? "blocked" : (oauth.phase ?? (checking ? "checking" : "preparing"));
  const labels = {
    preparing: m.mcp_connecting(),
    waiting: m.mcp_catalog_waiting(),
    checking: m.mcp_oauth_checking(),
    blocked: m.mcp_catalog_page_blocked(),
  };
  return {
    entryId,
    phase,
    label: labels[phase],
    onCancel: oauth.phase && oauth.phase !== "checking" ? oauth.cancel : undefined,
    onOpen: () => void oauth.openFallback(),
  };
}
