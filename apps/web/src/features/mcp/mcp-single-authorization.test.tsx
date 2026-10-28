import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { browserApi } from "../../api.js";
import type { McpOAuthSession } from "./mcp-oauth-session.js";
import { McpPage } from "./mcp-page.js";
import { McpServerCard } from "./mcp-server-card.js";
import {
  AGENT_ID,
  authorization,
  detail,
  entry,
  openDetails,
  openRemove,
  SERVER_ID,
  stub,
  wrap,
} from "./mcp-test-fixtures.js";

afterEach(() => vi.restoreAllMocks());
describe("ordinary OAuth presentation after credential reuse", () => {
  it.each([
    ["ready", {}, null, false],
    ["failed", { probeState: "failed", probeError: "MCP_UPSTREAM_UNAVAILABLE: timeout" }, "Request timed out", true],
    ["pending", { probeState: "pending", toolsCount: null }, "Checking connection…", false],
    ["empty", { toolsCount: 0 }, "No tools available", false],
  ] as const)(
    "preserves the ordinary %s row from Agent-local probe data",
    async (state, patch, label, retry) => {
      const mounted = entry({
        authorization: {
          ...authorization(),
          kind: "oauth",
          ...patch,
        },
        snapshot: state === "pending" ? null : entry().snapshot,
      });
      stub([mounted]);
      wrap(<McpPage agentId={AGENT_ID} />);
      await openDetails();
      const details = screen.getByRole("dialog", { name: "linear" });
      expect(within(details).queryByText("Connected")).toBeNull();
      fireEvent.click(within(details).getByRole("button", { name: "Close linear" }));
      const row = screen.getByRole("button", { name: "linear" }).closest("li") as HTMLElement;
      expect(within(row).queryByText("Connected")).toBeNull();
      if (label) expect(within(row).getByText(label)).toBeTruthy();
      expect(Boolean(within(row).queryByRole("button", { name: "Retry: linear" }))).toBe(retry);
      expect(within(row).queryByRole("button", { name: /Authorize/ })).toBeNull();
    },
    20_000,
  );
  it("keeps Remove disabled while its own OAuth popup is open", async () => {
    wrap(
      <McpServerCard
        entry={entry({ authorization: { ...authorization(), kind: "oauth" } })}
        onAction={vi.fn()}
        onResume={vi.fn()}
        resuming={false}
        oauthSession={{ phase: "waiting" } as McpOAuthSession}
      />,
    );
    await screen.findByText("Waiting for authorization…");
    expect(screen.getByRole("button", { name: "Remove linear" }).hasAttribute("disabled")).toBe(true);
    expect(screen.queryByRole("button", { name: /Authorize|Reauthorize/ })).toBeNull();
  });
  it("keeps original fields and Save when a definition has several Agent mounts", async () => {
    const mounted = entry({
      effective: { ...entry().effective, url: "https://custom.example.test/mcp" },
      authorization: { ...authorization(), kind: "oauth" },
    });
    stub([mounted], detail(3));
    const saved = {
      ...mounted,
      effective: { ...mounted.effective, url: "https://other.example.test/mcp" },
      authorization: null,
    };
    vi.spyOn(browserApi, "updateAgentMcpServer").mockResolvedValue(saved);
    wrap(<McpPage agentId={AGENT_ID} />);
    await openDetails();
    const dialog = screen.getByRole("dialog", { name: "linear" });
    const address = within(dialog).getByRole("textbox", { name: "Connector address" });
    expect(address.hasAttribute("disabled")).toBe(false);
    expect(
      within(dialog)
        .getAllByRole("radio")
        .every((radio) => !radio.hasAttribute("disabled")),
    ).toBe(true);
    expect(within(dialog).queryByText("Connected")).toBeNull();
    expect(within(dialog).queryByRole("region", { name: "Tools" })).toBeNull();
    fireEvent.change(address, { target: { value: saved.effective.url } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(browserApi.updateAgentMcpServer).toHaveBeenCalledWith(AGENT_ID, SERVER_ID, { url: saved.effective.url }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "linear" })).toBeNull());
  });
  it("keeps the original current-Agent removal confirmation for multiple mounts", async () => {
    stub([entry({ authorization: { ...authorization(), kind: "oauth" } })], detail(3));
    const detach = vi.spyOn(browserApi, "detachMcpServer").mockResolvedValue(undefined);
    wrap(<McpPage agentId={AGENT_ID} />);
    await openRemove();
    const dialog = screen.getByRole("alertdialog");
    expect(
      within(dialog)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Cancel", "Remove"]);
    expect(
      within(dialog).getByText("This Agent will no longer be able to use linear. You can add it again at any time."),
    ).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(detach).toHaveBeenCalledWith(AGENT_ID, SERVER_ID));
    expect(detach).toHaveBeenCalledTimes(1);
  });
});
