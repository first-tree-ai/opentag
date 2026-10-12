import { MCP_AUTH_REJECTION_SUMMARY, MCP_ERROR_CODES } from "@opentag/shared/browser";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, browserApi } from "../../api.js";
import { McpPage } from "./mcp-page.js";
import { AGENT_ID, authorization, detail, entry, openDetails, SERVER_ID, stub, wrap } from "./mcp-test-fixtures.js";

const rejection = `${MCP_ERROR_CODES.UPSTREAM_ERROR}: ${MCP_AUTH_REJECTION_SUMMARY}`;
const ready = {
  probeState: "succeeded" as const,
  probeError: null,
  toolsCount: 1,
  toolsTruncated: false,
  protocolEra: null,
  protocolVersion: null,
};
beforeEach(() => vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 0));
afterEach(() => vi.restoreAllMocks());
const keyInput = () => within(screen.getByRole("dialog")).getByLabelText("API key or token") as HTMLInputElement;
const submitKey = () => fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Connect" }));

describe("ordinary MCP Connect", () => {
  it.each(["pending", "expired", "revoked", "error"] as const)(
    "starts configured OAuth directly for %s without a chooser or writes",
    async (status) => {
      stub([entry({ authorization: { ...authorization(), kind: "oauth", status } })]);
      const oauth = vi
        .spyOn(browserApi, "startMcpOAuth")
        .mockRejectedValue(new ApiError(503, "private upstream detail"));
      const authorize = vi.spyOn(browserApi, "setMcpAuthorization");
      const update = vi.spyOn(browserApi, "updateAgentMcpServer");
      wrap(<McpPage agentId={AGENT_ID} />);
      fireEvent.click(await screen.findByRole("button", { name: "Reconnect" }));
      await screen.findByText("Couldn’t start sign-in. Try again.");
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(screen.queryByRole("radio")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
      await waitFor(() => expect(oauth).toHaveBeenCalledTimes(2));
      expect(authorize).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
    },
  );
  it("uses the account default for a first connection and disables duplicate requests", async () => {
    stub([entry({ authorization: null })], { ...detail(1), server: { ...detail(1).server, defaultAuthKind: "none" } });
    let finish: () => void = () => {};
    const authorize = vi.spyOn(browserApi, "setMcpAuthorization").mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => resolve(entry({ authorization: { ...authorization(), kind: "none" } }));
        }),
    );
    vi.spyOn(browserApi, "probeMcpServer").mockResolvedValue(ready);
    wrap(<McpPage agentId={AGENT_ID} />);
    const button = await screen.findByRole("button", { name: "Connect" });
    fireEvent.click(button);
    await waitFor(() => expect(authorize).toHaveBeenCalledTimes(1));
    fireEvent.click(button);
    expect(authorize).toHaveBeenCalledTimes(1);
    expect(authorize).toHaveBeenCalledWith(AGENT_ID, SERVER_ID, { kind: "none" });
    expect(screen.queryByRole("dialog")).toBeNull();
    finish();
    await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));
  });
  it("retains a bearer draft after rejection and retries the same binding without changing headers", async () => {
    stub([
      entry({
        authorization: { ...authorization(), kind: "bearer", status: "revoked" },
        effective: {
          ...entry().effective,
          url: "https://custom.test/mcp",
          authHeader: "x-api-key",
          authScheme: "",
          extraHeaders: { "x-tenant": "tenant" },
        },
      }),
    ]);
    const auth = vi.spyOn(browserApi, "setMcpAuthorization").mockResolvedValue(entry());
    const probe = vi
      .spyOn(browserApi, "probeMcpServer")
      .mockResolvedValueOnce({ ...ready, probeState: "failed", probeError: rejection, toolsCount: null })
      .mockResolvedValue(ready);
    const update = vi.spyOn(browserApi, "updateAgentMcpServer");
    const create = vi.spyOn(browserApi, "createMcpServer");
    const attach = vi.spyOn(browserApi, "attachMcpServer");
    const oauth = vi.spyOn(browserApi, "startMcpOAuth");
    wrap(<McpPage agentId={AGENT_ID} />);
    fireEvent.click(await screen.findByRole("button", { name: "Reconnect" }));
    await screen.findByRole("dialog");
    expect(screen.queryByRole("radio")).toBeNull();
    fireEvent.change(keyInput(), { target: { value: "wrong-key" } });
    submitKey();
    await screen.findByText("Invalid API key. Try again.");
    expect(keyInput().value).toBe("wrong-key");
    fireEvent.change(keyInput(), { target: { value: "valid-key" } });
    submitKey();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(auth).toHaveBeenLastCalledWith(AGENT_ID, SERVER_ID, { kind: "bearer", bearerKey: "valid-key" });
    expect(probe).toHaveBeenCalledTimes(2);
    for (const mutation of [update, create, attach, oauth]) expect(mutation).not.toHaveBeenCalled();
  });
  it("requests a replacement for a persisted rejected bearer key without probing it again", async () => {
    stub([entry({ authorization: { ...authorization(), probeState: "failed", probeError: rejection } })]);
    const probe = vi.spyOn(browserApi, "probeMcpServer");
    wrap(<McpPage agentId={AGENT_ID} />);
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    await screen.findByRole("dialog");
    expect(keyInput().value).toBe("");
    expect(probe).not.toHaveBeenCalled();
    expect(screen.queryByRole("radio")).toBeNull();
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("retries unknown anonymous auth rejection using OAuth discovery after startup failure", async () => {
    stub([
      entry({
        authorization: {
          ...authorization(),
          kind: "none",
          hasCredential: false,
          probeState: "failed",
          probeError: rejection,
        },
        effective: { ...entry().effective, url: "https://unknown.test/mcp" },
      }),
    ]);
    const probe = vi
      .spyOn(browserApi, "probeMcpServer")
      .mockResolvedValue({ ...ready, probeState: "failed", probeError: rejection, toolsCount: null });
    const oauth = vi.spyOn(browserApi, "startMcpOAuth").mockRejectedValue(new ApiError(502, "unsupported"));
    wrap(<McpPage agentId={AGENT_ID} />);
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    await screen.findByText("Couldn’t start sign-in. Try again.");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(oauth).toHaveBeenCalledTimes(2));
    expect(probe).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("keeps an empty tool result retryable on the list", async () => {
    const binding = entry({ authorization: { ...authorization(), kind: "none", probeState: "failed" } });
    stub([binding]);
    const probe = vi
      .spyOn(browserApi, "probeMcpServer")
      .mockResolvedValueOnce({ ...ready, toolsCount: 0 })
      .mockResolvedValue(ready);
    wrap(<McpPage agentId={AGENT_ID} />);
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    await screen.findByText("This connector has no available tools.");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(probe).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText("This connector has no available tools.")).toBeNull());
  });
  it("does not start authorization after leaving during definition lookup", async () => {
    stub([entry({ authorization: null })]);
    let finish: (value: ReturnType<typeof detail>) => void = () => {};
    vi.mocked(browserApi.mcpServer).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const oauth = vi.spyOn(browserApi, "startMcpOAuth");
    const view = wrap(<McpPage agentId={AGENT_ID} />);
    fireEvent.click(await screen.findByRole("button", { name: "Connect" }));
    await waitFor(() => expect(browserApi.mcpServer).toHaveBeenCalled());
    view.unmount();
    await act(async () => {
      finish(detail(1));
    });
    expect(oauth).not.toHaveBeenCalled();
  });
  it("does not start OAuth discovery after leaving during an anonymous probe", async () => {
    stub([
      entry({
        effective: { ...entry().effective, url: "https://unknown.test/mcp" },
        authorization: { ...authorization(), kind: "none", probeState: "failed" },
      }),
    ]);
    let finish: (value: Awaited<ReturnType<typeof browserApi.probeMcpServer>>) => void = () => {};
    const probe = vi.spyOn(browserApi, "probeMcpServer").mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const oauth = vi.spyOn(browserApi, "startMcpOAuth");
    const view = wrap(<McpPage agentId={AGENT_ID} />);
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    await waitFor(() => expect(probe).toHaveBeenCalled());
    view.unmount();
    await act(async () => {
      finish({ ...ready, probeState: "failed", probeError: rejection, toolsCount: null });
    });
    expect(oauth).not.toHaveBeenCalled();
  });
  it("probes the saved headers after settings change instead of retaining a failed discovery hint", async () => {
    let binding = entry({
      effective: { ...entry().effective, url: "https://unknown.test/mcp" },
      authorization: { ...authorization(), kind: "none", probeState: "failed", probeError: rejection },
    });
    stub([binding]);
    vi.mocked(browserApi.agentMcpServers).mockImplementation(async () => ({ servers: [binding] }));
    const oauth = vi.spyOn(browserApi, "startMcpOAuth").mockRejectedValue(new ApiError(502, "unsupported"));
    const probe = vi
      .spyOn(browserApi, "probeMcpServer")
      .mockResolvedValueOnce({ ...ready, probeState: "failed", probeError: rejection, toolsCount: null })
      .mockResolvedValue(ready);
    vi.spyOn(browserApi, "updateAgentMcpServer").mockImplementation(async () => {
      binding = { ...binding, effective: { ...binding.effective, extraHeaders: { "x-workspace-id": "updated" } } };
      return binding;
    });
    wrap(<McpPage agentId={AGENT_ID} />);
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    await screen.findByText("Couldn’t start sign-in. Try again.");
    await openDetails();
    fireEvent.click(screen.getByRole("button", { name: "Advanced settings" }));
    fireEvent.change(screen.getByLabelText("Header value"), { target: { value: "updated" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(probe).toHaveBeenCalledTimes(2));
    expect(oauth).toHaveBeenCalledTimes(1);
  });
});
