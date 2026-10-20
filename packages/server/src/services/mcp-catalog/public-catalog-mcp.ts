/**
 * The anonymous catalog endpoint's tool surface: the repo-shipped MCP marketplace, read-only.
 *
 * Three tools, all of which answer with one text block of JSON. The audience is a model that wants to
 * add a Server to its own configuration, so an entry carries what a client needs to write that
 * configuration — endpoint URL, auth method, key header, prerequisite — which is exactly what the
 * website projection (`api/public-catalog.ts`) deliberately leaves out.
 *
 * Nothing here reads an Account, a session, or a credential, and nothing here proxies a call to the
 * Server being described: this endpoint answers questions about the catalog and nothing else.
 *
 * `shortcut: this module holds no state beyond the imported catalog, so it is safe to call from any
 * request; a future write surface (ratings, usage) would need its own service and authorization`.
 */

import {
  findMcpCatalogEntry,
  type McpCatalogEntry,
  type McpCatalogLocale,
  mcpCatalogSearch,
  searchMcpCatalog,
} from "@opentag/mcp-presets";
import { z } from "zod";
import { type McpInboundHandlers, toolErrorResult } from "../mcp/mcp-inbound-protocol.js";

/** What this endpoint calls itself in `initialize` and `server/discover`. */
export const PUBLIC_CATALOG_SERVER_INFO = {
  name: "opentag-catalog",
  title: "OpenTag MCP Catalog",
  version: "1",
} as const;

const LOCALES = ["en", "zh"] as const;
const DEFAULT_LOCALE: McpCatalogLocale = "en";

const LocaleSchema = z.enum(LOCALES);

const SearchArgumentsSchema = z
  .object({
    query: z.string().max(200).optional(),
    category: z.string().max(64).optional(),
    locale: LocaleSchema.optional(),
    /* No maximum: an oversized limit is clamped, not refused, so a model that guesses high still gets results. */
    limit: z.number().int().min(1).optional(),
  })
  .strict();

const GetServerArgumentsSchema = z
  .object({
    id: z.string().min(1).max(128),
    locale: LocaleSchema.optional(),
  })
  .strict();

/** `z.toJSONSchema` stamps a `$schema` key no MCP client reads; the schema itself is what matters. */
function inputSchemaOf(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _ignored, ...jsonSchema } = z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>;
  return jsonSchema;
}

/**
 * Instructions are the only place a model learns how to use this endpoint well: that an empty query
 * lists everything, and that what comes back is configuration rather than a live connection.
 */
const INSTRUCTIONS = [
  `OpenTag MCP catalog: ${mcpCatalogSearch.categories.reduce((sum, category) => sum + category.activeCount, 0)} ` +
    "MCP Servers, grouped into categories.",
  "Call search_mcp_servers with an empty query to list every Server, or with a query to search names, " +
    "capabilities, and both English and Chinese copy.",
  "Every result carries `config` (a ready-to-paste mcpServers block) and `installCommand` when the Server " +
    "is hosted and installable, plus the auth method it expects.",
  "This endpoint only describes Servers. It does not call them, and it holds no credentials.",
].join("\n");

const TOOLS = [
  {
    name: "search_mcp_servers",
    description:
      "Search the OpenTag MCP catalog. An empty query lists every Server in catalog order. Returns each " +
      "match with its endpoint, auth method, and a ready-to-paste configuration.",
    schema: SearchArgumentsSchema,
  },
  {
    name: "get_mcp_server",
    description:
      "Read one MCP Server from the OpenTag catalog by id (for example `notion` or `mcp/notion`), " +
      "including its tools, prerequisites, and platforms.",
    schema: GetServerArgumentsSchema,
  },
  {
    name: "list_mcp_categories",
    description: "List the OpenTag MCP catalog categories with their active and installable Server counts.",
    schema: z.object({}).strict(),
  },
] as const;

/** An empty `authScheme` is a fact — "send the key with no prefix" — so presence is tested, not truthiness. */
function stringField(value: string | undefined, key: string): Record<string, string> {
  return value === undefined ? {} : { [key]: value };
}

/**
 * One catalog entry, as a caller configuring a client needs it.
 *
 * `url` and `config` are deliberately included: they are the same public facts the repo-shipped
 * `mcp-catalog.yaml` states, and a caller cannot act on a Server it cannot address. Every connection
 * field the entry carries is projected, because a `config` that omits a static header is a config
 * that does not work once pasted — `projectCatalogEntry` has a test that walks the whole catalog and
 * fails when a new field is dropped here.
 */
