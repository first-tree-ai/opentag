import {
  MCPAuthSchemeSchema,
  MCPCustomAuthHeaderSchema,
  MCPExtraHeadersSchema,
  MCPServerNameSchema,
  MCPServerUrlSchema,
} from "@opentag/shared/browser";
import { SENSITIVE_NAME_PATTERN } from "../../observability/sensitive-names.js";
import { serverNameFromUrl } from "./mcp-form-model.js";
import { type HeaderPair, type RawEntry, readEntries } from "./mcp-import-readers.js";

/**
 * Turning a pasted MCP configuration into something the Add server dialog can import.
 *
 * This module is the meaning half of the import: which entries are remote, what they are called, and
 * which of their headers is a credential rather than shared configuration. The paste is read by
 * `./mcp-import-readers.ts`, in the browser, and never uploaded as text: only the resulting
 * definition values are sent, plus the credential as this Agent's own authorization.
 *
 * Nothing here logs, echoes, or interpolates a detected token — it lives on
 * `MCPImportServer.credential`, which only the dialog's authorization step consumes. The shapes this
 * accepts and the reasons an entry can be refused are documented in
 * `docs/design/mcp-server-integration.md`.
 */

/** The paste bound, in UTF-8 bytes, applied before any parser runs. */
export const MCP_IMPORT_MAX_PASTE_BYTES = 64 * 1024;

/**
 * The closed set of things a paste can be. They stay separate so the dialog can tell "this is not a
 * config at all" apart from "this config has no remote server", which a single error would conflate.
 */
export type MCPImportOutcomeKind =
  | "parsed"
  | "unsupported-only"
  | "invalid-url"
  | "no-servers"
  | "unparseable"
  | "too-large";

export type MCPImportCredential = {
  /** The header the credential travels in, lowercased; `authorization` unless the paste said otherwise. */
  header: string;
  /** The prefix sent before the token. Empty means the stored secret is sent verbatim. */
  scheme: string;
  token: string;
};

/** Why an entry cannot be imported. Remote entries carry `invalid-url`; the rest are local or unknown. */
export type MCPImportReason = "local-transport" | "unrecognized" | "invalid-url";

export type MCPImportServer = {
  /** The key or CLI name exactly as the paste spelled it, for messages that quote the paste. */
  sourceName: string;
  /** A valid, Account-unique name the user can still edit before confirming. */
  name: string;
  transport: "remote" | "local" | "unrecognized";
  /** Remote entries only: the URL as pasted, validated when `reason` is absent. */
  url?: string;
  /** Non-secret headers to prefill as extra headers, already lowercased and schema-checked. */
  extraHeaders: Record<string, string>;
  /** Header names the paste carried that OpenTag will not store, named so the dialog can report them. */
  refusedHeaders: string[];
  /** An importable remote entry only: the credential found in the paste, for this Agent alone. */
  credential?: MCPImportCredential;
  reason?: MCPImportReason;
};

export type MCPImportOutcome = { kind: MCPImportOutcomeKind; servers: MCPImportServer[] };

export type MCPImportInput = {
  text: string;
  /** Names already used in the Account, so a derived name cannot collide with one of them. */
  takenNames?: readonly string[];
};

export async function parseMcpImport(input: MCPImportInput): Promise<MCPImportOutcome> {
  const text = input.text.trim();
  if (byteLength(text) > MCP_IMPORT_MAX_PASTE_BYTES) return { kind: "too-large", servers: [] };
  if (!text) return { kind: "unparseable", servers: [] };
  const entries = await readEntries(text);
  if (!entries) return { kind: "unparseable", servers: [] };
  return outcomeOf(entries, new Set(input.takenNames ?? []));
}

/** UTF-8 byte length, matching how the shared MCP schemas bound text and without a Node global. */
function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function outcomeOf(entries: RawEntry[], taken: Set<string>): MCPImportOutcome {
  const servers = entries.map((entry) => toServer(entry, taken));
  return { kind: outcomeKind(servers), servers };
}

function outcomeKind(servers: MCPImportServer[]): MCPImportOutcomeKind {
  if (servers.some(isImportable)) return "parsed";
  if (!servers.length) return "no-servers";
  if (servers.some((server) => server.reason === "local-transport" || server.reason === "unrecognized"))
    return "unsupported-only";
  return "invalid-url";
}

export function isImportable(server: MCPImportServer): boolean {
  return server.transport === "remote" && server.reason === undefined && server.url !== undefined;
}

function toServer(entry: RawEntry, taken: Set<string>): MCPImportServer {
  const { extraHeaders, refusedHeaders, credential } = splitHeaders(entry.headers);
  const base = { sourceName: entry.sourceName, transport: entry.transport, extraHeaders, refusedHeaders };
  if (entry.transport === "local")
    return { ...base, name: displayedName(entry, taken, false), reason: "local-transport" };
  if (entry.transport === "unrecognized")
    return { ...base, name: displayedName(entry, taken, false), reason: "unrecognized" };
  const url = entry.url ?? "";
  if (!MCPServerUrlSchema.safeParse(url).success)
    return { ...base, name: displayedName(entry, taken, false), url: displayableUrl(url), reason: "invalid-url" };
  return { ...base, name: displayedName(entry, taken, true), url, ...(credential === undefined ? {} : { credential }) };
}

