import type { McpCatalogEntry } from "@opentag/mcp-presets";
import { CreateMCPServerRequestSchema, type MCPAgentServer, type MCPServer } from "@opentag/shared/browser";
import { useRef, useState } from "react";
import * as m from "../../../paraglide/messages.js";
import { actionError } from "../mcp-form-model.js";
import { useAttachMcpServer, useCreateMcpServer, useMcpServers } from "../mcp-queries.js";
import { findAccountServer, findCatalogBinding } from "./mcp-catalog-model.js";

export type DiscoverProps = {
  agentId: string;
  agentName: string;
  mounted: MCPAgentServer[];
  onClose: () => void;
  onAdded: (entry: MCPAgentServer, catalog: McpCatalogEntry) => void;
};

function catalogCreateInput(entry: McpCatalogEntry) {
  return CreateMCPServerRequestSchema.parse({
    name: entry.name,
    url: entry.url,
    defaultAuthKind: entry.defaultAuthKind,
    ...(entry.authHeader === undefined ? {} : { authHeader: entry.authHeader }),
    ...(entry.authScheme === undefined ? {} : { authScheme: entry.authScheme }),
    ...(entry.extraHeaders === undefined ? {} : { extraHeaders: entry.extraHeaders }),
  });
}

/** Discovery ends at the confirmed Agent binding; the page owns authorization after it closes. */
export function useMcpDiscoverState({ agentId, mounted, onAdded }: DiscoverProps) {
  const account = useMcpServers();
  const servers = account.data?.servers ?? [];
  const create = useCreateMcpServer(agentId);
  const attach = useAttachMcpServer(agentId);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [pendingEntryId, setPendingEntryId] = useState<string>();
  // Keep every confirmed definition, including one whose subsequent attach failed.
  const created = useRef(new Map<string, MCPServer>());
  const bindings = useRef(new Map<string, MCPAgentServer>());
  const inFlight = useRef(false);
  const resolveServer = async (entry: McpCatalogEntry) => {
    const known = findAccountServer(entry, servers) ?? created.current.get(entry.id);
    if (known) return known;
    const server = await create.mutateAsync(catalogCreateInput(entry));
    created.current.set(entry.id, server);
    return server;
  };
  const addFromCatalog = async (entry: McpCatalogEntry) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setPendingEntryId(entry.id);
    setError(undefined);
    let resolved: MCPServer | undefined;
    try {
      let binding = findCatalogBinding(entry, servers, mounted) ?? bindings.current.get(entry.id);
      if (!binding) {
        resolved = await resolveServer(entry);
        binding =
          mounted.find((current) => current.mcpServerId === resolved?.id) ?? (await attach.mutateAsync(resolved.id));
        bindings.current.set(entry.id, binding);
      }
      onAdded(binding, resolved ? { ...entry, defaultAuthKind: resolved.defaultAuthKind } : entry);
    } catch (cause) {
      setError(actionError(cause, resolved ? m.mcp_attach_failed() : m.mcp_create_failed()));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  return { account, servers, error, busy, pendingEntryId, addFromCatalog };
}