export function projectCatalogEntry(entry: McpCatalogEntry, locale: McpCatalogLocale): Record<string, unknown> {
  const installable = entry.installable && typeof entry.url === "string";
  const url = installable ? entry.url : undefined;
  /* A static `role: extra` header belongs in the client's own configuration; the credential does not. */
  const headers = entry.extraHeaders ? { headers: { ...entry.extraHeaders } } : {};
  return {
    id: entry.id,
    name: entry.name,
    title: entry.title[locale],
    description: entry.description[locale],
    whenToUse: entry.whenToUse[locale],
    category: entry.category,
    capabilities: [...entry.capabilities],
    risk: { sideEffects: entry.risk.sideEffects, dataAccess: entry.risk.dataAccess },
    status: entry.status,
    website: entry.website,
    installable,
    ...(url === undefined ? {} : { url }),
    auth: { methods: [...entry.auth.methods], defaultKind: entry.auth.defaultKind },
    ...stringField(entry.authHeader, "authHeader"),
    ...stringField(entry.authScheme, "authScheme"),
    ...(entry.keyAuth
      ? {
          keyAuth: {
            url: entry.keyAuth.url,
            ...stringField(entry.keyAuth.authHeader, "authHeader"),
            ...stringField(entry.keyAuth.authScheme, "authScheme"),
          },
        }
      : {}),
    ...(entry.oauthScopes ? { oauthScopes: [...entry.oauthScopes] } : {}),
    /* Names only: a catalog entry carries no credential, and projecting values would break that. */
    ...(entry.packages
      ? {
          packages: entry.packages.map((pkg) => ({
            registryType: pkg.registryType,
            identifier: pkg.identifier,
            version: pkg.version,
            ...(pkg.runtimeHint ? { runtimeHint: pkg.runtimeHint } : {}),
            transport: pkg.transport,
            ...(pkg.environmentVariables
              ? { environmentVariables: pkg.environmentVariables.map((variable) => variable.name) }
              : {}),
          })),
        }
      : {}),
    config: url === undefined ? null : { mcpServers: { [entry.name]: { type: "http", url, ...headers } } },
    installCommand: url === undefined ? null : `claude mcp add --transport http ${entry.name} ${url}`,
  };
}

function jsonResult(payload: unknown): unknown {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

/** One argument failure, described to the model rather than thrown: it can retry with better arguments. */
function invalidArguments(error: z.ZodError): unknown {
  const detail = error.issues.map((issue) => `${issue.path.join(".") || "arguments"}: ${issue.message}`).join("; ");
  return toolErrorResult(`Invalid arguments: ${detail}`);
}

function searchServers(rawArguments: unknown): unknown {
  const parsed = SearchArgumentsSchema.safeParse(rawArguments ?? {});
  if (!parsed.success) return invalidArguments(parsed.error);
  const locale = parsed.data.locale ?? DEFAULT_LOCALE;
  /* The search clamps `limit` itself, so an oversized one narrows to the documented maximum. */
  const { total, entries } = searchMcpCatalog(parsed.data);
  return jsonResult({ total, results: entries.map((entry) => projectCatalogEntry(entry, locale)) });
}

function getServer(rawArguments: unknown): unknown {
  const parsed = GetServerArgumentsSchema.safeParse(rawArguments ?? {});
  if (!parsed.success) return invalidArguments(parsed.error);
  const entry = findMcpCatalogEntry(parsed.data.id);
  if (!entry) return toolErrorResult(`No MCP Server "${parsed.data.id}" in the OpenTag catalog`);
  const locale = parsed.data.locale ?? DEFAULT_LOCALE;
  return jsonResult({
    ...projectCatalogEntry(entry, locale),
    ...(entry.prerequisites ? { prerequisites: [...entry.prerequisites] } : {}),
    ...(entry.platforms ? { platforms: [...entry.platforms] } : {}),
    ...(entry.remotes ? { remotes: entry.remotes.map((remote) => ({ ...remote })) } : {}),
    ...(entry.tools
      ? {
          tools: entry.tools.map((tool) => ({
            name: tool.name,
            sideEffect: tool.sideEffect,
            ...(tool.description ? { description: tool.description } : {}),
          })),
        }
      : {}),
  });
}

function listCategories(): unknown {
  return jsonResult({
    categories: mcpCatalogSearch.categories.map((category) => ({
      id: category.id,
      label: category.label,
      order: category.order,
      activeCount: category.activeCount,
      installableCount: category.installableCount,
    })),
  });
}

const HANDLERS: Record<string, (argumentsValue: unknown) => unknown> = {
  search_mcp_servers: searchServers,
  get_mcp_server: getServer,
  list_mcp_categories: listCategories,
};

/** The catalog endpoint's handlers: pure reads over compile-time data. */
export function createPublicCatalogHandlers(): McpInboundHandlers {
  return {
    serverInfo: PUBLIC_CATALOG_SERVER_INFO,
    listTools: async () => ({
      tools: TOOLS.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: inputSchemaOf(tool.schema),
      })),
      notes: [INSTRUCTIONS],
    }),
    callTool: async (name, args) => {
      const handler = HANDLERS[name];
      /* An unknown tool is the model's mistake to read and correct: a tool result, not a transport failure. */
      if (!handler) {
        return toolErrorResult(`Unknown tool "${name}". Available tools: ${Object.keys(HANDLERS).join(", ")}`);
      }
      return handler(args);
    },
  };
}
