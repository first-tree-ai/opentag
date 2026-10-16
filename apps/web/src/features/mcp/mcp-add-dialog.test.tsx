import { fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { browserApi } from "../../api.js";
import { McpPage } from "./mcp-page.js";
import { AGENT_ID, newAddress, stub, wrap } from "./mcp-test-fixtures.js";

afterEach(() => vi.restoreAllMocks());
describe("MCP custom first screen", () => {
  it("shows the address and explicit authentication choices before any write", async () => {
    stub([]);
    const create = vi.spyOn(browserApi, "createMcpServer");
    wrap(<McpPage agentId={AGENT_ID} />);
    await newAddress();
    expect(screen.getByRole("radio", { name: "Account sign-in" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getAllByRole("radio")).toHaveLength(3);
    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.getByRole("button", { name: "Connect" })).toBeTruthy();
    expect(dialog.queryByRole("button", { name: "Cancel" })).toBeNull();
    expect(dialog.getByRole("button", { name: "Advanced settings" }).getAttribute("aria-expanded")).toBe("false");
    expect(create).not.toHaveBeenCalled();
  });
  it("shows one key field and bearer header defaults only when that method is selected", async () => {
    stub([]);
    wrap(<McpPage agentId={AGENT_ID} />);
    await newAddress();
    fireEvent.click(screen.getByRole("radio", { name: "API key or token" }));
    const input = screen.getByLabelText("API key or token", { selector: "input[type=password]" });
    expect(input.getAttribute("placeholder")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Advanced settings" }));
    expect((screen.getByLabelText("Auth header") as HTMLInputElement).value.toLowerCase()).toBe("authorization");
    expect((screen.getByLabelText("Prefix") as HTMLInputElement).value).toBe("Bearer");
    fireEvent.click(screen.getByRole("radio", { name: "No authentication" }));
    expect(screen.queryByLabelText("Auth header")).toBeNull();
    expect(screen.queryByLabelText("Prefix")).toBeNull();
    expect(screen.getByRole("button", { name: "Add header" })).toBeTruthy();
  });
});
