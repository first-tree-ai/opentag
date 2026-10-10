import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, browserApi } from "../../api.js";
import { McpPage } from "./mcp-page.js";
import { AGENT_ID, authorization, entry, openDetails, SERVER_ID, stub, wrap } from "./mcp-test-fixtures.js";

afterEach(() => vi.restoreAllMocks());
async function openAuthentication() {
  await openDetails();
  fireEvent.click(screen.getByRole("button", { name: /Authentication/ }));
  return screen.findByRole("dialog", { name: "linear authentication" });
}
async function method(name: string) {
  fireEvent.click(screen.getByRole("combobox", { name: "Authorization method" }));
  const option = await screen.findByRole("option", { name });
  fireEvent.pointerMove(option, { pointerType: "mouse" });
  fireEvent.pointerDown(option, { pointerType: "mouse" });
  fireEvent.pointerUp(option, { pointerType: "mouse" });
  fireEvent.click(option);
  await waitFor(() =>
    expect(screen.getByRole("combobox", { name: "Authorization method" }).textContent).toContain(name),
  );
}
const key = () => screen.getByLabelText("API key or token", { selector: "input" }) as HTMLInputElement;

describe("MCP authentication journeys", () => {
  it("preserves all three methods and changes the method only when submitted", async () => {
    stub([entry()]);
    const authorize = vi.spyOn(browserApi, "setMcpAuthorization").mockResolvedValue(entry());
    const update = vi.spyOn(browserApi, "updateAgentMcpServer");
    wrap(<McpPage agentId={AGENT_ID} />);
    await openAuthentication();
    await method("Browser sign-in (OAuth)");
    expect(screen.getByRole("button", { name: "Connect" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Advanced settings" })).toBeNull();
    await method("No authentication");
    expect(authorize).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByRole("dialog", { name: "linear" });
    expect(authorize).toHaveBeenCalledWith(AGENT_ID, SERVER_ID, { kind: "none" });
    expect(update).not.toHaveBeenCalled();
  });
  it("keeps the entered key after a network failure and retries without editing connection settings", async () => {
    stub([entry()]);
    const authorize = vi
      .spyOn(browserApi, "setMcpAuthorization")
      .mockRejectedValueOnce(new ApiError(503, "Service unavailable"))
      .mockResolvedValue(entry());
    const update = vi.spyOn(browserApi, "updateAgentMcpServer");
    wrap(<McpPage agentId={AGENT_ID} />);
    await openAuthentication();
    expect(key().value).toBe("");
    fireEvent.change(key(), { target: { value: "test-key" } });
    fireEvent.click(screen.getByRole("button", { name: "Show key" }));
    expect(key().type).toBe("text");
    fireEvent.click(screen.getByRole("button", { name: "Hide key" }));
    expect(key().type).toBe("password");
    fireEvent.click(screen.getByRole("button", { name: "Update credentials" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Service unavailable");
    expect(key().value).toBe("test-key");
    fireEvent.click(screen.getByRole("button", { name: "Update credentials" }));
    await screen.findByRole("dialog", { name: "linear" });
    expect(authorize).toHaveBeenCalledTimes(2);
    expect(update).not.toHaveBeenCalled();
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
  });
  it("keeps the authentication dialog available after OAuth cannot start", async () => {
    stub([entry({ authorization: null })]);
    const oauth = vi.spyOn(browserApi, "startMcpOAuth").mockRejectedValue(new ApiError(503, "Sign-in unavailable"));
    wrap(<McpPage agentId={AGENT_ID} />);
    await openAuthentication();
    await method("Browser sign-in (OAuth)");
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Connect" }));
    await screen.findByText("Sign-in unavailable");
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(oauth).toHaveBeenCalledTimes(2));
  });
  it("confirms local credential clearing once and returns to authentication", async () => {
    stub([entry()]);
    const cleared = entry({
      authorization: { ...authorization(), status: "revoked", hasCredential: false },
      snapshot: null,
    });
    const revoke = vi.spyOn(browserApi, "revokeMcpAuthorization").mockImplementation(async () => {
      vi.mocked(browserApi.agentMcpServers).mockResolvedValue({ servers: [cleared] });
      return cleared;
    });
    wrap(<McpPage agentId={AGENT_ID} />);
    await openAuthentication();
    fireEvent.click(screen.getByRole("button", { name: "Clear credentials…" }));
    const confirm = await screen.findByRole("alertdialog");
    expect(revoke).not.toHaveBeenCalled();
    expect(within(confirm).getByText(/does not revoke access on the service’s website/)).toBeTruthy();
    fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
    await screen.findByRole("dialog", { name: "linear authentication" });
    expect(revoke).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Clear credentials…" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear credentials" }));
    await screen.findByRole("dialog", { name: "linear authentication" });
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Clear credentials…" })).toBeNull();
  });
});
