/**
 * Search over the repo-shipped MCP marketplace catalog.
 *
 * The catalog is compile-time data, so the default index is built once at import: an inverted token
 * index, an exact name/alias table, and a name/alias prefix table. A query costs postings
 * proportional to how many entries its tokens actually hit, not a scan of the whole catalog.
 *
 * Invariants every caller may rely on:
 * - Only `status === "active"` entries are ever returned or resolved by name.
 * - Result order is a pure function of the query and the catalog: exact name/alias, then name/alias
 *   prefix, then number of matched tokens, then catalog order, then id.
 * - Indexing covers both supported locales, so one query matches English and Chinese copy alike.
 *
 * shortcut: the catalog is compile-time data, so the index is built in-process at import; a catalog
 * of thousands of entries or semantic retrieval needs build-time output or an external index.
 */

import {
  MCP_CATALOG_CATEGORIES,
  MCP_CATALOG_ENTRIES,
  type McpCatalogCategory,
  type McpCatalogEntry,
  type McpCatalogLocalizedText,
} from "./mcp-catalog.gen.js";

export const MCP_CATALOG_SEARCH_DEFAULT_LIMIT = 10;
export const MCP_CATALOG_SEARCH_MAX_LIMIT = 50;

export interface McpCatalogSearchOptions {
  /** Free text. Empty lists every active entry in catalog order. */
  query?: string | undefined;
  category?: string | undefined;
  /** Clamped into `[1, MCP_CATALOG_SEARCH_MAX_LIMIT]`. */
  limit?: number | undefined;
}

export interface McpCatalogSearchResult {
  /** Size of the match set before `limit`. */
  total: number;
  entries: readonly McpCatalogEntry[];
}

export interface McpCatalogCategoryCount {
  id: string;
  label: McpCatalogLocalizedText;
  order: number;
  activeCount: number;
  installableCount: number;
}

export interface McpCatalogSearch {
  search(options?: McpCatalogSearchOptions): McpCatalogSearchResult;
  /** Resolve one entry the caller named directly, accepting `notion`, `mcp/notion`, and any alias. */
  find(id: string): McpCatalogEntry | undefined;
  /** Computed once with the index: the counts change only when the catalog does. */
  categories: readonly McpCatalogCategoryCount[];
}

interface IndexedEntry {
  entry: McpCatalogEntry;
  /** Lowercase names a query can address this entry by: its name and its aliases. */
  names: string[];
  /** `category.order`, then the entry's own order — the catalog's display sequence. */
  catalogOrder: number;
}

interface Ranked {
  tier: number;
  hits: number;
}

interface CatalogIndex {
  /** Active entries in catalog order; a position in this array is an entry's index everywhere else. */
  active: readonly IndexedEntry[];
  byName: ReadonlyMap<string, number>;
  byPrefix: ReadonlyMap<string, readonly number[]>;
  byToken: ReadonlyMap<string, readonly number[]>;
}

/* A prefix shorter than this matches too much to be a useful signal ("a", "go", "mc"). */
const MIN_PREFIX_LENGTH = 2;
/*
 * One source for the script ranges, because querying and indexing must agree on where CJK starts.
 * Hiragana, Katakana, CJK Unified Ideographs (and its extension A), and Hangul.
 */
const CJK_RANGES = "\\u3040-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uac00-\\ud7af";
const CJK = new RegExp(`[${CJK_RANGES}]`);
/**
 * A word split at script boundaries, so `notion笔记` yields `notion` *and* `笔记`.
 *
 * Without this split an entire mixed word takes the CJK path, and the Latin half — the part a user
 * actually names the product with — never becomes a token.
 */
const SCRIPT_RUNS = new RegExp(`[${CJK_RANGES}]+|[^${CJK_RANGES}]+`, "gu");
const WORDS = /[^\p{L}\p{N}-]+/u;

/** CJK has no spaces, so a run contributes its characters and character bigrams. */
function cjkTerms(word: string): string[] {
  const characters = [...word];
  const terms: string[] = [];
  for (const [position, character] of characters.entries()) {
    terms.push(character);
    const next = characters[position + 1];
    if (next) terms.push(`${character}${next}`);
  }
  return terms;
}

/** `search-docs` is reachable as `search-docs`, `search`, and `docs`. */
function latinTerms(word: string): string[] {
  return word.includes("-") ? [word, ...word.split("-").filter(Boolean)] : [word];
}

/**
 * Split text into index terms.
 *
 * Indexing and querying share it, so whatever a client types into a query is spelled the same way as
 * the copy it is matched against.
 */
export function tokenize(text: string): string[] {
  const terms = new Set<string>();
  for (const word of text.toLowerCase().split(WORDS)) {
    if (!word) continue;
    for (const run of word.match(SCRIPT_RUNS) ?? []) {
      for (const term of CJK.test(run) ? cjkTerms(run) : latinTerms(run)) terms.add(term);
    }
  }
  return [...terms];
}

/**
 * The form a name is indexed and looked up under.
 *
 * `id` is already the slug, so only a caller quoting the registry identity (`mcp/notion`) needs the
 * prefix removed.
 */
function normalizeName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^mcp\//, "");
}

function tokensOf(entry: McpCatalogEntry): string[] {
  return tokenize(
    [
      entry.id,
      entry.name,
      ...(entry.aliases ?? []),
      ...(entry.keywords ?? []),
      ...(entry.tags ?? []),
      ...entry.capabilities,
      ...Object.values(entry.title),
      ...Object.values(entry.description),
      ...Object.values(entry.whenToUse),
    ].join(" "),
  );
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return MCP_CATALOG_SEARCH_DEFAULT_LIMIT;
  return Math.min(Math.max(Math.trunc(limit), 1), MCP_CATALOG_SEARCH_MAX_LIMIT);
}

