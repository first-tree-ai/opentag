import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, browserApi } from "../../api.js";
import { fakeMcpOAuthBrowser } from "./mcp-oauth-test-fixtures.js";
import { McpPage } from "./mcp-page.js";
import {
  AGENT_ID,
  authorization,
  detail,
  entry,
  newAddress,
  openDetails,
  SERVER_ID,
  stub,
  wrap,
} from "./mcp-test-fixtures.js";

const ready = {
  probeState: "succeeded" as const,
  probeError: null,
  toolsCount: 3,
  toolsTruncated: false,
  protocolEra: "modern" as const,
  protocolVersion: "2026-07-28",
};
afterEach(() => vi.restoreAllMocks());

function customOAuth() {
  stub([]);
  const browser = fakeMcpOAuthBrowser();
  let binding = entry({
    name: "review",
    authorization: null,
    effective: { ...entry().effective, url: "https://review.example.com/mcp", extraHeaders: {} },
  });
  let mounted: ReturnType<typeof entry>[] = [];
  vi.mocked(browserApi.agentMcpServers).mockImplementation(async () => ({ servers: mounted }));
  vi.spyOn(browserApi, "createMcpServer").mockResolvedValue({
    ...detail(0).server,
    name: binding.name,
    url: binding.effective.url,
  });
  vi.spyOn(browserApi, "attachMcpServer").mockImplementation(async () => {
    mounted = [binding];
    return binding;
  });
  const start = vi.spyOn(browserApi, "startMcpOAuth").mockImplementation(async () => {
    binding = {
      ...binding,
      authorization: { ...authorization(), kind: "oauth", status: "pending", hasCredential: false },
    };
    mounted = [binding];
    return {
      authorizationUrl: "https://provider.test/authorize?state=review-state",
      expiresAt: "2026-10-22T23:00:00Z",
    };
  });
  vi.mocked(browserApi.revokeMcpAuthorization).mockImplementation(async () => {
    binding = {
      ...binding,
      authorization: { ...authorization(), kind: "oauth", status: "revoked", hasCredential: false },
    };
    mounted = [binding];
    return binding;
  });
  const detach = vi.spyOn(browserApi, "detachMcpServer").mockImplementation(async () => {
    mounted = [];
  });
  let completeProbe: () => void = () => {};
  const probe = vi.spyOn(browserApi, "probeMcpServer").mockImplementation(
    () =>
      new Promise((resolve) => {
        completeProbe = () => {
          binding = { ...binding, authorization: { ...authorization(), kind: "oauth" } };
          mounted = [binding];
          resolve(ready);
        };
      }),
  );
  return {
    browser,
    start,
    probe,
    detach,
    completeProbe: () => completeProbe(),
    authorize: () => {
      binding = {
        ...binding,
        authorization: { ...authorization(), kind: "oauth", probeState: "pending", probedAt: null },
      };
      mounted = [binding];
      browser.send({ mcpServerId: SERVER_ID, outcome: { kind: "success" } });
    },
  };
}
async function beginCustom() {
  wrap(<McpPage agentId={AGENT_ID} />);
  await newAddress("https://review.example.com/mcp");
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Connect" }));
}
async function closeAdd() {
  fireEvent.click(screen.getByRole("button", { name: "Close Add custom connector" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
}
describe("custom connector setup across dialogs", () => {
  it("does not label a creation failure as an OAuth failure and retains the form for retry", async () => {
    stub([]);
    const browser = fakeMcpOAuthBrowser();
    try {
      vi.spyOn(browserApi, "createMcpServer").mockRejectedValue(new ApiError(503, "Server unavailable"));
      const oauth = vi.spyOn(browserApi, "startMcpOAuth");
      await beginCustom();
      expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Couldn't add connector. Try again.");
      expect(oauth).not.toHaveBeenCalled();
      expect((screen.getByLabelText("Connector address") as HTMLInputElement).value).toBe(
        "https://review.example.com/mcp",
      );
      expect(screen.getByRole("button", { name: "Retry" }).hasAttribute("disabled")).toBe(false);
    } finally {
      browser.restore();
    }
  });
  it("preserves the live authorization after closing setup, then checks the connection without extra controls", async () => {
    const flow = customOAuth();
    try {
      await beginCustom();
      await waitFor(() => expect(flow.browser.popup.location.replace).toHaveBeenCalled());
      await closeAdd();
      expect(await screen.findByText("Waiting for authorization…")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Remove review" }).hasAttribute("disabled")).toBe(true);
      expect(screen.queryByRole("button", { name: /^(Authorize|Reauthorize|Retry|Cancel)(?:: .+)?$/ })).toBeNull();
      await openDetails("review");
      expect(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" })).toBeTruthy();
      expect(within(screen.getByRole("dialog")).queryByRole("button", { name: "Authorize" })).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Close review" }));
      flow.authorize();
      await waitFor(() => expect(flow.probe).toHaveBeenCalledTimes(1));
      expect(await screen.findByText("Checking connection…")).toBeTruthy();
      const row = screen.getByRole("button", { name: "review" }).closest("li") as HTMLElement;
      expect(within(row).getAllByRole("button")).toHaveLength(2);
      expect(within(row).getByRole("button", { name: "Remove review" }).hasAttribute("disabled")).toBe(true);
      flow.completeProbe();
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Remove review" }).hasAttribute("disabled")).toBe(false),
      );
      expect(screen.queryByText("Checking connection…")).toBeNull();
      expect(flow.start).toHaveBeenCalledTimes(1);
    } finally {
      flow.browser.restore();
    }
  });
  it.each([false, true])(
    "can cancel the same setup from management after closing Add (blocked=%s)",
    async (blocked) => {
      const flow = customOAuth();
      if (blocked) flow.browser.open.mockReturnValue(null);
      try {
        await beginCustom();
        await waitFor(() => expect(flow.start).toHaveBeenCalledTimes(1));
        await screen.findByText(blocked ? "Authorization window blocked" : "Authorizing…");
        await closeAdd();
        await openDetails("review");
        const dialog = within(screen.getByRole("dialog"));
        if (blocked) expect(dialog.getByRole("button", { name: "Open window" })).toBeTruthy();
        fireEvent.click(dialog.getByRole("button", { name: "Cancel" }));
        await screen.findByRole("heading", { name: "No connectors yet" });
        await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
        expect(browserApi.revokeMcpAuthorization).toHaveBeenCalledWith(AGENT_ID, SERVER_ID, "review-state");
        expect(flow.detach).toHaveBeenCalledTimes(1);
        await waitFor(() =>
          expect(screen.getByRole("button", { name: "Add custom" }).hasAttribute("disabled")).toBe(false),
        );
      } finally {
        flow.browser.restore();
      }
    },
  );
});
