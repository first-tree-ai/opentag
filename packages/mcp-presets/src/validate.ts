import { CreateMCPServerRequestSchema } from "@opentag/shared/browser";
import type { McpCatalogCategory, McpCatalogEntry } from "./mcp-catalog.gen.js";

/** The bounds `StartMCPOAuthRequestSchema` enforces on the start request's `scopes`. */
const MAX_OAUTH_SCOPES = 64;
const MAX_OAUTH_SCOPE_LENGTH = 255;
const ID_PATTERN = /^[a-z][a-z0-9-]*$/;
const LOCALES = ["en", "zh"] as const;

export interface McpCatalogViolation {
  /** The entry id, the category id, or `catalog` for a cross-entry rule. */
  readonly subject: string;
  readonly field: string;
  readonly message: string;
}

function isHttpUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

function checkLocalized(
  text: Readonly<Record<string, string>>,
  subject: string,
  field: string,
  out: McpCatalogViolation[],
): void {
  for (const locale of LOCALES) {
    if (typeof text[locale] !== "string" || text[locale].trim().length === 0) {
      out.push({ subject, field: `${field}.${locale}`, message: "must be a non-empty string" });
    }
  }
}

function checkOAuthScopes(entry: McpCatalogEntry, out: McpCatalogViolation[]): void {
  const subject = entry.id;
  const scopes = entry.oauthScopes;
  if (scopes === undefined) return;
  if (scopes.length === 0 || scopes.length > MAX_OAUTH_SCOPES) {
    out.push({ subject, field: "oauthScopes", message: `must hold 1 to ${MAX_OAUTH_SCOPES} scopes` });
  }
  for (const [index, scope] of scopes.entries()) {
    if (scope.trim().length === 0 || scope.length > MAX_OAUTH_SCOPE_LENGTH) {
      out.push({
        subject,
        field: `oauthScopes[${index}]`,
        message: `must be 1 to ${MAX_OAUTH_SCOPE_LENGTH} characters`,
      });
    }
  }
}

/**
 * The create payload the add flow sends, including the optional header fields, so the full Server
 * schema decides header names and the auth-header collision rule. A non-installable entry carries no
 * connection fields at all.
 */
function checkCreatePayload(entry: McpCatalogEntry, out: McpCatalogViolation[]): void {
  const subject = entry.id;
  if (!entry.installable) {
    for (const field of ["url", "defaultAuthKind", "authHeader", "authScheme", "extraHeaders"] as const) {
      if (entry[field] !== undefined) {
        out.push({ subject, field, message: "must be absent when the entry is not installable" });
      }
    }
    return;
  }
  const create = CreateMCPServerRequestSchema.safeParse({
    name: entry.name,
    url: entry.url,
    defaultAuthKind: entry.defaultAuthKind,
    ...(entry.authHeader === undefined ? {} : { authHeader: entry.authHeader }),
    ...(entry.authScheme === undefined ? {} : { authScheme: entry.authScheme }),
    ...(entry.extraHeaders === undefined ? {} : { extraHeaders: entry.extraHeaders }),
  });
  if (create.success) return;
  for (const issue of create.error.issues) {
    out.push({ subject, field: issue.path.join(".") || "entry", message: issue.message });
  }
}

/**
 * Validate one entry against the same create schema the Server enforces, plus the card fields the
 * catalog owns. Pure and browser-safe; the outbound-address policy is Node-only and is checked by
 * the generator and the test suite.
 */
export function validateMcpCatalogEntry(
  entry: McpCatalogEntry,
  categoryIds: ReadonlySet<string>,
): McpCatalogViolation[] {
  const out: McpCatalogViolation[] = [];
  const subject = entry.id;
  if (!ID_PATTERN.test(entry.id)) out.push({ subject, field: "id", message: `must match ${ID_PATTERN}` });

  checkCreatePayload(entry, out);

  if (!categoryIds.has(entry.category)) {
    out.push({ subject, field: "category", message: `"${entry.category}" is not a declared category` });
  }
  if (!isHttpUrl(entry.website)) out.push({ subject, field: "website", message: "must be an absolute http(s) URL" });
  if (!/^data:image\/(?:svg\+xml|png);base64,/.test(entry.iconUrl)) {
    out.push({ subject, field: "iconUrl", message: "must be an embedded svg or png data URL" });
  }
  if (!Number.isInteger(entry.order) || entry.order < 0) {
    out.push({ subject, field: "order", message: "must be a non-negative integer" });
  }
  checkLocalized(entry.title, subject, "title", out);
  checkLocalized(entry.description, subject, "description", out);

  checkOAuthScopes(entry, out);
  return out;
}

/** Validate every category and entry, and the uniqueness rules that span entries. */
export function validateMcpCatalog(
  categories: readonly McpCatalogCategory[],
  entries: readonly McpCatalogEntry[],
): McpCatalogViolation[] {
  const out: McpCatalogViolation[] = [];
  const categoryIds = new Set<string>();
  for (const category of categories) {
    if (categoryIds.has(category.id)) {
      out.push({ subject: category.id, field: "id", message: "duplicate category id" });
    }
    categoryIds.add(category.id);
    checkLocalized(category.label, category.id, "label", out);
  }

  const ids = new Set<string>();
  const names = new Set<string>();
  const orderSlots = new Set<string>();
  for (const entry of entries) {
    if (ids.has(entry.id)) out.push({ subject: entry.id, field: "id", message: "duplicate entry id" });
    ids.add(entry.id);
    if (names.has(entry.name)) out.push({ subject: entry.id, field: "name", message: "duplicate definition name" });
    names.add(entry.name);
    const slot = `${entry.category}:${entry.order}`;
    if (orderSlots.has(slot)) {
      out.push({ subject: entry.id, field: "order", message: `duplicate order ${entry.order} in ${entry.category}` });
    }
    orderSlots.add(slot);
    out.push(...validateMcpCatalogEntry(entry, categoryIds));
  }
  return out;
}
