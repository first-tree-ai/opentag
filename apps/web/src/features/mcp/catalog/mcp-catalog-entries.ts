import { MCP_CATALOG_ENTRIES } from "@opentag/mcp-presets";
import { useMemo } from "react";
import { useMcpCatalogEndpoints } from "../mcp-queries.js";
import { resolveCatalogEntries, type ServedCatalogEntry } from "./mcp-catalog-model.js";

/**
 * The catalog entries as this deployment serves them, for the surfaces that create Servers.
 *
 * While the deployment's endpoints load, `isPending` is true and callers must not create a Server
 * yet, because a card could still change its endpoint. A failed read keeps the catalog as shipped:
 * every shipped endpoint works without a deployment client, so the catalog stays usable.
 *
 * A served entry keeps its shipped endpoint as an identity, so Servers an Account created there
 * before the replacement still match their card.
 */
export function useMcpCatalogEntries(): { entries: readonly ServedCatalogEntry[]; isPending: boolean } {
  const endpoints = useMcpCatalogEndpoints();
  const entries = useMemo(
    () => resolveCatalogEntries(MCP_CATALOG_ENTRIES, endpoints.data?.endpoints ?? []),
    [endpoints.data],
  );
  return { entries, isPending: endpoints.isPending };
}
