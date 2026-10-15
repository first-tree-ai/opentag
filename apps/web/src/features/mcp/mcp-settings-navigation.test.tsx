import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { browserApi } from "../../api.js";
import { McpPage } from "./mcp-page.js";
import { AGENT_ID, detail, entry, openDetails, stub, wrap } from "./mcp-test-fixtures.js";

afterEach(() => vi.restoreAllMocks());
const address = () => screen.getByLabelText("Connector address") as HTMLInputElement;

describe("MCP detail drafts", () => {
  it("shows validation after leaving an invalid address", async () => {
    stub([entry()]);
    wrap(<McpPage agentId={AGENT_ID} />);
    await openDetails();
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.change(address(), { target: { value: "not-an-address" } });
    fireEvent.blur(address());
    expect(address().getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true);
    fireEvent.change(address(), { target: { value: "https://valid.example.com/mcp" } });
    expect(screen.queryByRole("alert")).toBeNull();
  });
  it.each(["close", "escape"])("discards an unsubmitted draft using %s", async (way) => {
    stub([entry()]);
    const update = vi.spyOn(browserApi, "updateAgentMcpServer");
    wrap(<McpPage agentId={AGENT_ID} />);
    await openDetails();
    fireEvent.change(address(), { target: { value: "https://draft.example.com/mcp" } });
    if (way === "close") fireEvent.click(screen.getByRole("button", { name: "Close linear" }));
    else fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await openDetails();
    expect(address().value).toBe(entry().effective.url);
    expect(update).not.toHaveBeenCalled();
  });
  it("waits for an unfinished custom connector's saved authentication method", async () => {
    stub([entry({ authorization: null })]);
    let finish: (value: ReturnType<typeof detail>) => void = () => {};
    vi.mocked(browserApi.mcpServer).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const oauth = vi.spyOn(browserApi, "startMcpOAuth");
    wrap(<McpPage agentId={AGENT_ID} />);
    await openDetails();
    expect(within(screen.getByRole("dialog")).queryByRole("button", { name: "Authorize" })).toBeNull();
    fireEvent.change(address(), { target: { value: "https://draft.example.com/mcp" } });
    const defaults = detail(1);
    await act(async () => finish({ ...defaults, server: { ...defaults.server, defaultAuthKind: "bearer" } }));
    await waitFor(() =>
      expect(screen.getByRole("radio", { name: "API key or token" }).getAttribute("aria-checked")).toBe("true"),
    );
    expect(address().value).toBe("https://draft.example.com/mcp");
    expect(oauth).not.toHaveBeenCalled();
  });
  it("guards duplicate credential submissions until the request completes", async () => {
    stub([entry()]);
    let finish: (value: ReturnType<typeof entry>) => void = () => {};
    const authorize = vi.spyOn(browserApi, "setMcpAuthorization").mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    wrap(<McpPage agentId={AGENT_ID} />);
    await openDetails();
    fireEvent.click(screen.getByRole("button", { name: "Update" }));
    fireEvent.change(screen.getByLabelText("API key or token", { selector: "input[type=password]" }), {
      target: { value: "new-key" },
    });
    const save = screen.getByRole("button", { name: "Save" });
    fireEvent.click(save);
    await waitFor(() => expect(authorize).toHaveBeenCalledTimes(1));
    expect(
      (screen.getByLabelText("API key or token", { selector: "input[type=password]" }) as HTMLInputElement).disabled,
    ).toBe(true);
    fireEvent.click(save);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(authorize).toHaveBeenCalledTimes(1);
    await act(async () => finish(entry()));
    await screen.findByRole("button", { name: "Update" });
  });
});
