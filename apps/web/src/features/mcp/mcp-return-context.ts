/** Only non-secret view state survives the same-tab OAuth round trip. */
export type McpReturnContext = {
  agentId: string;
  serverId: string;
  source: "edit" | "tools" | "authorize" | "add" | "discover";
  query?: string;
  scrollTop?: number;
  categoryId?: string;
  newBinding?: boolean;
};
const KEY = "opentag:mcp:oauth-return";
const MAX_AGE = 30 * 60 * 1000;
export function rememberMcpReturn(context: McpReturnContext): void {
  try {
    window.sessionStorage.setItem(
      KEY,
      JSON.stringify({
        agentId: context.agentId,
        serverId: context.serverId,
        source: context.source,
        query: context.query?.slice(0, 1000),
        scrollTop: context.scrollTop,
        categoryId: context.categoryId,
        newBinding: context.newBinding,
        savedAt: Date.now(),
      }),
    );
  } catch {
    // Browsers can deny storage. OAuth still works and returns to the server list.
    console.warn("Could not preserve the MCP view for the authorization return.");
  }
}
export function consumeMcpReturn(agentId: string, serverId?: string): McpReturnContext | undefined {
  try {
    const stored = window.sessionStorage.getItem(KEY);
    if (!stored) return undefined;
    const value: unknown = JSON.parse(stored);
    window.sessionStorage.removeItem(KEY);
    if (!value || typeof value !== "object") return undefined;
    const item = value as Record<string, unknown>;
    if (
      item.agentId !== agentId ||
      item.serverId !== serverId ||
      !serverId ||
      typeof item.savedAt !== "number" ||
      Date.now() - item.savedAt > MAX_AGE ||
      item.savedAt > Date.now() ||
      !["edit", "tools", "authorize", "add", "discover"].includes(String(item.source))
    )
      return undefined;
    return {
      agentId,
      serverId,
      source: item.source as McpReturnContext["source"],
      ...(typeof item.categoryId === "string" ? { categoryId: item.categoryId.slice(0, 100) } : {}),
      ...(item.newBinding === true ? { newBinding: true } : {}),
      ...(typeof item.query === "string" ? { query: item.query.slice(0, 1000) } : {}),
      ...(typeof item.scrollTop === "number" && Number.isFinite(item.scrollTop) && item.scrollTop >= 0
        ? { scrollTop: item.scrollTop }
        : {}),
    };
  } catch {
    console.warn("Could not restore the MCP view after authorization.");
    return undefined;
  }
}

/** A browser Back from a provider without a callback still restores a pending Discover journey. */
export function consumePendingMcpSetupReturn(agentId: string): McpReturnContext | undefined {
  try {
    const stored = window.sessionStorage.getItem(KEY);
    if (!stored) return undefined;
    const item = JSON.parse(stored) as Partial<McpReturnContext>;
    if (item.source !== "discover" && item.source !== "add") return undefined;
    return consumeMcpReturn(agentId, item.serverId);
  } catch {
    console.warn("Could not restore the pending MCP discovery view.");
    return undefined;
  }
}
