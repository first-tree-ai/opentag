import { MCP_CATALOG_ENTRIES, type McpCatalogEntry, type McpInstallableCatalogEntry } from "@opentag/mcp-presets";
import type { MCPAgentServer, MCPAuthKind, MCPServer } from "@opentag/shared/browser";
import { catalogEntryUrls, comparableUrl, installableEntries } from "./catalog/mcp-catalog-model.js";

/**
 * Authentication and consent scopes require the actual endpoint, not its brand or icon match. An
 * entry's deployment-client endpoint is its actual endpoint too.
 */
export function connectionPreset(url: string): McpInstallableCatalogEntry | undefined {
  const target = comparableUrl(url);
  return installableEntries(MCP_CATALOG_ENTRIES).find((entry) =>
    catalogEntryUrls(entry).some((known) => comparableUrl(known) === target),
  );
}

export function connectionAuthKind(url: string, binding?: MCPAgentServer, server?: MCPServer): MCPAuthKind {
  const preset = connectionPreset(url);
  const declared = binding?.authorization?.kind ?? server?.defaultAuthKind ?? preset?.defaultAuthKind ?? "none";
  if (
    !preset ||
    !binding?.authorization ||
    binding.authorization.hasCredential ||
    binding.authorization.status === "active"
  )
    return declared;
  // A failed replacement can leave a revoked row naming the old method. Only an exact, unique
  // configured method identifies the submitted choice; shared endpoints remain ambiguous.
  const configured = presetAuthKinds(preset).filter((kind) => {
    const method = presetAuthConfig(preset, kind);
    return comparableUrl(method.url) === comparableUrl(url) && methodHeadersMatch(binding, method);
  });
  return configured.length === 1 ? (configured[0] ?? declared) : declared;
}

function methodHeadersMatch(entry: MCPAgentServer, method: ReturnType<typeof presetAuthConfig>): boolean {
  return (
    entry.effective.authHeader.toLowerCase() === method.authHeader.toLowerCase() &&
    entry.effective.authScheme === method.authScheme
  );
}

/** Presets expose only configured methods; custom connections choose explicitly. */
export function presetAuthKinds(preset: McpInstallableCatalogEntry): MCPAuthKind[] {
  return preset.keyAuth ? [preset.defaultAuthKind, "bearer"] : [preset.defaultAuthKind];
}
export function presetAuthConfig(preset: McpInstallableCatalogEntry, kind: MCPAuthKind) {
  const method = kind === "bearer" ? preset.keyAuth : preset;
  return {
    url: method?.url ?? preset.url,
    authHeader: method?.authHeader ?? "authorization",
    authScheme: method?.authScheme ?? "Bearer",
  };
}

/** Without a stored source flag, preserve editable settings for every non-catalog configuration. */
export function settingsPreset(
  entry: MCPAgentServer,
  catalog: readonly McpCatalogEntry[],
): McpInstallableCatalogEntry | undefined {
  const url = comparableUrl(entry.effective.url);
  const preset = installableEntries(catalog).find((item) =>
    catalogEntryUrls(item).some((known) => comparableUrl(known) === url),
  );
  if (!preset) return;
  if (
    !presetAuthKinds(preset).some((kind) => {
      const method = presetAuthConfig(preset, kind);
      const methodUrl = comparableUrl(method.url);
      const matchesUrl =
        methodUrl === url ||
        (kind === preset.defaultAuthKind &&
          (url !== comparableUrl(preset.keyAuth?.url ?? "") || entry.authorization?.kind === kind));
      return matchesUrl && methodHeadersMatch(entry, method);
    })
  )
    return;
  const expected = preset.extraHeaders ?? {};
  const headers = entry.effective.extraHeaders;
  if (
    Object.keys(headers).length !== Object.keys(expected).length ||
    Object.entries(expected).some(([name, value]) => headers[name.toLowerCase()] !== value)
  )
    return;
  return preset;
}
