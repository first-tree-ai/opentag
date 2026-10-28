import { fireEvent, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { browserApi } from "../../api.js";
import { useMcpOAuthSession } from "./mcp-oauth-session.js";
import { fakeMcpOAuthBrowser } from "./mcp-oauth-test-fixtures.js";
import { useAgentMcpServers } from "./mcp-queries.js";
import { McpServerCard } from "./mcp-server-card.js";
import { AGENT_ID, authorization, entry, OTHER_AGENT_ID, SERVER_ID, stub, wrap } from "./mcp-test-fixtures.js";

afterEach(() => vi.restoreAllMocks());
describe("shared credentials through existing Agent queries", () => {
  it.each(["MCP_OAUTH_DENIED", "MCP_OAUTH_FAILED"])(
    "refreshes both Agent queries after %s without adding a shared presentation",
    async (code) => {
      const server = entry({
        authorization: { ...authorization(), kind: "oauth", status: "pending", hasCredential: false },
      });
      stub([server]);
      vi.spyOn(browserApi, "startMcpOAuth").mockResolvedValue({
        authorizationUrl: "https://provider.test/authorize?state=shared-state",
        expiresAt: "2030-01-01T00:00:00.000Z",
      });
      const browser = fakeMcpOAuthBrowser();
      function Cards() {
        const session = useMcpOAuthSession(AGENT_ID);
        const [outcome, setOutcome] = useState("");
        const a = useAgentMcpServers(AGENT_ID);
        const b = useAgentMcpServers(OTHER_AGENT_ID);
        return (
          <>
            <button
              type="button"
              onClick={() =>
                void session
                  .start({ agentId: AGENT_ID, serverId: SERVER_ID, source: "authorize" })
                  .then(setOutcome, () => setOutcome("failed"))
              }
            >
              Start authorization
            </button>
            <output>{outcome}</output>
            {[
              { id: AGENT_ID, query: a },
              { id: OTHER_AGENT_ID, query: b },
            ].map(({ id, query }) =>
              query.data?.servers[0] ? (
                <McpServerCard
                  key={id}
                  entry={query.data.servers[0]}
                  onAction={vi.fn()}
                  onResume={vi.fn()}
                  resuming={false}
                />
              ) : null,
            )}
          </>
        );
      }
      try {
        wrap(<Cards />);
        await waitFor(() => expect(screen.getAllByRole("button", { name: "Authorize: linear" })).toHaveLength(2));
        fireEvent.click(screen.getByText("Start authorization"));
        await waitFor(() => expect(browser.popup.location.replace).toHaveBeenCalled());
        vi.mocked(browserApi.agentMcpServers)
          .mockClear()
          .mockResolvedValue({
            servers: [
              {
                ...server,
                authorization: {
                  ...authorization(),
                  kind: "oauth",
                  hasCredential: false,
                  status: "error",
                  failureCode: code,
                },
              },
            ],
          });
        browser.send({ mcpServerId: SERVER_ID, outcome: { kind: "error", code } });
        await screen.findByText(code === "MCP_OAUTH_FAILED" ? "failed" : "cancelled");
        await waitFor(() => {
          expect(browserApi.agentMcpServers).toHaveBeenCalledWith(AGENT_ID);
          expect(browserApi.agentMcpServers).toHaveBeenCalledWith(OTHER_AGENT_ID);
        });
        await waitFor(() =>
          expect(
            screen.getAllByRole("button", {
              name: code === "MCP_OAUTH_DENIED" ? "Authorize: linear" : "Reauthorize: linear",
            }),
          ).toHaveLength(2),
        );
        expect(screen.queryByText("Connected")).toBeNull();
      } finally {
        browser.restore();
      }
    },
    20_000,
  );
});
