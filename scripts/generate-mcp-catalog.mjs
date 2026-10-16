#!/usr/bin/env node
/**
 * Compile the MCP marketplace catalog from its committed YAML sources and icons in
 * `packages/mcp-presets` into a committed TypeScript module in the same package.
 *
 * The sources are edited by an operator; this script is what turns that edit into a validated
 * artifact. It mirrors `generate-web-theme.mjs`: run it to write the module, run it with `--check` to
 * reject drift, and `pnpm check` runs the latter.
 *
 * Each entry is first validated against `schema/mcp-catalog-entry.schema.json` (JSON Schema 2020-12,
 * with the supported locales injected from the i18n project). The checks a schema cannot express
 * follow: auth cross-references, the risk ordering, category membership, and the create payload.
 *
 * Every catalog invariant is enforced here rather than at a user's click: an endpoint the outbound
 * policy would refuse, a name the Server would reject, an undeclared or unreferenced category, a
 * duplicate id, a missing locale, or a missing icon all fail the build. Icon bytes are embedded as
 * data URLs so the generated module carries no asset imports and builds with plain `tsdown`.
 *
 * It runs under `tsx` because it reads the shared runtime schemas from source: `pnpm check` runs
 * before `pnpm build`, so `packages/shared/dist` does not exist yet.
 */
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { parse as parseYaml } from "yaml";
import { CreateMCPServerRequestSchema, MCPServerUrlSchema } from "../packages/shared/src/mcp.ts";
import { checkOutboundUrl } from "../packages/shared/src/mcp-outbound-url.ts";

const ID_PATTERN = /^[a-z][a-z0-9-]*$/;
/** The ordering `risk.side_effects` and `tools[].side_effect` share. */
const SIDE_EFFECT_RANK = { none: 0, write: 1, destructive: 2 };
/** `biome.json` `formatter.lineWidth`; the emitted module must already be in biome's format. */
const PRINT_WIDTH = 120;

/** `--root` points the generator at a fixture tree; a script test sets it so it never touches the repo. */
function flag(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const overrideRoot = flag("--root");
const root = overrideRoot ? `${overrideRoot.replace(/[/\\]+$/, "")}/` : fileURLToPath(new URL("..", import.meta.url));
const catalogDirectory = `${root}packages/mcp-presets`;
const iconDirectory = `${catalogDirectory}/icons`;
const categoriesPath = `${catalogDirectory}/mcp-categories.yaml`;
const entriesPath = `${catalogDirectory}/mcp-catalog.yaml`;
/** The schema ships with the generator, so a `--root` fixture tree needs no copy of it. */
const entrySchemaPath = fileURLToPath(
  new URL("../packages/mcp-presets/schema/mcp-catalog-entry.schema.json", import.meta.url),
);
const targetPath = `${catalogDirectory}/src/mcp-catalog.gen.ts`;
const localeSettingsPath = `${root}apps/web/project.inlang/settings.json`;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The app's supported locales, taken from the i18n project so the catalog cannot disagree with it. */
async function readLocales() {
  const settings = JSON.parse(await readFile(localeSettingsPath, "utf8"));
  const locales = settings.locales;
  if (!Array.isArray(locales) || locales.length === 0 || locales.some((locale) => typeof locale !== "string")) {
    throw new Error(`${localeSettingsPath}: "locales" must be a non-empty array of strings`);
  }
  return locales;
}

async function readYamlList(path, violations) {
  let parsed;
  try {
    parsed = parseYaml(await readFile(path, "utf8"));
  } catch (error) {
    violations.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
  if (!Array.isArray(parsed)) {
    violations.push(`${path}: the file must hold a YAML list`);
    return [];
  }
  return parsed;
}

/** One localized field, required in every supported locale and refused in any unknown one. */
function readLocalized(value, at, locales, violations) {
  if (!isRecord(value)) {
    violations.push(`${at}: must be a mapping of locale to text`);
    return undefined;
  }
  const text = {};
  for (const locale of locales) {
    const raw = value[locale];
    if (typeof raw !== "string" || raw.trim().length === 0) {
      violations.push(`${at}: missing the "${locale}" locale`);
      return undefined;
    }
    text[locale] = raw.trim();
  }
  const unknown = Object.keys(value).filter((key) => !locales.includes(key));
  if (unknown.length > 0) violations.push(`${at}: unknown locale(s) ${unknown.join(", ")}`);
  return text;
}

function readOrder(value, at, violations) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    violations.push(`${at}: "order" must be a finite number`);
    return undefined;
  }
  return value;
}

