import type { McpCatalogEntry, McpCatalogLocalizedText } from "@opentag/mcp-presets";
import type { MCPAgentServer, MCPServer } from "@opentag/shared/browser";
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
 */
export function findAccountServer(entry: McpCatalogEntry, servers: readonly MCPServer[]): MCPServer | undefined {
  const target = comparableUrl(entry.url);
  return servers.find((server) => comparableUrl(server.url) === target);
}

/**
 * What a card should show for one Agent:
 *
 *   available   this Agent does not mount the entry's Server; the card offers add
 *   installed   mounted, but no active authorization yet
 *   authorized  mounted and usable
 *
 * A mount is matched by its effective URL first, so an Agent-level URL override still counts, and by
 * the definition's id second.
 */
export type McpCatalogEntryState = "available" | "installed" | "authorized";

export function catalogEntryState(
  entry: McpCatalogEntry,
  servers: readonly MCPServer[],
  mounted: readonly MCPAgentServer[],
): McpCatalogEntryState {
  const target = comparableUrl(entry.url);
  const definition = findAccountServer(entry, servers);
  const binding =
    mounted.find((candidate) => comparableUrl(candidate.effective.url) === target) ??
    (definition ? mounted.find((candidate) => candidate.mcpServerId === definition.id) : undefined);
  if (!binding) return "available";
  return binding.authorization?.status === "active" ? "authorized" : "installed";
}
