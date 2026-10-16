import { afterEach, describe, expect, it, vi } from "vitest";
import { consumeMcpReturn, consumePendingMcpSetupReturn, rememberMcpReturn } from "./mcp-return-context.js";
import { AGENT_ID, SERVER_ID } from "./mcp-test-fixtures.js";

afterEach(() => {
  window.sessionStorage.clear();
  vi.restoreAllMocks();
});
describe("MCP OAuth return view", () => {
  it("restores bounded view state once without storing arbitrary fields", () => {
    const view = {
      agentId: AGENT_ID,
      serverId: SERVER_ID,
      source: "tools" as const,
      query: "issue",
      scrollTop: 120,
      oauthState: "returned-state",
      token: "must-not-be-stored",
    };
    rememberMcpReturn(view);
    expect(window.sessionStorage.getItem("opentag:mcp:oauth-return")).not.toContain("must-not-be-stored");
    expect(consumeMcpReturn(AGENT_ID, SERVER_ID)).toEqual({
      agentId: AGENT_ID,
      serverId: SERVER_ID,
      source: "tools",
      query: "issue",
      scrollTop: 120,
      oauthState: "returned-state",
    });
    expect(consumeMcpReturn(AGENT_ID, SERVER_ID)).toBeUndefined();
  });
  it("rejects stale state and mismatched callbacks", () => {
    rememberMcpReturn({ agentId: AGENT_ID, serverId: SERVER_ID, source: "edit" });
    expect(consumeMcpReturn(AGENT_ID, "another-server")).toBeUndefined();
    rememberMcpReturn({ agentId: AGENT_ID, serverId: SERVER_ID, source: "edit" });
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 31 * 60 * 1000);
    expect(consumeMcpReturn(AGENT_ID, SERVER_ID)).toBeUndefined();
  });
  it("restores Discover after browser Back without an OAuth callback", () => {
    const view = {
      agentId: AGENT_ID,
      serverId: SERVER_ID,
      source: "discover" as const,
      query: "linear",
      categoryId: "productivity",
      scrollTop: 240,
      newBinding: true,
    };
    rememberMcpReturn(view);
    expect(consumePendingMcpSetupReturn(AGENT_ID)).toEqual(view);
    expect(consumePendingMcpSetupReturn(AGENT_ID)).toBeUndefined();
  });
  it("preserves an existing connection's return view for its callback", () => {
    const view = { agentId: AGENT_ID, serverId: SERVER_ID, source: "tools" as const };
    rememberMcpReturn(view);
    expect(consumePendingMcpSetupReturn(AGENT_ID)).toBeUndefined();
    expect(consumeMcpReturn(AGENT_ID, SERVER_ID)).toEqual(view);
  });
});