function collectCategories(rows, locales, violations) {
  const categories = [];
  const seen = new Set();
  rows.forEach((row, index) => {
    const at = `${categoriesPath}[${index}]`;
    if (!isRecord(row)) {
      violations.push(`${at}: must be a mapping`);
      return;
    }
    const id = row.id;
    if (typeof id !== "string" || !ID_PATTERN.test(id)) {
      violations.push(`${at}: "id" must match ${ID_PATTERN}`);
      return;
    }
    if (seen.has(id)) {
      violations.push(`${at}: duplicate category id "${id}"`);
      return;
    }
    seen.add(id);
    const label = readLocalized(row.label, `${at}.label`, locales, violations);
    const order = readOrder(row.order, `${at}.order`, violations);
    if (!label || order === undefined) return;
    categories.push({ id, label, order });
  });
  return categories;
}

/** Verify every referenced icon exists, and read its bytes into the data URL the module embeds. */
async function resolveIcons(entries, violations) {
  const urls = new Map();
  const files = [...new Set(entries.map((entry) => entry.icon))].sort();
  for (const file of files) {
    try {
      const bytes = await readFile(`${iconDirectory}/${file}`);
      const mime = file.endsWith(".png") ? "image/png" : "image/svg+xml";
      urls.set(file, `data:${mime};base64,${bytes.toString("base64")}`);
    } catch {
      violations.push(`${entriesPath}: icon "${file}" does not exist under packages/mcp-presets/icons/`);
    }
  }
  return urls;
}

/** Translate an Ajv error into one operator-readable line that names the offending field. */
function describeSchemaError(error, at) {
  const path = error.instancePath
    .split("/")
    .filter((part) => part.length > 0)
    .map((part) => (/^\d+$/.test(part) ? `[${part}]` : `.${part.replace(/~1/g, "/").replace(/~0/g, "~")}`))
    .join("");
  const base = `${at}${path}`;
  if (error.keyword === "required") return `${base}.${error.params.missingProperty}: is required`;
  if (error.keyword === "additionalProperties") return `${base}.${error.params.additionalProperty}: unknown property`;
  if (error.keyword === "const") return `${base}: must be ${JSON.stringify(error.params.allowedValue)}`;
  if (error.keyword === "enum") return `${base}: must be one of ${error.params.allowedValues.join(", ")}`;
  return `${base}: ${error.message}`;
}

/**
 * The entry schema with this app's locales injected into the shared localized-text definition, so a
 * missing or extra locale is a schema failure rather than a special case.
 */
async function readEntryValidator(locales) {
  const schema = JSON.parse(await readFile(entrySchemaPath, "utf8"));
  const text = schema.$defs.localizedText.properties[locales[0]] ?? schema.$defs.localizedText.properties.en;
  schema.$defs.localizedText.properties = Object.fromEntries(locales.map((locale) => [locale, text]));
  schema.$defs.localizedText.required = [...locales];
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  return { schema, validate: ajv.compile(schema) };
}

/**
 * Validate the create payload the add flow will send: the same strict schema the Server enforces
 * decides the name, the URL, the auth header and scheme, and the extra headers — including the rule
 * that an extra header may not collide with the auth header.
 */
