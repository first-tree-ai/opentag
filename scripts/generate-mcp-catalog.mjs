#!/usr/bin/env node
/**
 * Compile the MCP marketplace catalog from its committed YAML sources and icons in
 * `packages/mcp-presets` into a committed TypeScript module in the same package.
 *
 * The sources are edited by an operator; this script is what turns that edit into a validated
 * artifact. It mirrors `generate-web-theme.mjs`: run it to write the module, run it with `--check` to
 * reject drift, and `pnpm check` runs the latter.
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
import { parse as parseYaml } from "yaml";
import { CreateMCPServerRequestSchema, MCPServerUrlSchema } from "../packages/shared/src/mcp.ts";
import { checkOutboundUrl } from "../packages/shared/src/mcp-outbound-url.ts";

const ID_PATTERN = /^[a-z][a-z0-9-]*$/;
const ICON_PATTERN = /^[a-z0-9][a-z0-9-]*\.svg$/;
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
const targetPath = `${catalogDirectory}/src/mcp-catalog.gen.ts`;
const localeSettingsPath = `${root}apps/web/project.inlang/settings.json`;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
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

/** The entry's id, having proven the row is a mapping and the id is present and unique. */
function readEntryId(row, at, seen, violations) {
  if (!isRecord(row)) {
    violations.push(`${at}: must be a mapping`);
    return undefined;
  }
  const id = row.id;
  if (typeof id !== "string" || !ID_PATTERN.test(id)) {
    violations.push(`${at}: "id" must match ${ID_PATTERN}`);
    return undefined;
  }
  if (seen.has(id)) {
    violations.push(`${at}: duplicate entry id "${id}"`);
    return undefined;
  }
  seen.add(id);
  return id;
}

/**
 * Validate the create payload the add flow will send, not the YAML shape: the same strict schema the
 * Server enforces decides the name, the URL, the auth header and scheme, and the extra headers —
 * including the rule that an extra header may not collide with the auth header.
 */
