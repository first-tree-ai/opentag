import type { McpCatalogCategory, McpCatalogEntry } from "../mcp-catalog.gen.js";
import { type McpProbeResult, type ProbeAuthKind, type ProbeSideEffect, safeText } from "./probe.js";

const ORDER_STEP = 10;
const SLUG_PATTERN = /^[a-z][a-z0-9-]*$/;
/** The schema caps the whole registry id at 64 characters, and `mcp/` takes 4 of them. */
const MAX_SLUG_LENGTH = 60;
const MAX_CAPABILITY_LENGTH = 64;
const MAX_CAPABILITIES = 32;
const SIDE_EFFECT_RANK: Record<ProbeSideEffect, number> = { none: 0, write: 1, destructive: 2 };

export interface ScaffoldInput {
  readonly url: string;
  readonly probe: Extract<McpProbeResult, { ok: true }>;
  readonly id?: string;
  readonly category?: string;
  readonly homepage?: string;
  readonly nameEn?: string;
  readonly nameZh?: string;
  readonly summaryEn?: string;
  readonly summaryZh?: string;
  readonly authKind?: ProbeAuthKind;
  readonly order?: number;
}

export interface ScaffoldedEntry {
  /** The slug: the definition name and the icon file's basename. */
  readonly id: string;
  readonly yaml: string;
  readonly iconFile: string;
  /** Fields the operator must review before committing. */
  readonly todos: readonly string[];
}

/** Lowercase, hyphen-separated, starts with a letter, and within the definition-name limit. */
export function slugify(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^[0-9-]+/, "")
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/^-+|-+$/g, "");
}

function stripGenericWords(slug: string): string {
  const stripped = slug.replace(/(^|-)(mcp|server|remote)(?=-|$)/g, "").replace(/^-+|-+$/g, "");
  return stripped.length > 0 ? stripped : slug;
}

/** Derive a slug from the server's own name, falling back to the host's first meaningful label. */
export function deriveId(url: string, serverName: string | undefined): string {
  const fromName = serverName === undefined ? "" : stripGenericWords(slugify(serverName));
  if (SLUG_PATTERN.test(fromName)) return fromName;
  const labels = new URL(url).hostname.split(".").filter((label) => !["www", "mcp", "api", "app"].includes(label));
  return slugify(labels[0] ?? "server") || "server";
}

/** `https://host` and `https://host/` are the same endpoint. */
function normalizeUrl(raw: string): string {
  try {
    return new URL(raw).href;
  } catch {
    return raw;
  }
}