function validateCreatePayload(derived, at, violations) {
  const create = CreateMCPServerRequestSchema.safeParse({
    name: derived.name,
    url: derived.url,
    defaultAuthKind: derived.defaultAuthKind,
    ...(derived.authHeader === undefined ? {} : { authHeader: derived.authHeader }),
    ...(derived.authScheme === undefined ? {} : { authScheme: derived.authScheme }),
    ...(derived.extraHeaders === undefined ? {} : { extraHeaders: derived.extraHeaders }),
  });
  if (create.success) return;
  for (const issue of create.error.issues) {
    violations.push(`${at}.${issue.path.join(".") || "entry"}: ${issue.message}`);
  }
}

/** The endpoint must be one the Server's outbound gate would dial. */
function validateOutboundUrl(value, at, violations) {
  const url = MCPServerUrlSchema.safeParse(value);
  if (!url.success) return;
  const verdict = checkOutboundUrl(url.data, { allowLoopback: false });
  if ("failure" in verdict) violations.push(`${at}.remotes[0].url: ${verdict.failure.message}`);
}

/** Auth rules that relate two fields of a schema-valid entry. */
function validateAuth(row, at, violations) {
  const { methods, default_kind: defaultKind, oauth } = row.auth;
  if (!methods.includes(defaultKind)) {
    violations.push(`${at}.auth.default_kind: "${defaultKind}" is not listed in auth.methods`);
  }
  if (methods.includes("oauth") && oauth === undefined) {
    violations.push(`${at}.auth.oauth: is required when auth.methods lists "oauth"`);
  }
  if (!methods.includes("oauth") && oauth !== undefined) {
    violations.push(`${at}.auth.oauth: is only allowed when auth.methods lists "oauth"`);
  }
}

/** `risk.side_effects` may not understate the strongest tool, and tool names are unique. */
function validateRisk(row, at, violations) {
  const seen = new Set();
  let strongest = 0;
  for (const [index, tool] of (row.tools ?? []).entries()) {
    if (seen.has(tool.name)) violations.push(`${at}.tools[${index}].name: duplicate tool "${tool.name}"`);
    seen.add(tool.name);
    strongest = Math.max(strongest, SIDE_EFFECT_RANK[tool.side_effect]);
  }
  if (SIDE_EFFECT_RANK[row.risk.side_effects] < strongest) {
    violations.push(
      `${at}.risk.side_effects: "${row.risk.side_effects}" is weaker than the strongest tool side effect`,
    );
  }
}

/** Rules one header must satisfy on its own; the role decides which fields it may carry. */
function validateHeader(header, where, violations) {
  if (header.role === "auth") {
    if (header.value !== undefined) violations.push(`${where}.value: an auth header carries no static value`);
    return;
  }
  if (header.value === undefined) violations.push(`${where}.value: an extra header requires a value`);
  if (header.scheme !== undefined) violations.push(`${where}.scheme: only an auth header has a scheme`);
}

/** The remote's headers, split into the create payload's auth header and static extra headers. */
function readHeaders(row, at, violations) {
  const names = new Set();
  const extraHeaders = {};
  let auth;
  for (const [index, header] of (row.remotes[0].headers ?? []).entries()) {
    const where = `${at}.remotes[0].headers[${index}]`;
    const key = header.name.toLowerCase();
    if (names.has(key)) violations.push(`${where}.name: duplicate header "${header.name}"`);
    names.add(key);
    validateHeader(header, where, violations);
    if (header.role === "extra") {
      if (header.value !== undefined) extraHeaders[header.name] = header.value;
      continue;
    }
    if (auth !== undefined) violations.push(`${where}.role: only one header may have the "auth" role`);
    auth = header;
  }
  return {
    authHeader: auth?.name,
    authScheme: auth?.scheme,
    extraHeaders: Object.keys(extraHeaders).length > 0 ? extraHeaders : undefined,
  };
}

