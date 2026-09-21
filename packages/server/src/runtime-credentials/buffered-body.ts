import type { RuntimeCredentialProvider } from "@opentag/shared";
import type { ProviderOperationBody } from "./operation-registry.js";
import { RuntimeProxyError } from "./provider-proxy-support.js";

/**
 * Content-type selection for Slack buffered operations. The official Slack CLI sends native
 * `application/x-www-form-urlencoded` bodies by default and JSON only when explicitly asked, so
 * a registered JSON/form operation accepts either; anything else (multipart, text, ...) is
 * rejected before any body is buffered.
 */
export type SlackBufferedBodyKind = "form" | "json" | "unsupported";

export function slackBufferedBodyKind(contentType: string | undefined): SlackBufferedBodyKind {
  const [rawMediaType] = (contentType ?? "").split(";", 1);
  const mediaType = rawMediaType?.trim().toLowerCase() ?? "";
  if (mediaType.length === 0 || mediaType === "application/json" || mediaType.endsWith("+json")) return "json";
  if (mediaType === "application/x-www-form-urlencoded") return "form";
  return "unsupported";
}

/** Query string of an already-normalized proxy path. */
export function requestQuery(path: string): URLSearchParams {
  return new URLSearchParams(path.includes("?") ? (path.split("?", 2)[1] ?? "") : "");
}

export interface DecodedSlackFormBody {
  /** Native form bytes with every `token` field removed; all other bytes are preserved. */
  bytes: Uint8Array;
  /** Decoded string fields (never type-inferred — the Slack form API interprets parameters). */
  parsed: Record<string, string>;
}

/**
 * Decode one bounded Slack urlencoded form. Every duplicate field is rejected as ambiguous
 * (resource and credential keys included), malformed percent-encoding fails closed, and the
 * caller's local `token` field is stripped while the remaining native encoding is preserved.
 */
export function decodeSlackFormBody(bytes: Uint8Array): DecodedSlackFormBody {
  const segments = new TextDecoder().decode(bytes).split("&");
  const seen = new Set<string>();
  const kept: string[] = [];
  const parsed: Record<string, string> = {};
  for (const segment of segments) {
    if (segment.length === 0) continue;
    const separator = segment.indexOf("=");
    const rawKey = separator < 0 ? segment : segment.slice(0, separator);
    const rawValue = separator < 0 ? "" : segment.slice(separator + 1);
    const key = decodeSlackFormPart(rawKey);
    if (seen.has(key)) throw new RuntimeProxyError("body_invalid", "Duplicate Slack form field");
    seen.add(key);
    if (key === "token") continue;
    parsed[key] = decodeSlackFormPart(rawValue);
    kept.push(segment);
  }
  return { bytes: new TextEncoder().encode(kept.join("&")), parsed };
}

function decodeSlackFormPart(value: string): string {
  try {
    return decodeURIComponent(value.replaceAll("+", " "));
  } catch {
    throw new RuntimeProxyError("body_invalid", "Invalid Slack form encoding");
  }
}

/** Form/JSON fields that select the authoritative Slack resource for the operation policy. */
const SLACK_RESOURCE_FIELDS = ["bot", "channel", "channel_id", "file", "filename", "user", "users"] as const;

/**
 * Query/body resource integrity: a query credential is refused outright, duplicate query
 * resource fields are ambiguous, and a body field that disagrees with the same query field is
 * rejected before anything is forwarded. The query itself is otherwise forwarded verbatim.
 */
export function assertSlackQueryResourceIntegrity(parsed: unknown, query: URLSearchParams): void {
  if (query.has("token")) throw new RuntimeProxyError("body_invalid", "Slack query credentials are not accepted");
  const record =
    parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  for (const field of SLACK_RESOURCE_FIELDS) {
    const values = query.getAll(field);
    if (values.length > 1) throw new RuntimeProxyError("body_invalid", "Duplicate Slack query field");
    const fromQuery = values[0];
    if (fromQuery === undefined) continue;
    const fromBody = record[field];
    if (typeof fromBody === "string" && fromBody !== fromQuery) {
      throw new RuntimeProxyError("body_invalid", "Conflicting Slack resource field");
    }
  }
}

/**
 * Decode one bounded buffered body. Slack JSON/form operations follow the actual Content-Type:
 * native urlencoded forms are decoded as forms (token stripped, duplicates rejected, query
 * integrity enforced) while JSON bodies keep JSON semantics. Other providers keep their declared
 * body kind unchanged, and multipart/file streams never reach this function.
 */
export function decodeBufferedBody(input: {
  bytes: Uint8Array;
  operationBody: ProviderOperationBody;
  path: string;
  provider: RuntimeCredentialProvider;
  slackKind: SlackBufferedBodyKind | undefined;
}): { bytes: Uint8Array; parsed: unknown } {
  const { bytes, operationBody, path, provider, slackKind } = input;
  if (slackKind === "form") {
    const form = decodeSlackFormBody(bytes);
    assertSlackQueryResourceIntegrity(form.parsed, requestQuery(path));
    return form;
  }
  if (slackKind === "json" || operationBody === "json") {
    const parsed = bytes.byteLength === 0 ? {} : JSON.parse(new TextDecoder().decode(bytes));
    if (provider === "slack") {
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        delete (parsed as Record<string, unknown>).token;
      }
      assertSlackQueryResourceIntegrity(parsed, requestQuery(path));
    }
    return { bytes: new TextEncoder().encode(JSON.stringify(parsed)), parsed };
  }
  const form = new URLSearchParams(new TextDecoder().decode(bytes));
  form.delete("token");
  return { bytes: new TextEncoder().encode(form.toString()), parsed: Object.fromEntries(form.entries()) };
}
