import {
  type MCPAgentServer,
  type MCPAuthKind,
  MCPAuthSchemeSchema,
  MCPCustomAuthHeaderSchema,
  type MCPEffectiveConfig,
  MCPExtraHeadersSchema,
  type MCPServer,
  type UpdateMCPBindingRequest,
} from "@opentag/shared/browser";
import { ApiError } from "../../api.js";

export type HeaderRow = { id: string; name: string; value: string };
export type HeaderMode = "inherit" | "custom" | "none";
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
export function suggestServerName(url: string, servers: MCPServer[]): string {
  try {
    const parts = new URL(url).hostname.toLowerCase().split(".");
    const host =
      parts
        .filter((part) => !["www", "mcp"].includes(part))
        .slice(0, -1)
        .join("-") ||
      parts[0] ||
      "server";
    const base =
      host
        .replace(/[^a-z0-9-]/g, "-")
        .replace(/^-+/, "")
        .slice(0, 58) || "server";
    let name = base;
    for (let suffix = 2; servers.some((server) => server.name === name); suffix++) name = `${base}-${suffix}`;
    return name;
  } catch {
    return "";
  }
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
  headerMode: HeaderMode;
  headers: HeaderRow[];
};
export function authDraft(config: MCPEffectiveConfig = defaultConnection, kind: MCPAuthKind = "oauth"): AuthDraft {
  return {
    kind,
    token: "",
    authHeader: config.authHeader,
    authScheme: config.authScheme,
    headerMode: "inherit",
    headers: headerRows(config.extraHeaders),
  };
}
export function authBindingPatch(draft: AuthDraft, config: MCPEffectiveConfig): UpdateMCPBindingRequest {
  return {
    ...(draft.kind === "bearer" && draft.authHeader !== config.authHeader ? { authHeader: draft.authHeader } : {}),
    ...(draft.kind === "bearer" && draft.authScheme !== config.authScheme ? { authScheme: draft.authScheme } : {}),
    ...(draft.headerMode === "none" ? { emptyExtraHeaders: true } : {}),
    ...(draft.headerMode === "custom" ? { extraHeaders: headersFromRows(draft.headers) } : {}),
  };
}
export type ConnectionField = "url" | "authHeader" | "authScheme";
export type SettingsDraft = Pick<MCPEffectiveConfig, ConnectionField> & {
  headers: HeaderRow[];
  headerMode: HeaderMode;
  cleared: ConnectionField[];
};
export function settingsDraft(entry: MCPAgentServer): SettingsDraft {
  return {
    ...entry.effective,
    headers: headerRows(entry.effective.extraHeaders),
    headerMode: entry.overridden.extraHeaders ? "custom" : "inherit",
    cleared: [],
  };
}
export function bindingPatch(entry: MCPAgentServer, draft: SettingsDraft): UpdateMCPBindingRequest {
  const patch = extraHeadersPatch(entry, draft);
  const clearKeys = { url: "clearUrl", authHeader: "clearAuthHeader", authScheme: "clearAuthScheme" } as const;
  for (const field of ["url", "authHeader", "authScheme"] as const) {
    if (draft.cleared.includes(field)) {
      if (entry.overridden[field]) patch[clearKeys[field]] = true;
    } else if (draft[field] !== entry.effective[field]) patch[field] = draft[field];
  }
  return patch;
}
function extraHeadersPatch(entry: MCPAgentServer, draft: SettingsDraft): UpdateMCPBindingRequest {
  const patch: UpdateMCPBindingRequest = {};
  if (draft.headerMode === "inherit" && entry.overridden.extraHeaders) patch.clearExtraHeaders = true;
  if (
    draft.headerMode === "none" &&
    (!entry.overridden.extraHeaders || Object.keys(entry.effective.extraHeaders).length > 0)
  )
    patch.emptyExtraHeaders = true;
  if (
    draft.headerMode === "custom" &&
    (!entry.overridden.extraHeaders ||
      headersKey(headersFromRows(draft.headers)) !== headersKey(entry.effective.extraHeaders))
  )
    patch.extraHeaders = headersFromRows(draft.headers);
  return patch;
}

export function validTokenSettings(draft: { authHeader: string; authScheme: string }) {
  return (
    MCPCustomAuthHeaderSchema.safeParse(draft.authHeader).success &&
    MCPAuthSchemeSchema.safeParse(draft.authScheme).success
  );
}