/** The fields the catalog itself owns: category membership. The icon file is checked in `resolveIcons`. */
function validateCatalogMembership(row, at, categoryIds, violations) {
  if (!categoryIds.has(row.catalog.category)) {
    violations.push(`${at}.catalog.category: "${row.catalog.category}" is not declared in mcp-categories.yaml`);
  }
}

/** A schema-valid entry, read into the shape the generated module carries. */
function catalogEntryFrom(row, headers) {
  const slug = row.id.slice("mcp/".length);
  return {
    id: slug,
    registryId: row.id,
    name: slug,
    title: row.name,
    description: row.summary,
    whenToUse: row.when_to_use,
    url: row.remotes[0].url,
    defaultAuthKind: row.auth.default_kind,
    ...headers,
    oauthScopes: row.auth.oauth?.scopes,
    category: row.catalog.category,
    website: row.homepage,
    icon: row.catalog.icon,
    iconIsOfficial: row.catalog.icon_is_official,
    order: row.catalog.order,
    status: row.status,
    capabilities: row.capabilities,
    keywords: row.keywords,
    aliases: row.aliases,
    tags: row.tags,
    auth: {
      methods: row.auth.methods,
      defaultKind: row.auth.default_kind,
      ...(row.auth.oauth ? { oauth: { scopes: row.auth.oauth.scopes } } : {}),
    },
    risk: {
      sideEffects: row.risk.side_effects,
      dataAccess: row.risk.data_access,
      ...(row.risk.notes ? { notes: row.risk.notes } : {}),
    },
    tools: row.tools?.map((tool) => ({
      name: tool.name,
      ...(tool.description === undefined ? {} : { description: tool.description }),
      sideEffect: tool.side_effect,
    })),
    repository: row.repository,
    license: row.license,
    maintainers: row.maintainers,
  };
}

function collectEntries(rows, categoryIds, validate, violations) {
  const entries = [];
  const seen = new Set();
  rows.forEach((row, index) => {
    const at = `${entriesPath}[${index}]`;
    if (!validate(row)) {
      for (const error of validate.errors ?? []) violations.push(describeSchemaError(error, at));
      return;
    }
    if (seen.has(row.id)) {
      violations.push(`${at}.id: duplicate entry id "${row.id}"`);
      return;
    }
    seen.add(row.id);

    validateAuth(row, at, violations);
    validateRisk(row, at, violations);
    validateCatalogMembership(row, at, categoryIds, violations);
    const entry = catalogEntryFrom(row, readHeaders(row, at, violations));
    validateCreatePayload(entry, at, violations);
    validateOutboundUrl(entry.url, at, violations);
    // A removed entry is validated like any other, then withheld so no surface can offer it.
    if (entry.status !== "removed") entries.push(entry);
  });
  return entries;
}

