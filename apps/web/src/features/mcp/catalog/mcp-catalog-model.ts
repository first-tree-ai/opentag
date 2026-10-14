import type { McpCatalogEntry, McpCatalogLocalizedText } from "@opentag/mcp-presets";
import {
  MCP_CATALOG_DEPLOYMENT_ENDPOINTS,
  type MCPAgentServer,
  type MCPCatalogEndpoint,
  type MCPServer,
} from "@opentag/shared/browser";
import { getLocale, type Locale } from "../../../i18n/locale.js";

/**
 * Reads and joins for the marketplace catalog.
 *
 * The catalog carries its own copy in every supported locale, so the reader only has to pick one; it
 * never falls back, because the generator refuses a source that omits a locale. Everything else here
 * answers "what should this card do for this Agent", which is a pure join over the Account pool and
 * the Agent's mounts — no extra endpoint.
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
export type ServedCatalogEntry = McpCatalogEntry & { shippedUrl?: string };

/**
 * Every endpoint that identifies an entry, preferred endpoint first: the one a new Server is created
 * on, the shipped one, and the one a deployment client may require. A Server on any of them is the
 * same service.
 */
export function catalogEntryUrls(entry: ServedCatalogEntry): string[] {
  const urls = [entry.url, entry.shippedUrl, MCP_CATALOG_DEPLOYMENT_ENDPOINTS[entry.id]];
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
export function findCatalogEntryByUrl(value: string, entries: readonly McpCatalogEntry[]): McpCatalogEntry | undefined {
  const target = catalogEndpoint(value);
  if (!target) return undefined;
  return entries.find((entry) => catalogEntryUrls(entry).some((url) => catalogEndpoint(url) === target));
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
  entries: readonly McpCatalogEntry[],
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

/** Whether an entry matches the catalog search, over its name, its URL, and the active locale. */
export function matchesCatalogEntry(entry: McpCatalogEntry, query: string, locale: Locale = getLocale()): boolean {
  const term = query.trim().toLowerCase();
  if (term.length === 0) return true;
  return [entry.name, entry.url, entry.title[locale], entry.description[locale]].some((value) =>
    value.toLowerCase().includes(term),
  );
}

/** The entries of one category, in the generator's order. */
export function entriesInCategory(entries: readonly McpCatalogEntry[], categoryId: string): McpCatalogEntry[] {
  return entries.filter((entry) => entry.category === categoryId);
}

/**
 * The Account definition a catalog entry should mount, or `undefined` when the Account has none yet.
 *
 * Matching on the URL is what keeps a hand-created or previously used definition from being
 * duplicated, and it is also what avoids the `unique(account_id, lower(name))` collision in the
 * common case.
 *
 * Every endpoint of the entry counts, preferred endpoint first. An Account that created the entry's
 * Server before the deployment replaced its endpoint keeps using that Server: creating a second one
 * would collide on the name, and the existing one still works.
 */
export function findAccountServer(entry: ServedCatalogEntry, servers: readonly MCPServer[]): MCPServer | undefined {
  return firstByEndpoint(entry, servers, (server) => server.url);
}

/** The first candidate on the entry's most preferred endpoint, trying each endpoint in order. */
function firstByEndpoint<T>(entry: ServedCatalogEntry, candidates: readonly T[], urlOf: (candidate: T) => string) {
  for (const url of catalogEntryUrls(entry)) {
    const target = comparableUrl(url);
    const found = candidates.find((candidate) => comparableUrl(urlOf(candidate)) === target);
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
  entry: McpCatalogEntry,
  servers: readonly MCPServer[],
  mounted: readonly MCPAgentServer[],
): McpCatalogEntryState {
  const binding = findCatalogBinding(entry, servers, mounted);
  if (!binding) return "available";
  if (!binding.enabled) return "disabled";
  const auth = binding.authorization;
  return auth?.status === "active" && auth.probeState === "succeeded" && (auth.toolsCount ?? 0) > 0
    ? "added"
    : "unconnected";
}

export function findCatalogBinding(
  entry: ServedCatalogEntry,
  servers: readonly MCPServer[],
  mounted: readonly MCPAgentServer[],
): MCPAgentServer | undefined {
  const definition = findAccountServer(entry, servers);
  return (
    firstByEndpoint(entry, mounted, (candidate) => candidate.effective.url) ??
    (definition ? mounted.find((candidate) => candidate.mcpServerId === definition.id) : undefined)
  );
}
