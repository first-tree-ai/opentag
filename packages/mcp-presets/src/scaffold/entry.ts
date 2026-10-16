import type { McpCatalogCategory, McpCatalogEntry } from "../mcp-catalog.gen.js";
import type { McpProbeResult, ProbeAuthKind } from "./probe.js";

const ORDER_STEP = 10;
const ID_PATTERN = /^[a-z][a-z0-9-]*$/;
const MAX_NAME_LENGTH = 64;

export interface ScaffoldInput {
  readonly url: string;
  readonly probe: Extract<McpProbeResult, { ok: true }>;
  readonly id?: string;
  readonly category?: string;
  readonly website?: string;
  readonly titleEn?: string;
  readonly titleZh?: string;
  readonly descriptionEn?: string;
  readonly descriptionZh?: string;
  readonly authKind?: ProbeAuthKind;
  readonly order?: number;
}

export interface ScaffoldedEntry {
  readonly id: string;
  readonly yaml: string;
  readonly iconFile: string;
  /** Fields the operator must review before committing. */
  readonly todos: readonly string[];
}

/** Lowercase, hyphen-separated, starts with a letter, and within the definition-name limit. */
export function slugify(raw: string): string {
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/^[0-9-]+/, "")
    .slice(0, MAX_NAME_LENGTH)
    .replace(/-+$/g, "");
  return slug;
}

function stripGenericWords(slug: string): string {
  const stripped = slug.replace(/(^|-)(mcp|server|remote)(?=-|$)/g, "").replace(/^-+|-+$/g, "");
  return stripped.length > 0 ? stripped : slug;
}

/** Derive an entry id from the server's own name, falling back to the host's first meaningful label. */
export function deriveId(url: string, serverName: string | undefined): string {
  const fromName = serverName === undefined ? "" : stripGenericWords(slugify(serverName));
  if (ID_PATTERN.test(fromName)) return fromName;
  const labels = new URL(url).hostname.split(".").filter((label) => !["www", "mcp", "api", "app"].includes(label));
  return slugify(labels[0] ?? "server") || "server";
}

export function nextOrder(entries: readonly McpCatalogEntry[], category: string): number {
  const orders = entries.filter((entry) => entry.category === category).map((entry) => entry.order);
  return orders.length === 0 ? ORDER_STEP : Math.max(...orders) + ORDER_STEP;
}

function titleCase(slug: string): string {
  return slug
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/** A YAML double-quoted scalar; JSON string escaping is a valid subset. */
function q(value: string): string {
  return JSON.stringify(value);
}

interface Copy {
  readonly titleEn: string;
  readonly titleZh: string;
  readonly descriptionEn: string;
  readonly descriptionZh: string;
  readonly website: string;
}

/** Use what the operator supplied or the probe found, and record each guess as a review item. */
function resolveCopy(input: ScaffoldInput, id: string, todos: string[]): Copy {
  const info = input.probe.serverInfo;
  const guess = (supplied: string | undefined, fallback: string, note: string): string => {
    if (supplied === undefined) todos.push(note);
    return supplied ?? fallback;
  };
  const probedTitle = input.titleEn ?? info?.title ?? info?.name;
  const titleEn = probedTitle ?? titleCase(id);
  if (probedTitle === undefined) todos.push("title: derived from the id, confirm the brand name");
  const titleZh = guess(input.titleZh, titleEn, "title.zh: copied from en, translate if the brand has a Chinese name");
  const host = new URL(input.url);
  return {
    titleEn,
    titleZh,
    descriptionEn: guess(
      input.descriptionEn,
      `Use ${titleEn} from your agent.`,
      "description.en: placeholder, write one short sentence",
    ),
    descriptionZh: guess(
      input.descriptionZh,
      `在智能体中使用 ${titleZh}。`,
      "description.zh: placeholder, write one short sentence",
    ),
    website: guess(
      input.website,
      `${host.protocol}//${host.hostname.replace(/^(mcp|api)\./, "")}`,
      "website: derived from the endpoint host, point it at the provider's site",
    ),
  };
}

function resolveCategory(input: ScaffoldInput, categories: readonly McpCatalogCategory[], todos: string[]): string {
  const ids = categories.map((category) => category.id);
  const category = input.category ?? (ids.includes("general") ? "general" : undefined);
  if (category === undefined || !ids.includes(category))
    throw new Error(`pass --category with one of: ${ids.join(", ")}`);
  if (input.category === undefined) todos.push("category: defaulted to general, confirm it fits");
  return category;
}

function probeComments(probe: ScaffoldInput["probe"]): string[] {
  const info = probe.serverInfo;
  const tools = probe.toolNames;
  return [
    `# Probed ${new Date().toISOString().slice(0, 10)}: ${probe.evidence}`,
    ...(info?.name === undefined
      ? []
      : [`# serverInfo: ${info.name}${info.version === undefined ? "" : ` ${info.version}`}`]),
    ...(tools.length === 0
      ? []
      : [`# tools (${tools.length}): ${tools.slice(0, 8).join(", ")}${tools.length > 8 ? ", ..." : ""}`]),
  ];
}

export function scaffoldEntry(
  input: ScaffoldInput,
  entries: readonly McpCatalogEntry[],
  categories: readonly McpCatalogCategory[],
): ScaffoldedEntry {
  const id = input.id ?? deriveId(input.url, input.probe.serverInfo?.name);
  if (!ID_PATTERN.test(id)) throw new Error(`id "${id}" must match ${ID_PATTERN}`);
  if (entries.some((entry) => entry.id === id || entry.name === id)) {
    throw new Error(`catalog already has an entry named "${id}"; pass --id to choose another`);
  }
  if (entries.some((entry) => entry.url === input.url)) throw new Error(`catalog already lists ${input.url}`);

  const todos: string[] = [];
  const category = resolveCategory(input, categories, todos);
  const copy = resolveCopy(input, id, todos);
  const iconFile = `${id}.svg`;
  todos.push(
    `icon: add packages/mcp-presets/icons/${iconFile} (or .png and edit \`icon\`), and record its source in icons/README.md`,
  );

  const lines = [
    ...probeComments(input.probe),
    `- id: ${id}`,
    `  name: ${id}`,
    "  title:",
    `    en: ${q(copy.titleEn)}`,
    `    zh: ${q(copy.titleZh)}`,
    "  description:",
    `    en: ${q(copy.descriptionEn)}`,
    `    zh: ${q(copy.descriptionZh)}`,
    `  url: ${input.url}`,
    `  defaultAuthKind: ${input.authKind ?? input.probe.authKind}`,
    `  category: ${category}`,
    `  website: ${copy.website}`,
    `  icon: ${iconFile}`,
    `  order: ${input.order ?? nextOrder(entries, category)}`,
  ];
  return { id, yaml: `${lines.join("\n")}\n`, iconFile, todos };
}