function pushTo<K>(map: Map<K, number[]>, key: K, position: number): void {
  const bucket = map.get(key);
  if (bucket) bucket.push(position);
  else map.set(key, [position]);
}

function buildIndex(entries: readonly McpCatalogEntry[], categories: readonly McpCatalogCategory[]): CatalogIndex {
  const categoryOrder = new Map(categories.map((category) => [category.id, category.order]));
  /*
   * Sorted once, so the empty query is the catalog's own display order rather than the file's, and
   * every tie-break below can add up to a total order without a per-request sort.
   */
  const active: IndexedEntry[] = entries
    .filter((entry) => entry.status === "active")
    .map<IndexedEntry>((entry) => ({
      entry,
      names: [entry.name, ...(entry.aliases ?? [])].map((name) => name.toLowerCase()),
      catalogOrder: (categoryOrder.get(entry.category) ?? Number.MAX_SAFE_INTEGER) * 1000 + entry.order,
    }))
    .sort((left, right) => left.catalogOrder - right.catalogOrder || left.entry.id.localeCompare(right.entry.id));

  const byName = new Map<string, number>();
  const byPrefix = new Map<string, number[]>();
  const byToken = new Map<string, number[]>();

  for (const [position, indexed] of active.entries()) {
    for (const name of [normalizeName(indexed.entry.id), ...indexed.names]) {
      if (!byName.has(name)) byName.set(name, position);
      for (let length = MIN_PREFIX_LENGTH; length <= name.length; length += 1) {
        pushTo(byPrefix, name.slice(0, length), position);
      }
    }
    for (const token of tokensOf(indexed.entry)) pushTo(byToken, token, position);
  }

  return { active, byName, byPrefix, byToken };
}

function raise(ranked: Map<number, Ranked>, position: number, tier: number, hits: number): void {
  const current = ranked.get(position);
  if (!current || tier < current.tier || (tier === current.tier && hits > current.hits)) {
    ranked.set(position, { tier, hits });
  }
}

/**
 * Rank one query.
 *
 * Three tiers rather than one weighted score: a name the caller already knows must never lose to an
 * entry that merely shares its tokens, and no numeric score can guarantee that as the catalog grows.
 *
 * `needle` is the normalized whole query, so a caller who quotes the registry identity (`mcp/notion`)
 * gets the same exact hit as one who names the Server (`notion`).
 */
function rankQuery(index: CatalogIndex, queryTokens: readonly string[], needle: string): Map<number, Ranked> {
  const ranked = new Map<number, Ranked>();
  const exact = index.byName.get(needle);
  if (exact !== undefined) raise(ranked, exact, 0, queryTokens.length);
  for (const position of index.byPrefix.get(needle) ?? []) {
    raise(ranked, position, 1, ranked.get(position)?.hits ?? 0);
  }
  for (const token of queryTokens) {
    for (const position of index.byToken.get(token) ?? []) {
      const current = ranked.get(position);
      raise(ranked, position, current !== undefined && current.tier <= 1 ? current.tier : 2, (current?.hits ?? 0) + 1);
    }
  }
  return ranked;
}

function compareRanked(active: readonly IndexedEntry[]) {
  return ([leftPosition, left]: [number, Ranked], [rightPosition, right]: [number, Ranked]): number => {
    if (left.tier !== right.tier) return left.tier - right.tier;
    if (left.hits !== right.hits) return right.hits - left.hits;
    const leftIndexed = active[leftPosition] as IndexedEntry;
    const rightIndexed = active[rightPosition] as IndexedEntry;
    return (
      leftIndexed.catalogOrder - rightIndexed.catalogOrder || leftIndexed.entry.id.localeCompare(rightIndexed.entry.id)
    );
  };
}

function matchesOf(index: CatalogIndex, options: McpCatalogSearchOptions): IndexedEntry[] {
  const query = options.query?.trim() ?? "";
  const inCategory = (indexed: IndexedEntry) =>
    options.category === undefined || indexed.entry.category === options.category;
  if (!query) return index.active.filter(inCategory);

  return [...rankQuery(index, tokenize(query), normalizeName(query)).entries()]
    .filter(([position]) => inCategory(index.active[position] as IndexedEntry))
    .sort(compareRanked(index.active))
    .map(([position]) => index.active[position] as IndexedEntry);
}

export function createMcpCatalogSearch(
  entries: readonly McpCatalogEntry[] = MCP_CATALOG_ENTRIES,
  categories: readonly McpCatalogCategory[] = MCP_CATALOG_CATEGORIES,
): McpCatalogSearch {
  const index = buildIndex(entries, categories);

  return {
    search(options = {}) {
      const matches = matchesOf(index, options);
      return { total: matches.length, entries: matches.slice(0, clampLimit(options.limit)).map(({ entry }) => entry) };
    },

    find(id) {
      const position = index.byName.get(normalizeName(id));
      return position === undefined ? undefined : index.active[position]?.entry;
    },

    categories: categories.map((category) => {
      const members = index.active
        .filter((indexed) => indexed.entry.category === category.id)
        .map((indexed) => indexed.entry);
      return {
        id: category.id,
        label: category.label,
        order: category.order,
        activeCount: members.length,
        installableCount: members.filter((entry) => entry.installable).length,
      };
    }),
  };
}

/** The catalog this repository ships. */
export const mcpCatalogSearch = createMcpCatalogSearch();

export function searchMcpCatalog(options: McpCatalogSearchOptions = {}): McpCatalogSearchResult {
  return mcpCatalogSearch.search(options);
}

export function findMcpCatalogEntry(id: string): McpCatalogEntry | undefined {
  return mcpCatalogSearch.find(id);
}