function validateCreatePayload(row, at, violations) {
  const create = CreateMCPServerRequestSchema.safeParse({
    name: row.name,
    url: row.url,
    defaultAuthKind: row.defaultAuthKind,
    ...(row.authHeader === undefined ? {} : { authHeader: row.authHeader }),
    ...(row.authScheme === undefined ? {} : { authScheme: row.authScheme }),
    ...(row.extraHeaders === undefined ? {} : { extraHeaders: row.extraHeaders }),
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
  if ("failure" in verdict) violations.push(`${at}.url: ${verdict.failure.message}`);
}

/** The fields the catalog itself owns: category membership, the provider link, and the icon name. */
function validateCatalogMembership(row, at, categoryIds, violations) {
  if (typeof row.category !== "string" || !categoryIds.has(row.category)) {
    violations.push(`${at}.category: "${String(row.category)}" is not declared in mcp-categories.yaml`);
  }
  if (typeof row.website !== "string" || !isHttpUrl(row.website)) {
    violations.push(`${at}.website: must be an absolute http(s) URL`);
  }
  if (typeof row.icon !== "string" || !ICON_PATTERN.test(row.icon)) {
    violations.push(`${at}.icon: must be a lowercase SVG file name`);
  }
}

function collectEntries(rows, categoryIds, locales, violations) {
  const entries = [];
  const seen = new Set();
  rows.forEach((row, index) => {
    const at = `${entriesPath}[${index}]`;
    const id = readEntryId(row, at, seen, violations);
    if (id === undefined) return;

    validateCreatePayload(row, at, violations);
    validateOutboundUrl(row.url, at, violations);
    validateCatalogMembership(row, at, categoryIds, violations);

    const title = readLocalized(row.title, `${at}.title`, locales, violations);
    const description = readLocalized(row.description, `${at}.description`, locales, violations);
    const order = readOrder(row.order, `${at}.order`, violations);
    if (!title || !description || order === undefined) return;
    entries.push(catalogEntryFrom(row, id, title, description, order));
  });
  return entries;
}

/** The validated fields, read into the shape the generated module carries. */
function catalogEntryFrom(row, id, title, description, order) {
  return {
    id,
    name: typeof row.name === "string" ? row.name : "",
    title,
    description,
    url: typeof row.url === "string" ? row.url : "",
    defaultAuthKind: row.defaultAuthKind,
    category: row.category,
    website: typeof row.website === "string" ? row.website : "",
    icon: typeof row.icon === "string" ? row.icon : "",
    authHeader: typeof row.authHeader === "string" ? row.authHeader : undefined,
    authScheme: typeof row.authScheme === "string" ? row.authScheme : undefined,
    extraHeaders: isRecord(row.extraHeaders) ? row.extraHeaders : undefined,
    order,
  };
}

/** Verify every referenced icon exists, and read its bytes into the data URL the module embeds. */
async function resolveIcons(entries, violations) {
  const urls = new Map();
  const files = [...new Set(entries.map((entry) => entry.icon))].sort();
  for (const file of files) {
    try {
      const svg = await readFile(`${iconDirectory}/${file}`);
      urls.set(file, `data:image/svg+xml;base64,${svg.toString("base64")}`);
    } catch {
      violations.push(`${entriesPath}: icon "${file}" does not exist under packages/mcp-presets/icons/`);
    }
  }
  return urls;
}

function localizedLines(prefix, value, locales, indent) {
  const lines = [`${indent}${prefix}: {`];
  for (const locale of locales) lines.push(`${indent}  ${locale}: ${JSON.stringify(value[locale])},`);
  lines.push(`${indent}},`);
  return lines;
}

function emitModule(categories, entries, locales, icons) {
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
    "export type McpCatalogEntry = {",
    "  id: string;",
    "  name: string;",
    "  title: McpCatalogLocalizedText;",
    "  description: McpCatalogLocalizedText;",
    "  url: string;",
    "  defaultAuthKind: MCPAuthKind;",
    "  authHeader?: string;",
    "  authScheme?: string;",
    "  extraHeaders?: Record<string, string>;",
    "  category: string;",
    "  website: string;",
    "  iconUrl: string;",
    "  order: number;",
    "};",
    "",
    "/** Tab order is this array's order. */",
    "export const MCP_CATALOG_CATEGORIES: readonly McpCatalogCategory[] = [",
  ];
  for (const category of orderedCategories) {
    lines.push("  {", `    id: ${JSON.stringify(category.id)},`);
    lines.push(...localizedLines("label", category.label, locales, "    "));
    lines.push(`    order: ${category.order},`, "  },");
  }
  lines.push(
    "];",
    "",
    "/** Grouped by category order, then entry order. */",
    "export const MCP_CATALOG_ENTRIES: readonly McpCatalogEntry[] = [",
  );
  for (const entry of orderedEntries) {
    lines.push("  {", `    id: ${JSON.stringify(entry.id)},`, `    name: ${JSON.stringify(entry.name)},`);
    lines.push(...localizedLines("title", entry.title, locales, "    "));
    lines.push(...localizedLines("description", entry.description, locales, "    "));
    lines.push(
      `    url: ${JSON.stringify(entry.url)},`,
      `    defaultAuthKind: ${JSON.stringify(entry.defaultAuthKind)},`,
    );
    if (entry.authHeader !== undefined) lines.push(`    authHeader: ${JSON.stringify(entry.authHeader)},`);
    if (entry.authScheme !== undefined) lines.push(`    authScheme: ${JSON.stringify(entry.authScheme)},`);
    if (entry.extraHeaders !== undefined) {
      const sorted = Object.fromEntries(Object.entries(entry.extraHeaders).sort(([a], [b]) => a.localeCompare(b)));
      lines.push(`    extraHeaders: ${JSON.stringify(sorted)},`);
    }
    lines.push(
      `    category: ${JSON.stringify(entry.category)},`,
      `    website: ${JSON.stringify(entry.website)},`,
      `    iconUrl: MCP_CATALOG_ICON_URLS[${JSON.stringify(entry.icon)}],`,
      `    order: ${entry.order},`,
      "  },",
    );
  }
  lines.push("];", "");
  return lines.join("\n");
}

async function main() {
  const locales = await readLocales();
  const violations = [];
  const categories = collectCategories(await readYamlList(categoriesPath, violations), locales, violations);
  const categoryIds = new Set(categories.map((category) => category.id));
  const entries = collectEntries(await readYamlList(entriesPath, violations), categoryIds, locales, violations);
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

  const text = emitModule(categories, entries, locales, icons);
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