/**
 * A URL as it may be stored and rendered.
 *
 * A rejected URL is still shown — it is why the entry cannot be imported — but one carrying userinfo
 * would otherwise put a credential on screen and into the result the caller holds, which is exactly
 * the boundary the rest of this module keeps. The raw value is what gets validated; only the copy that
 * outlives the parse is stripped.
 */
function displayableUrl(raw: string): string {
  try {
    const url = new URL(raw);
    if (!url.username && !url.password) return raw;
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    // Not parseable as a URL at all, so there is no userinfo to remove by structure; strip the
    // authority prefix syntactically, which is the only place a credential can sit. A protocol-relative
    // paste (`//user:key@host/mcp`) carries no scheme and is covered by the same expression.
    return raw.replace(/^([a-z][a-z0-9+.-]*:)?\/\/[^/@]*@/i, "$1//");
  }
}

/**
 * The name to propose, derived from the paste's own key so it reads like what the user pasted.
 * Only an importable entry claims a name; a refused entry must not make a later one collide.
 */
function displayedName(entry: RawEntry, taken: Set<string>, claim: boolean): string {
  const derived = normalizeImportName(entry.sourceName) || (entry.url ? serverNameFromUrl(entry.url) : "");
  const valid = MCPServerNameSchema.safeParse(derived).success ? derived : "server";
  if (!claim) return valid;
  if (!taken.has(valid)) {
    taken.add(valid);
    return valid;
  }
  for (let suffix = 2; ; suffix++) {
    const tail = `-${suffix}`;
    const candidate = `${valid.slice(0, 64 - tail.length).replace(/-+$/, "")}${tail}`;
    if (!taken.has(candidate)) {
      taken.add(candidate);
      return candidate;
    }
  }
}

/** Dialect keys are not OpenTag names: `remote_search`, `My Server`, and `Nevent` all normalize here. */
export function normalizeImportName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+/, "")
    .slice(0, 64)
    .replace(/-+$/, "");
}

/**
 * Whether a header name carries a credential rather than configuration.
 *
 * The vocabulary is the diagnostic redactor's (`../../observability/sensitive-names.js`), not a list
 * invented here: a name the product already treats as a secret must not become this Account-shared
 * record just because a paste spelled it `X-Client-Secret`. A vendor prefix is allowed
 * (`x-goog-api-key`), and `authorization` with the cookie headers are credentials of their own.
 * Everything else is context the Server is configured with, such as `x-workspace-id`.
 */
const SENSITIVE_HEADER_NAME = new RegExp(`^(?:[a-z0-9]+-)*(?:${SENSITIVE_NAME_PATTERN}|authorization|cookie)$`);

export function isSensitiveHeaderName(name: string): boolean {
  return SENSITIVE_HEADER_NAME.test(name.trim().toLowerCase().replace(/_/g, "-"));
}

/**
 * Partition the paste's headers into this Agent's credential, the shared definition's extra headers,
 * and names OpenTag refuses.
 *
 * A refused name is reported rather than dropped in silence, and a second credential-shaped header is
 * refused rather than stored: extra headers are shared by every Agent of the Account, so a secret
 * must never reach them. A non-secret header that is neither (`x-workspace-id`) is shared as usual.
 */
function splitHeaders(pairs: HeaderPair[]): {
  extraHeaders: Record<string, string>;
  refusedHeaders: string[];
  credential?: MCPImportCredential;
} {
  const extraHeaders: Record<string, string> = {};
  const refusedHeaders: string[] = [];
  let credential: MCPImportCredential | undefined;
  for (const pair of pairs) {
    const name = pair.name.trim().toLowerCase();
    if (!name) continue;
    if (isSensitiveHeaderName(name)) {
      const found = credential === undefined ? credentialFrom(name, pair.value) : undefined;
      if (found) credential = found;
      else refusedHeaders.push(name);
      continue;
    }
    if (!acceptsHeader(extraHeaders, name, pair.value)) {
      refusedHeaders.push(name);
      continue;
    }
    extraHeaders[name] = pair.value;
  }
  return { extraHeaders, refusedHeaders, ...(credential === undefined ? {} : { credential }) };
}

/**
 * Whether one more header can join the shared set.
 *
 * The shared schema bounds the *accumulated* record — the header count and the serialized size — as
 * well as each value, so sixteen individually acceptable headers can still cross the aggregate bound.
 * Testing the prospective record here turns that into a named refusal at import time instead of a
 * submit button that stays disabled two steps later.
 */
function acceptsHeader(extraHeaders: Record<string, string>, name: string, value: string): boolean {
  return MCPExtraHeadersSchema.safeParse({ ...extraHeaders, [name]: value }).success;
}

function credentialFrom(name: string, value: string): MCPImportCredential | undefined {
  const trimmed = value.trim();
  if (!trimmed || !MCPCustomAuthHeaderSchema.safeParse(name).success) return undefined;
  // Only `authorization` carries a scheme. Every other credential header is sent verbatim, so a
  // space in its value is part of the secret rather than a scheme separator.
  if (name !== "authorization") return { header: name, scheme: "", token: trimmed };
  const parts = /^(\S+)\s+(.+)$/.exec(trimmed);
  if (!parts) return { header: name, scheme: "", token: trimmed };
  const scheme = (parts[1] ?? "").trim();
  const token = (parts[2] ?? "").trim();
  if (!token) return undefined;
  return { header: name, scheme: MCPAuthSchemeSchema.safeParse(scheme).success ? scheme : "", token };
}