function entryUrls(entry: McpCatalogEntry): string[] {
  const urls = [entry.url, ...(entry.remotes ?? []).map((remote) => remote.url)];
  return urls.filter((url): url is string => url !== undefined).map(normalizeUrl);
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

/** Capability tokens come from tool names: `search_docs` becomes `search-docs`. */
export function capabilitiesFromTools(names: readonly string[]): string[] {
  const tokens = names.map((name) => slugify(name.replace(/[._]/g, "-"))).filter((token) => token.length > 0);
  return [...new Set(tokens)].slice(0, MAX_CAPABILITIES);
}

function strongest(effects: readonly ProbeSideEffect[]): ProbeSideEffect {
  return effects.reduce<ProbeSideEffect>(
    (top, effect) => (SIDE_EFFECT_RANK[effect] > SIDE_EFFECT_RANK[top] ? effect : top),
    "none",
  );
}

interface Copy {
  readonly nameEn: string;
  readonly nameZh: string;
  readonly summaryEn: string;
  readonly summaryZh: string;
  readonly homepage: string;
}

/** Use what the operator supplied or the probe found, and record each guess as a review item. */
function resolveCopy(input: ScaffoldInput, id: string, todos: string[]): Copy {
  const info = input.probe.serverInfo;
  const guess = (supplied: string | undefined, fallback: string, note: string): string => {
    if (supplied === undefined) todos.push(note);
    return supplied ?? fallback;
  };
  const probedName = input.nameEn ?? info?.title ?? info?.name;
  const nameEn = probedName ?? titleCase(id);
  if (probedName === undefined) todos.push("name: derived from the id, confirm the brand name");
  const nameZh = guess(input.nameZh, nameEn, "name.zh: copied from en, translate if the brand has a Chinese name");
  const host = new URL(input.url);
  return {
    nameEn,
    nameZh,
    summaryEn: guess(
      input.summaryEn,
      `Use ${nameEn} from your agent.`,
      "summary.en: placeholder, write one short sentence",
    ),
    summaryZh: guess(
      input.summaryZh,
      `在智能体中使用 ${nameZh}。`,
      "summary.zh: placeholder, write one short sentence",
    ),
    homepage: guess(
      input.homepage,
      `${host.protocol}//${host.hostname.replace(/^(mcp|api)\./, "")}`,
      "homepage: derived from the endpoint host, point it at the provider's site",
    ),
  };
}

function resolveCategory(input: ScaffoldInput, categories: readonly McpCatalogCategory[]): string {
  const ids = categories.map((category) => category.id);
  const category = input.category;
  if (category === undefined || !ids.includes(category)) {
    throw new Error(`pass --category with one of: ${ids.join(", ")}`);
  }
  return category;
}

function probeComments(probe: ScaffoldInput["probe"]): string[] {
  const info = probe.serverInfo;
  const version = info?.version === undefined ? "" : ` ${info.version}`;
  return [
    `# Probed ${new Date().toISOString().slice(0, 10)}: ${probe.evidence}`,
    ...(info?.name === undefined ? [] : [`# serverInfo: ${safeText(`${info.name}${version}`)}`]),
  ];
}

function renderTools(probe: ScaffoldInput["probe"]): string[] {
  if (probe.tools.length === 0) return [];
  return [
    "  tools:",
    ...probe.tools.flatMap((tool) => [
      `    - name: ${q(tool.name)}`,
      ...(tool.description === undefined ? [] : [`      description: ${q(tool.description)}`]),
      `      side_effect: ${tool.sideEffect}`,
    ]),
  ];
}

interface Risk {
  readonly sideEffects: ProbeSideEffect;
  readonly dataAccess: "public" | "private";
}

/** A tool list gives the strongest effect; without a complete one, assume the strongest (`destructive`). */
function resolveRisk(probe: ScaffoldInput["probe"], authKind: ProbeAuthKind, todos: string[]): Risk {
  const known = probe.toolsComplete && probe.tools.length > 0;
  todos.push(
    known
      ? "risk.side_effects: taken from tool annotations (a tool without a hint counts as write); confirm"
      : "risk.side_effects: assumed destructive because the full tool list was not readable; lower it only after checking the provider's docs",
  );
  todos.push("risk.data_access: confirm whether the Server reads only public data");
  return {
    sideEffects: known ? strongest(probe.tools.map((tool) => tool.sideEffect)) : "destructive",
    dataAccess: authKind === "none" ? "public" : "private",
  };
}

function resolveCapabilities(probe: ScaffoldInput["probe"], id: string, todos: string[]): string[] {
  const fromTools = capabilitiesFromTools(probe.tools.map((tool) => tool.name));
  if (fromTools.length > 0) {
    todos.push("capabilities: copied from tool names, group them into a few user-level capabilities");
    return fromTools;
  }
  todos.push("capabilities: placeholder, list what the Server lets an Agent do");
  return [`use-${id}`.slice(0, MAX_CAPABILITY_LENGTH)];
}

export function scaffoldEntry(
  input: ScaffoldInput,
  entries: readonly McpCatalogEntry[],
  categories: readonly McpCatalogCategory[],
): ScaffoldedEntry {
  const id = input.id ?? deriveId(input.url, input.probe.serverInfo?.name);
  if (!SLUG_PATTERN.test(id) || id.length > MAX_SLUG_LENGTH) {
    throw new Error(`id "${id}" must match ${SLUG_PATTERN} and be at most ${MAX_SLUG_LENGTH} characters`);
  }
  if (entries.some((entry) => entry.id === id)) {
    throw new Error(`catalog already has an entry named "${id}"; pass --id to choose another`);
  }
  if (entries.some((entry) => entryUrls(entry).includes(normalizeUrl(input.url)))) {
    throw new Error(`catalog already lists ${input.url}`);
  }

  const todos: string[] = [];
  const category = resolveCategory(input, categories);
  const copy = resolveCopy(input, id, todos);
  const authKind = input.authKind ?? input.probe.authKind;
  if (authKind === "unknown") {
    throw new Error(
      `${input.probe.evidence}; the authorization method is not proven, so pass --auth oauth|bearer|none`,
    );
  }
  const risk = resolveRisk(input.probe, authKind, todos);
  const capabilities = resolveCapabilities(input.probe, id, todos);
  const iconFile = `${id}.svg`;
  todos.push(
    `icon: add packages/mcp-presets/icons/${iconFile} (or .png and edit \`icon\`), and record its source in icons/README.md`,
  );
  todos.push("when_to_use: placeholder, write one sentence that tells an Agent when this Server is the right tool");

  const lines = [
    ...probeComments(input.probe),
    "- schema_version: 1",
    `  id: mcp/${id}`,
    "  kind: mcp",
    "  name:",
    `    en: ${q(copy.nameEn)}`,
    `    zh: ${q(copy.nameZh)}`,
    "  summary:",
    `    en: ${q(copy.summaryEn)}`,
    `    zh: ${q(copy.summaryZh)}`,
    "  when_to_use:",
    `    en: ${q(`Use when the task needs ${copy.nameEn}.`)}`,
    `    zh: ${q(`当任务需要 ${copy.nameZh} 时使用。`)}`,
    `  capabilities: [${capabilities.map(q).join(", ")}]`,
    "  status: active",
    "  auth:",
    `    methods: [${authKind}]`,
    `    default_kind: ${authKind}`,
    ...(authKind === "oauth" ? ["    oauth: {}"] : []),
    "  risk:",
    `    side_effects: ${risk.sideEffects}`,
    `    data_access: ${risk.dataAccess}`,
    ...renderTools(input.probe),
    "  remotes:",
    "    - type: streamable-http",
    `      url: ${q(input.url)}`,
    "  catalog:",
    `    category: ${category}`,
    `    order: ${input.order ?? nextOrder(entries, category)}`,
    `    icon: ${iconFile}`,
    "    icon_is_official: false",
    `  homepage: ${q(copy.homepage)}`,
  ];
  return { id, yaml: `${lines.join("\n")}\n`, iconFile, todos };
}
