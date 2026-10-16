import { MCP_AUTH_REJECTION_SUMMARY, MCP_ERROR_CODES } from "@opentag/shared/browser";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, browserApi } from "../../api.js";
import { McpPage } from "./mcp-page.js";
import { AGENT_ID, authorization, entry, SERVER_ID, stub, wrap } from "./mcp-test-fixtures.js";

const rejection = `${MCP_ERROR_CODES.UPSTREAM_ERROR}: ${MCP_AUTH_REJECTION_SUMMARY}`;
const ready = {
  probeState: "succeeded" as const,
  probeError: null,
  toolsCount: 1,
  toolsTruncated: false,
  protocolEra: null,
  protocolVersion: null,
};
afterEach(() => vi.restoreAllMocks());
describe("MCP recovery actions", () => {
  it("retries an authorized OAuth tool load without opening an authorization window", async () => {
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
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const oauth = vi.spyOn(browserApi, "startMcpOAuth");
    const probe = vi.spyOn(browserApi, "probeMcpServer").mockResolvedValue(ready);
    wrap(<McpPage agentId={AGENT_ID} />);
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    await waitFor(() => expect(probe).toHaveBeenCalledWith(AGENT_ID, SERVER_ID));
    expect(oauth).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });
  it.each(["pending", "expired", "revoked", "error"] as const)(
    "starts configured OAuth explicitly for %s",
    async (status) => {
      stub([entry({ authorization: { ...authorization(), kind: "oauth", status } })]);
      vi.spyOn(window, "open").mockReturnValue(null);
      const oauth = vi.spyOn(browserApi, "startMcpOAuth").mockRejectedValue(new ApiError(503, "private detail"));
      const probe = vi.spyOn(browserApi, "probeMcpServer");
      wrap(<McpPage agentId={AGENT_ID} />);
      fireEvent.click(await screen.findByRole("button", { name: "Reauthorize" }));
      await screen.findByText("Authorization failed");
      expect(screen.queryByRole("dialog")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Reauthorize" }));
      await waitFor(() => expect(oauth).toHaveBeenCalledTimes(2));
      expect(probe).not.toHaveBeenCalled();
    },
  );
  it("opens key replacement directly for a rejected key", async () => {
    stub([entry({ authorization: { ...authorization(), probeState: "failed", probeError: rejection } })]);
    const probe = vi.spyOn(browserApi, "probeMcpServer");
    wrap(<McpPage agentId={AGENT_ID} />);
    fireEvent.click(await screen.findByRole("button", { name: "Reauthorize" }));
    await screen.findByRole("dialog");
    expect(screen.getByLabelText("API key or token", { selector: "input[type=password]" })).toBeTruthy();
    expect(probe).not.toHaveBeenCalled();
  });
  it("opens explicit authentication choices after an anonymous rejection", async () => {
    stub([
      entry({
        authorization: {
          ...authorization(),
          kind: "none",
          hasCredential: false,
          probeState: "failed",
          probeError: rejection,
        },
      }),
    ]);
    const oauth = vi.spyOn(browserApi, "startMcpOAuth");
    wrap(<McpPage agentId={AGENT_ID} />);
    fireEvent.click(await screen.findByRole("button", { name: "Authorize" }));
    await screen.findByRole("dialog");
    expect(screen.getByRole("radio", { name: "No authentication" }).getAttribute("aria-checked")).toBe("true");
    expect(oauth).not.toHaveBeenCalled();
  });
  it("retries tool loading with the saved credential and guards duplicate requests", async () => {
    stub([
      entry({
        authorization: { ...authorization(), probeState: "failed", probeError: "MCP_UPSTREAM_UNAVAILABLE: timeout" },
      }),
    ]);
    let finish: (result: typeof ready) => void = () => {};
    const probe = vi.spyOn(browserApi, "probeMcpServer").mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const authorize = vi.spyOn(browserApi, "setMcpAuthorization");
    wrap(<McpPage agentId={AGENT_ID} />);
    const retry = await screen.findByRole("button", { name: "Retry" });
    expect(screen.getByText("Request timed out")).toBeTruthy();
    fireEvent.click(retry);
    await waitFor(() => expect(probe).toHaveBeenCalledWith(AGENT_ID, SERVER_ID));
    fireEvent.click(retry);
    expect(probe).toHaveBeenCalledTimes(1);
    finish(ready);
    await waitFor(() => expect(screen.queryByText("Loading tools…")).toBeNull());
    expect(authorize).not.toHaveBeenCalled();
    expect(browserApi.revokeMcpAuthorization).not.toHaveBeenCalled();
  });
});
