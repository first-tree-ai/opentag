import {
  type MCPAgentServer,
  type MCPAuthKind,
  MCPAuthSchemeSchema,
  MCPCustomAuthHeaderSchema,
  type MCPEffectiveConfig,
  MCPExtraHeadersSchema,
  type UpdateMCPBindingRequest,
} from "@opentag/shared/browser";
import { ApiError } from "../../api.js";

export type HeaderRow = { id: string; name: string; value: string };
let nextHeader = 0;
export const newHeader = (): HeaderRow => ({ id: `mcp-header-${nextHeader++}`, name: "", value: "" });
export const headerRows = (headers: Record<string, string>): HeaderRow[] =>
  Object.entries(headers).map(([name, value]) => ({ ...newHeader(), name, value }));
export const headersFromRows = (rows: HeaderRow[]): Record<string, string> =>
  Object.fromEntries(rows.filter((row) => row.name.trim()).map((row) => [row.name.trim().toLowerCase(), row.value]));
export const headersKey = (headers: Record<string, string>): string =>
  JSON.stringify(Object.entries(headers).sort(([a], [b]) => a.localeCompare(b)));
export function validHeaders(rows: HeaderRow[], authHeader: string): boolean {
  const nonempty = rows.filter((row) => row.name.trim() || row.value);
  const names = nonempty.map((row) => row.name.trim().toLowerCase());
  return (
    names.every((name) => name && name !== authHeader.trim().toLowerCase()) &&
    new Set(names).size === names.length &&
    MCPExtraHeadersSchema.safeParse(headersFromRows(nonempty)).success
  );
}
/** The name an MCP URL suggests, ignoring every name already in use. Empty when the URL has no host. */
export function serverNameFromUrl(url: string): string {
  try {
    const parts = new URL(url).hostname.toLowerCase().split(".");
    const filteredParts = parts.filter((part) => !["www", "mcp"].includes(part));
    const host = filteredParts.slice(0, -1).join("-") || filteredParts[0] || "server";
    return (
      host
        .replace(/[^a-z0-9-]/g, "-")
        .replace(/^-+/, "")
        .slice(0, 58) || "server"
    );
  } catch {
    return "";
  }
}
export function suggestServerName(url: string, servers: readonly { name: string }[]): string {
  const base = serverNameFromUrl(url);
  if (!base) return "";
  let name = base;
  for (let suffix = 2; servers.some((server) => server.name === name); suffix++) name = `${base}-${suffix}`;
  return name;
}
export const actionError = (error: unknown, fallback: string): string =>
  error instanceof ApiError ? error.message : fallback;
export const defaultConnection: MCPEffectiveConfig = {
  url: "",
  authHeader: "authorization",
  authScheme: "Bearer",
  extraHeaders: {},
};
export type AuthDraft = {
  kind: MCPAuthKind;
  token: string;
  authHeader: string;
  authScheme: string;
  headers: HeaderRow[];
};
export function authDraft(config: MCPEffectiveConfig = defaultConnection, kind: MCPAuthKind = "oauth"): AuthDraft {
  return {
    kind,
    token: "",
    authHeader: config.authHeader,
    authScheme: config.authScheme,
    headers: headerRows(config.extraHeaders),
  };
}
export type ConnectionField = "url" | "authHeader" | "authScheme";
export type SettingsDraft = Pick<MCPEffectiveConfig, ConnectionField> & { headers: HeaderRow[] };
export function settingsDraft(entry: MCPAgentServer): SettingsDraft {
  return { ...entry.effective, headers: headerRows(entry.effective.extraHeaders) };
}
/** Follow confirmed writes without losing fields the user is still editing in Settings. */
export function rebaseSettingsDraft(
  previous: MCPAgentServer,
  draft: SettingsDraft,
  next: MCPAgentServer,
): SettingsDraft {
  const previousHeaders = Object.entries(previous.effective.extraHeaders);
  const headersEdited =
    draft.headers.length !== previousHeaders.length ||
    draft.headers.some(
      (row, index) => row.name !== previousHeaders[index]?.[0] || row.value !== previousHeaders[index]?.[1],
    );
  const fresh = settingsDraft(next);
  return {
    ...fresh,
    url: draft.url !== previous.effective.url ? draft.url : fresh.url,
    authHeader: draft.authHeader !== previous.effective.authHeader ? draft.authHeader : fresh.authHeader,
    authScheme: draft.authScheme !== previous.effective.authScheme ? draft.authScheme : fresh.authScheme,
    headers: headersEdited ? draft.headers : fresh.headers,
  };
}
export function bindingPatch(entry: MCPAgentServer, draft: SettingsDraft): UpdateMCPBindingRequest {
  const headers = headersFromRows(draft.headers);
  const patch: UpdateMCPBindingRequest =
    headersKey(headers) !== headersKey(entry.effective.extraHeaders) ? { extraHeaders: headers } : {};
  for (const field of ["url", "authHeader", "authScheme"] as const) {
    if (draft[field] !== entry.effective[field]) patch[field] = draft[field];
  }
  return patch;
}

export function validTokenSettings(draft: { authHeader: string; authScheme: string }) {
  return (
    MCPCustomAuthHeaderSchema.safeParse(draft.authHeader).success &&
    MCPAuthSchemeSchema.safeParse(draft.authScheme).success
  );
}
