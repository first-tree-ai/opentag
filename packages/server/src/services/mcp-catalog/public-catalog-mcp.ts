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
import { MCP_LEGACY_PROTOCOL_VERSIONS } from "@opentag/shared";
import { z } from "zod";
import { type McpInboundHandlers, toolErrorResult } from "../mcp/mcp-inbound-protocol.js";

/** What this endpoint calls itself in `initialize` and `server/discover`. */
export const PUBLIC_CATALOG_SERVER_INFO = {
  name: "opentag-catalog",
  title: "openTag MCP Catalog",
  version: "1",
} as const;

/**
 * The revisions this endpoint answers: the legacy handshake only.
 *
 * The modern revision requires per-request version metadata, mirrored `MCP-Protocol-Version` /
 * `Mcp-Method` / `Mcp-Name` headers, and a `resultType` on every result. None of that is implemented
 * here, so advertising it would strand a conforming client mid-flow. Listing only the legacy
 * revisions makes a negotiating client fall back to `initialize`, which this endpoint does implement.
 */
export const PUBLIC_CATALOG_SUPPORTED_VERSIONS = MCP_LEGACY_PROTOCOL_VERSIONS;

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
  `openTag MCP catalog: ${mcpCatalogSearch.categories.reduce((sum, category) => sum + category.activeCount, 0)} ` +
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
      "Search the openTag MCP catalog. An empty query lists every Server in catalog order. Returns each " +
      "match with its endpoint, auth method, and a ready-to-paste configuration.",
    schema: SearchArgumentsSchema,
  },
  {
    name: "get_mcp_server",
    description:
      "Read one MCP Server from the openTag catalog by id (for example `notion` or `mcp/notion`), " +
      "including its tools, prerequisites, and platforms.",
    schema: GetServerArgumentsSchema,
  },
  {
    name: "list_mcp_categories",
    description: "List the openTag MCP catalog categories with their active and installable Server counts.",
    schema: z.object({}).strict(),
  },
] as const;

const SHELL_SAFE = /^[\w@%+=:,./-]+$/;

/**
 * Quote one argument for a POSIX shell.
 *
 * A catalog URL may carry a query string — `https://mcp.atlassian.com/v2/mcp?tools=all` — and an
 * unquoted `?` is a glob in zsh, so the pasted command fails before `claude` ever runs.
 */
function shellQuote(value: string): string {
  return SHELL_SAFE.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

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
    installCommand:
      url === undefined ? null : `claude mcp add --transport http ${shellQuote(entry.name)} ${shellQuote(url)}`,
  };
}

function jsonResult(payload: unknown): unknown {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

/**
 * A failure the model can act on, as a tool result rather than a transport error.
 *
 * The text is JSON like every successful result, so one consumer contract covers both: the shape is
 * `{ error: { code, message, … } }` and `isError` is true.
 */
function toolErrorJson(code: string, message: string, extra: Record<string, unknown> = {}): unknown {
  return toolErrorResult(JSON.stringify({ error: { code, message, ...extra } }));
}

/** One argument failure: the model can read which argument was wrong and retry. */
function invalidArguments(error: z.ZodError): unknown {
  return toolErrorJson("invalid_arguments", "The tool arguments did not match its input schema", {
    issues: error.issues.map((issue) => ({
      path: issue.path.join(".") || "arguments",
      message: issue.message,
    })),
  });
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
  if (!entry) {
    return toolErrorJson("unknown_server", `No MCP Server "${parsed.data.id}" in the openTag catalog`, {
      id: parsed.data.id,
    });
  }
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

/**
 * The tools this endpoint answers.
 *
 * A `Map` rather than an object: with an object, `constructor`, `toString`, and the rest of
 * `Object.prototype` would resolve to inherited members and be invoked as tools instead of being
 * refused as unknown. A model naming a tool after a JavaScript built-in is a real prompt-injected
 * input, not a theoretical one.
 */
const HANDLERS = new Map<string, (argumentsValue: unknown) => unknown>([
  ["search_mcp_servers", searchServers],
  ["get_mcp_server", getServer],
  ["list_mcp_categories", listCategories],
]);

/** The catalog endpoint's handlers: pure reads over compile-time data. */
export function createPublicCatalogHandlers(): McpInboundHandlers {
  return {
    serverInfo: PUBLIC_CATALOG_SERVER_INFO,
    supportedVersions: PUBLIC_CATALOG_SUPPORTED_VERSIONS,
    listTools: async () => ({
      tools: TOOLS.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: inputSchemaOf(tool.schema),
      })),
      notes: [INSTRUCTIONS],
    }),
    callTool: async (name, args) => {
      const handler = HANDLERS.get(name);
      /* An unknown tool is the model's mistake to read and correct: a tool result, not a transport failure. */
      if (!handler) {
        return toolErrorJson("unknown_tool", `Unknown tool "${name}"`, { availableTools: [...HANDLERS.keys()] });
      }
      return handler(args);
    },
  };
}
