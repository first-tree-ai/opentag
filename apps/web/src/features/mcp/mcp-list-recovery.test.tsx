import { MCP_AUTH_REJECTION_SUMMARY, MCP_ERROR_CODES } from "@opentag/shared/browser";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, browserApi } from "../../api.js";
import { McpPage } from "./mcp-page.js";
import { AGENT_ID, authorization, entry, SERVER_ID, stub, wrap } from "./mcp-test-fixtures.js";

const ready = {
  probeState: "succeeded" as const,
  probeError: null,
  toolsCount: 3,
  toolsTruncated: false,
  protocolEra: "modern" as const,
  protocolVersion: "2026-07-28",
};
afterEach(() => vi.restoreAllMocks());
describe("connector list recovery", () => {
  it("offers authorization directly when no credential has been configured", async () => {
    stub([entry({ authorization: null })]);
    wrap(<McpPage agentId={AGENT_ID} />);
    expect(await screen.findByText("Authorization required")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Authorize: linear" }));
    expect(await screen.findByRole("dialog", { name: "linear" })).toBeTruthy();
  });
  it("reauthorizes expired OAuth from the list without opening a configuration dialog", async () => {
    stub([entry({ authorization: { ...authorization(), kind: "oauth", status: "expired" } })]);
    vi.spyOn(window, "open").mockReturnValue(null);
    const start = vi.spyOn(browserApi, "startMcpOAuth").mockRejectedValue(new ApiError(503, "Unavailable"));
    wrap(<McpPage agentId={AGENT_ID} />);
    fireEvent.click(await screen.findByRole("button", { name: "Reauthorize: linear" }));
    await waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(await screen.findByText("Authorization failed")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reauthorize: linear" })).toBeTruthy();
  });
  it("opens the credential editor from a rejected key without making a request", async () => {
    stub([
      entry({
        authorization: {
          ...authorization(),
          probeState: "failed",
          probeError: `${MCP_ERROR_CODES.UPSTREAM_ERROR}: ${MCP_AUTH_REJECTION_SUMMARY}`,
        },
      }),
    ]);
    const save = vi.spyOn(browserApi, "setMcpAuthorization");
    wrap(<McpPage agentId={AGENT_ID} />);
    fireEvent.click(await screen.findByRole("button", { name: "Update credentials: linear" }));
    const dialog = within(await screen.findByRole("dialog", { name: "linear" }));
    expect(await dialog.findByLabelText("API key or token", { selector: "input[type=password]" })).toBeTruthy();
    expect(save).not.toHaveBeenCalled();
  });
  it("retries with the existing credential, showing only a disabled trash button while checking", async () => {
    stub([
      entry({
        authorization: {
          ...authorization(),
          kind: "oauth",
          probeState: "failed",
          probeError: "MCP_UPSTREAM_UNAVAILABLE: timeout",
        },
      }),
    ]);
    const oauth = vi.spyOn(browserApi, "startMcpOAuth");
    const save = vi.spyOn(browserApi, "setMcpAuthorization");
    let finish: () => void = () => {};
    const probe = vi.spyOn(browserApi, "probeMcpServer").mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => {
            vi.mocked(browserApi.agentMcpServers).mockResolvedValue({
              servers: [entry({ authorization: { ...authorization(), kind: "oauth" } })],
            });
            resolve(ready);
          };
        }),
    );
    wrap(<McpPage agentId={AGENT_ID} />);
    fireEvent.click(await screen.findByRole("button", { name: "Retry: linear" }));
    expect(await screen.findByText("Checking connection…")).toBeTruthy();
    const identity = screen.getByRole("button", { name: "linear" });
    const row = within(identity.closest("li") as HTMLElement);
    expect(row.getAllByRole("button")).toHaveLength(2);
    expect(row.getByRole("button", { name: "Remove linear" }).hasAttribute("disabled")).toBe(true);
    expect(probe).toHaveBeenCalledExactlyOnceWith(AGENT_ID, SERVER_ID);
    expect(oauth).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(identity);
    finish();
    await waitFor(() =>
      expect(row.getByRole("button", { name: "Remove linear" }).hasAttribute("disabled")).toBe(false),
    );
    expect(row.queryByRole("button", { name: "Retry: linear" })).toBeNull();
  });
  it("disables other recovery actions until the current browser attempt settles", async () => {
    const failed = {
      ...authorization(),
      probeState: "failed" as const,
      probeError: "MCP_UPSTREAM_UNAVAILABLE: timeout",
    };
    const secondId = "7d58c487-49e9-4aa1-a546-d82157d634b3";
    stub([entry({ authorization: failed }), entry({ mcpServerId: secondId, name: "second", authorization: failed })]);
    let finish: () => void = () => {};
    const probe = vi.spyOn(browserApi, "probeMcpServer").mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => resolve(ready);
        }),
    );
    wrap(<McpPage agentId={AGENT_ID} />);
    fireEvent.click(await screen.findByRole("button", { name: "Retry: linear" }));
    const second = screen.getByRole("button", { name: "Retry: second" });
    expect(second).toHaveProperty("disabled", true);
    await waitFor(() => expect(probe).toHaveBeenCalledTimes(1));
    fireEvent.click(second);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "linear" }));
    finish();
    await waitFor(() => expect(second).toHaveProperty("disabled", false));
    fireEvent.click(second);
    await waitFor(() => expect(probe).toHaveBeenCalledWith(AGENT_ID, secondId));
    finish();
    await waitFor(() => expect(screen.queryByText("Checking connection…")).toBeNull());
  });
  it("allows removing a connector whose initial background probe is still pending", async () => {
    stub([
      entry({
        snapshot: null,
        authorization: { ...authorization(), probeState: "pending", probedAt: null, toolsCount: null },
      }),
    ]);
    wrap(<McpPage agentId={AGENT_ID} />);
    expect(await screen.findByText("Checking connection…")).toBeTruthy();
    const remove = screen.getByRole("button", { name: "Remove linear" });
    expect(remove).toHaveProperty("disabled", false);
    fireEvent.click(remove);
    expect(await screen.findByRole("alertdialog")).toBeTruthy();
  });
  it("does not mistake a failed tool-read request for expired OAuth", async () => {
    stub([
      entry({
        authorization: {
          ...authorization(),
          kind: "oauth",
          probeState: "failed",
          probeError: "MCP_UPSTREAM_UNAVAILABLE: timeout",
        },
      }),
    ]);
    const oauth = vi.spyOn(browserApi, "startMcpOAuth");
    vi.spyOn(browserApi, "probeMcpServer").mockRejectedValue(new ApiError(503, "Unavailable"));
    wrap(<McpPage agentId={AGENT_ID} />);
    fireEvent.click(await screen.findByRole("button", { name: "Retry: linear" }));
    expect(await screen.findByText("Couldn’t connect. Try again.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry: linear" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Reauthorize: linear" })).toBeNull();
    expect(oauth).not.toHaveBeenCalled();
  });
  it("offers reauthorization when the probe explicitly reports a missing authorization", async () => {
    stub([
      entry({
        authorization: {
          ...authorization(),
          kind: "oauth",
          probeState: "failed",
          probeError: "MCP_UPSTREAM_UNAVAILABLE: timeout",
        },
      }),
    ]);
    vi.spyOn(browserApi, "probeMcpServer").mockRejectedValue(
      new ApiError(403, "Not authorized", MCP_ERROR_CODES.AUTHORIZATION_REQUIRED),
    );
    wrap(<McpPage agentId={AGENT_ID} />);
    fireEvent.click(await screen.findByRole("button", { name: "Retry: linear" }));
    expect(await screen.findByText("Authorization failed")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reauthorize: linear" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry: linear" })).toBeNull();
  });
  it("does not call a saved pending record an active authorization session", async () => {
    stub([entry({ authorization: { ...authorization(), kind: "oauth", status: "pending", hasCredential: false } })]);
    wrap(<McpPage agentId={AGENT_ID} />);
    expect(await screen.findByText("Authorization required")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Authorize: linear" })).toBeTruthy();
    expect(screen.queryByText("Waiting for authorization…")).toBeNull();
    expect(screen.getByRole("button", { name: "Remove linear" }).hasAttribute("disabled")).toBe(false);
  });
});