/** A verbatim TypeScript expression inside an otherwise literal value. */
class Raw {
  constructor(text) {
    this.text = text;
  }
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function propertyKey(key) {
  return IDENTIFIER.test(key) ? key : JSON.stringify(key);
}

/**
 * Print a value the way biome formats a TypeScript literal at `PRINT_WIDTH`: objects always expand,
 * primitive arrays stay inline while they fit, and a string that does not fit moves under its key.
 * `lead` is the text before the value on its first line (`key: `) and `trail` the text after it.
 */
function printValue(value, indent, lead, trail) {
  if (value instanceof Raw) return [`${indent}${lead}${value.text}${trail}`];
  if (Array.isArray(value)) return printArray(value, indent, lead, trail);
  if (typeof value === "object" && value !== null) return printObject(value, indent, lead, trail);
  const text = JSON.stringify(value);
  const single = `${indent}${lead}${text}${trail}`;
  if (single.length <= PRINT_WIDTH || typeof value !== "string" || lead.length === 0) return [single];
  return [`${indent}${lead.trimEnd()}`, `${indent}  ${text}${trail}`];
}

function printArray(items, indent, lead, trail) {
  if (items.length === 0) return [`${indent}${lead}[]${trail}`];
  if (items.every((item) => typeof item !== "object" || item === null)) {
    const inline = `${indent}${lead}[${items.map((item) => JSON.stringify(item)).join(", ")}]${trail}`;
    if (inline.length <= PRINT_WIDTH) return [inline];
  }
  const lines = [`${indent}${lead}[`];
  for (const item of items) lines.push(...printValue(item, `${indent}  `, "", ","));
  lines.push(`${indent}]${trail}`);
  return lines;
}

function printObject(object, indent, lead, trail) {
  const keys = Object.keys(object).filter((key) => object[key] !== undefined);
  if (keys.length === 0) return [`${indent}${lead}{}${trail}`];
  const lines = [`${indent}${lead}{`];
  for (const key of keys) lines.push(...printValue(object[key], `${indent}  `, `${propertyKey(key)}: `, ","));
  lines.push(`${indent}}${trail}`);
  return lines;
}

/** The entry as emitted: the icon name resolves to the embedded data URL constant. */
function emittedEntry(entry) {
  const { icon, ...rest } = entry;
  return {
    ...rest,
    iconUrl: new Raw(`MCP_CATALOG_ICON_URLS[${JSON.stringify(icon)}]`),
    iconIsOfficial: entry.iconIsOfficial ? true : undefined,
  };
}

function emitModule(categories, entries, locales, icons, entrySchema) {
  const categoryOrder = new Map(categories.map((category) => [category.id, category.order]));
  const orderedCategories = [...categories].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  const orderedEntries = [...entries].sort(
    (a, b) =>
      (categoryOrder.get(a.category) ?? 0) - (categoryOrder.get(b.category) ?? 0) ||
      a.order - b.order ||
      a.id.localeCompare(b.id),
  );

  const iconFiles = [...new Set(orderedEntries.map((entry) => entry.icon))].filter((file) => icons.has(file)).sort();
  const iconLines = iconFiles.map((file) => {
    const key = JSON.stringify(file);
    const value = JSON.stringify(icons.get(file));
    const single = `  ${key}: ${value},`;
    return single.length <= PRINT_WIDTH ? single : `  ${key}:\n    ${value},`;
  });
  const localeUnion = locales.map((locale) => JSON.stringify(locale)).join(" | ");

  const lines = [
    "/**",
    " * Generated by scripts/generate-mcp-catalog.mjs from mcp-categories.yaml, mcp-catalog.yaml, and icons/*.",
    " * Do not edit by hand. Run `pnpm catalog:generate`.",
    " */",
    'import type { MCPAuthKind } from "@opentag/shared/browser";',
    "",
    "/** The locales the Web App supports, taken from its i18n project settings. */",
    `export type McpCatalogLocale = ${localeUnion};`,
    "",
    "/** Card and tab copy. Every supported locale is required, so a card never falls back silently. */",
    "export type McpCatalogLocalizedText = Record<McpCatalogLocale, string>;",
    "",
    "/** The ordering of a tool's or a Server's strongest effect. */",
    'export type McpCatalogSideEffect = "none" | "write" | "destructive";',
    "",
    "/** Whether an entry is offered. `removed` entries are never emitted. */",
    'export type McpCatalogStatus = "active" | "deprecated" | "archived";',
    "",
    "/** The card marks, embedded as data URLs: one declaration per distinct icon file. */",
    "export const MCP_CATALOG_ICON_URLS = {",
    ...iconLines,
    "} as const;",
    "",
    "export type McpCatalogCategory = {",
    "  id: string;",
    "  label: McpCatalogLocalizedText;",
    "  order: number;",
    "};",
    "",
    "export type McpCatalogTool = {",
    "  name: string;",
    "  description?: string;",
    "  sideEffect: McpCatalogSideEffect;",
    "};",
    "",
    "export type McpCatalogEntry = {",
    "  /** The slug: the Server definition name and the card id the Web App keys on. */",
    "  id: string;",
    "  /** The registry identity, `mcp/<slug>`. */",
    "  registryId: string;",
    "  name: string;",
    "  title: McpCatalogLocalizedText;",
    "  description: McpCatalogLocalizedText;",
    "  whenToUse: McpCatalogLocalizedText;",
    "  url: string;",
    "  defaultAuthKind: MCPAuthKind;",
    "  authHeader?: string;",
    "  authScheme?: string;",
    "  extraHeaders?: Record<string, string>;",
    "  oauthScopes?: string[];",
    "  category: string;",
    "  website: string;",
    "  iconUrl: string;",
    "  iconIsOfficial?: boolean;",
    "  order: number;",
    "  status: McpCatalogStatus;",
    "  capabilities: string[];",
    "  keywords?: string[];",
    "  aliases?: string[];",
    "  tags?: string[];",
    "  auth: {",
    "    methods: MCPAuthKind[];",
    "    defaultKind: MCPAuthKind;",
    "    oauth?: { scopes?: string[] };",
    "  };",
    "  risk: {",
    "    sideEffects: McpCatalogSideEffect;",
    '    dataAccess: "public" | "private";',
    "    notes?: McpCatalogLocalizedText;",
    "  };",
    "  tools?: McpCatalogTool[];",
    "  repository?: string;",
    "  license?: string;",
    "  maintainers?: string[];",
    "};",
    "",
    "/** The JSON Schema every source entry was validated against, with the supported locales injected. */",
    ...printValue(entrySchema, "", "export const MCP_CATALOG_ENTRY_SCHEMA = ", " as const;"),
    "",
    "/** Tab order is this array's order. */",
    "export const MCP_CATALOG_CATEGORIES: readonly McpCatalogCategory[] = [",
  ];
  for (const category of orderedCategories) {
    lines.push(...printValue({ id: category.id, label: category.label, order: category.order }, "  ", "", ","));
  }
  lines.push(
    "];",
    "",
    "/** Grouped by category order, then entry order. */",
    "export const MCP_CATALOG_ENTRIES: readonly McpCatalogEntry[] = [",
  );
  for (const entry of orderedEntries) {
    const sortedHeaders = entry.extraHeaders
      ? Object.fromEntries(Object.entries(entry.extraHeaders).sort(([a], [b]) => a.localeCompare(b)))
      : undefined;
    lines.push(...printValue(emittedEntry({ ...entry, extraHeaders: sortedHeaders }), "  ", "", ","));
  }
  lines.push("];", "");
  return lines.join("\n");
}

async function main() {
  const locales = await readLocales();
  const violations = [];
  const { schema, validate } = await readEntryValidator(locales);
  const categories = collectCategories(await readYamlList(categoriesPath, violations), locales, violations);
  const categoryIds = new Set(categories.map((category) => category.id));
  const entries = collectEntries(await readYamlList(entriesPath, violations), categoryIds, validate, violations);
  const icons = await resolveIcons(entries, violations);

  const referenced = new Set(entries.map((entry) => entry.category));
  for (const category of categories) {
    if (!referenced.has(category.id)) {
      violations.push(`${categoriesPath}: category "${category.id}" is declared but no entry references it`);
    }
  }

  if (violations.length > 0) {
    for (const violation of violations) console.error(`[mcp-catalog] ${violation}`);
    throw new Error(`The MCP catalog has ${violations.length} problem(s)`);
  }

  const text = emitModule(categories, entries, locales, icons, schema);
  if (process.argv.includes("--check")) {
    const current = await readFile(targetPath, "utf8").catch(() => "");
    if (current !== text) {
      throw new Error("The generated MCP catalog is out of date. Run pnpm catalog:generate.");
    }
    console.log("[mcp-catalog] generated module is current");
    return;
  }
  await writeFile(targetPath, text);
  console.log(`[mcp-catalog] wrote ${targetPath}`);
}

await main();
