import { CreateMCPServerRequestSchema, MCPServerUrlSchema } from "@opentag/shared/browser";
import type { McpCatalogEntry, McpInstallableCatalogEntry } from "./mcp-catalog.gen.js";

/** A setup-only card becomes a connection only after a user supplies a real endpoint. */
export function matchesMcpCatalogEndpoint(entry: McpCatalogEntry, value: string): boolean {
  const endpoint = entry.setup?.endpoint;
  if (!endpoint || !MCPServerUrlSchema.safeParse(value).success) return false;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.hash) return false;
    if (endpoint.hostSuffix && !url.hostname.endsWith(`.${endpoint.hostSuffix}`)) return false;
    const queryNames = [...url.searchParams.keys()];
    if (
      new Set(queryNames).size !== queryNames.length ||
      queryNames.some((name) => !endpoint.queryParameters?.includes(name))
    )
      return false;
    return new RegExp(endpoint.pathPattern).test(url.pathname);
  } catch {
    return false;
  }
}

export function resolveMcpCatalogSetup(
  entry: McpCatalogEntry,
  url: string,
  headerValues: Readonly<Record<string, string>> = {},
): McpInstallableCatalogEntry | undefined {
  if (!matchesMcpCatalogEndpoint(entry, url)) return undefined;
  const extraHeaders: Record<string, string> = {};
  for (const field of entry.setup?.headers ?? []) {
    const value = headerValues[field.name]?.trim() ?? "";
    if (field.required && !value) return undefined;
    if (value && field.format === "integer" && !/^[1-9]\d*$/.test(value)) return undefined;
    if (value) extraHeaders[field.name] = value;
  }
  const result = CreateMCPServerRequestSchema.safeParse({
    name: entry.name,
    url: url.trim(),
    defaultAuthKind: entry.auth.defaultKind,
    authHeader: entry.setup?.authHeader,
    authScheme: entry.setup?.authScheme,
    extraHeaders,
  });
  if (!result.success) return undefined;
  return { ...entry, ...result.data, installable: true };
}

/** Prefix only the documented key format when the effective header configuration still matches. */
export function formatMcpCatalogKey(
  entry: McpCatalogEntry | undefined,
  value: string,
  config: { authHeader: string; authScheme: string },
): string {
  const key = value.trim();
  const prefix = entry?.setup?.keyPrefix;
  if (
    !entry ||
    !prefix ||
    config.authHeader.toLowerCase() !== (entry.authHeader ?? "authorization").toLowerCase() ||
    config.authScheme !== (entry.authScheme ?? "Bearer")
  )
    return key;
  return key.startsWith(prefix) ? key : `${prefix}${key}`;
}
