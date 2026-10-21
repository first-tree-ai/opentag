import type { McpCatalogEntry, McpCatalogLocalizedText, McpInstallableCatalogEntry } from "@opentag/mcp-presets";
import {
  MCP_CATALOG_DEPLOYMENT_ENDPOINTS,
  type MCPAgentServer,
  type MCPCatalogEndpoint,
  type MCPServer,
} from "@opentag/shared/browser";
import { getLocale, type Locale } from "../../../i18n/locale.js";
import { hasMcpToolSnapshot } from "../mcp-tool-snapshot.js";

/**
 * Reads and joins for the marketplace catalog.
 *
 * The catalog carries its own copy in every supported locale, so the reader only has to pick one; it
 * never falls back, because the generator refuses a source that omits a locale. Everything else here
 * answers "what should this card do for this Agent" using its own installations and definitions.
 */

/** The given locale's text. Every locale is guaranteed present by the catalog generator. */
export function localizedText(value: McpCatalogLocalizedText, locale: Locale = getLocale()): string {
  return value[locale];
}

/** The form used to decide whether two URLs name the same endpoint. */
export function comparableUrl(value: string): string {
  try {
    return new URL(value.trim()).href;
  } catch {
    return value.trim();
  }
}

/**
 * A catalog entry as this deployment serves it.
 *
 * `url` is the endpoint a new Server is created on. When the deployment replaced it, `shippedUrl`
 * keeps the endpoint the catalog ships, because Servers created before the replacement still live
 * there and must keep their identity.
 */
export type ServedCatalogEntry = McpInstallableCatalogEntry & { shippedUrl?: string };

/**
 * Every endpoint that identifies an entry, preferred endpoint first: the one a new Server is created
 * on, the shipped one, and the one a deployment client may require. A Server on any of them is the
 * same service.
 */
export function catalogEntryUrls(entry: ServedCatalogEntry): string[] {
  const urls = [entry.url, entry.keyAuth?.url, entry.shippedUrl, MCP_CATALOG_DEPLOYMENT_ENDPOINTS[entry.id]];
  const seen = new Set<string>();
  return urls.filter((url): url is string => {
    if (url === undefined) return false;
    const key = comparableUrl(url);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Match a known endpoint, allowing connection-specific query parameters and a trailing slash. */
export function findCatalogEntryByUrl(
  value: string,
  entries: readonly McpCatalogEntry[],
): McpInstallableCatalogEntry | undefined {
  const target = catalogEndpoint(value);
  if (!target) return undefined;
  return installableEntries(entries).find((entry) =>
    catalogEntryUrls(entry).some((url) => catalogEndpoint(url) === target),
  );
}

/**
 * The catalog as this deployment serves it. An entry whose endpoint the deployment replaces names
 * the replacement, so a card creates its Server where the deployment's client works.
 *
 * Only the replacement the shared contract names for that entry is accepted: a response that names
 * any other endpoint leaves the entry as shipped, so this read can never point a card at an
 * arbitrary URL.
 */
export function resolveCatalogEntries(
  entries: readonly McpInstallableCatalogEntry[],
  endpoints: readonly MCPCatalogEndpoint[],
): readonly ServedCatalogEntry[] {
  if (endpoints.length === 0) return entries;
  const replaced = new Map(endpoints.map((endpoint) => [endpoint.catalogId, endpoint.url]));
  return entries.map((entry) => {
    const url = replaced.get(entry.id);
    if (url === undefined || url !== MCP_CATALOG_DEPLOYMENT_ENDPOINTS[entry.id]) return entry;
    return { ...entry, url, shippedUrl: entry.url };
  });
}

function catalogEndpoint(value: string): string | undefined {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || url.username || url.password) return undefined;
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return undefined;
  }
}

/**
 * Whether an entry matches the catalog search: its name, URL, and the active locale's title,
 * description, and when-to-use text, plus its keywords, aliases, tags, and capabilities.
 */
export function matchesCatalogEntry(
  entry: McpInstallableCatalogEntry,
  query: string,
  locale: Locale = getLocale(),
): boolean {
  const term = query.trim().toLowerCase();
  if (term.length === 0) return true;
  const fields = [
    entry.name,
    entry.url,
    entry.title[locale],
    entry.description[locale],
    entry.whenToUse[locale],
    ...entry.capabilities,
    ...(entry.keywords ?? []),
    ...(entry.aliases ?? []),
    ...(entry.tags ?? []),
  ];
  return fields.some((value) => value.toLowerCase().includes(term));
}

/** The entries Discover offers: `deprecated` and `archived` entries stay out of the directory. */
export function offeredEntries(entries: readonly McpInstallableCatalogEntry[]): readonly McpInstallableCatalogEntry[] {
  return entries.filter((entry) => entry.status === "active");
}

/**
 * The shipped entries a card may offer to add: those with the streamable-http remote the Server
 * create contract accepts. Entries that only list self-hosted packages are catalog data and stay out
 * of every addable surface until the Server can run them.
 */
export function installableEntries(entries: readonly McpCatalogEntry[]): readonly McpInstallableCatalogEntry[] {
  return entries.filter((entry): entry is McpInstallableCatalogEntry => entry.installable && entry.url !== undefined);
}

/** The entries of one category, in the generator's order. */
export function entriesInCategory(
  entries: readonly McpInstallableCatalogEntry[],
  categoryId: string,
): McpInstallableCatalogEntry[] {
  return entries.filter((entry) => entry.category === categoryId);
}

/** The first candidate on the entry's most preferred endpoint, trying each endpoint in order. */
function firstByEndpoint<T>(entry: ServedCatalogEntry, candidates: readonly T[], urlOf: (candidate: T) => string) {
  for (const url of catalogEntryUrls(entry)) {
    const target = catalogEndpoint(url);
    const found = candidates.find((candidate) => target && catalogEndpoint(urlOf(candidate)) === target);
    if (found) return found;
  }
  return undefined;
}

/**
 * What a card should show for one Agent:
 *
 *   available   this Agent does not mount the entry's Server; the card offers add
 *   added       mounted; setup and connection health belong to the management view
 *
 * A mount is matched by its effective URL first, so an Agent-level URL override still counts, and by
 * the definition's id second.
 */
export type McpCatalogEntryState = "available" | "added" | "unconnected" | "disabled";

export function catalogEntryState(
  entry: McpInstallableCatalogEntry,
  servers: readonly MCPServer[],
  mounted: readonly MCPAgentServer[],
): McpCatalogEntryState {
  const binding = findCatalogBinding(entry, servers, mounted);
  if (!binding) return "available";
  if (!binding.enabled) return "disabled";
  const auth = binding.authorization;
  if (auth?.status !== "active") return "unconnected";
  return auth.probeState === "succeeded" || (auth.probeState === "pending" && hasMcpToolSnapshot(binding))
    ? "added"
    : "unconnected";
}

export function findCatalogBinding(
  entry: ServedCatalogEntry,
  servers: readonly MCPServer[],
  mounted: readonly MCPAgentServer[],
): MCPAgentServer | undefined {
  const mountedIds = new Set(mounted.map((binding) => binding.mcpServerId));
  const definition = firstByEndpoint(
    entry,
    servers.filter((server) => mountedIds.has(server.id)),
    (server) => server.url,
  );
  return (
    firstByEndpoint(entry, mounted, (candidate) => candidate.effective.url) ??
    (definition ? mounted.find((candidate) => candidate.mcpServerId === definition.id) : undefined)
  );
}
