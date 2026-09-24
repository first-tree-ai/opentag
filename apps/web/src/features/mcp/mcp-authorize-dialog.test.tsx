import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, browserApi } from "../../api.js";
import { McpPage } from "./mcp-page.js";
import { AGENT_ID, entry, menuAction, SERVER_ID, stub, wrap } from "./mcp-test-fixtures.js";

afterEach(() => vi.restoreAllMocks());

describe("MCP authorization retry after connection settings were saved", () => {
  it.each([
    ["Auth header", "authHeader", "x-api-key"],
    ["Token prefix", "authScheme", "Token"],
  ] as const)("restores the original %s before retrying credentials", async (label, field, value) => {
    const original = entry();
    const changed = entry({
      effective: { ...original.effective, [field]: value },
      overridden: { ...original.overridden, [field]: true },
    });
    stub([original]);
    const update = vi
      .spyOn(browserApi, "updateAgentMcpServer")
      .mockResolvedValueOnce(changed)
      .mockResolvedValue(original);
    const authorize = vi
      .spyOn(browserApi, "setMcpAuthorization")
      .mockRejectedValueOnce(new ApiError(503, "Credential update failed"))
      .mockResolvedValue(original);
    wrap(<McpPage agentId={AGENT_ID} />);
    await menuAction("Authentication");
    fireEvent.change(screen.getByLabelText("API key or token", { selector: 'input[type="password"]' }), {
      target: { value: "example-token" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Advanced connection settings" }));
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
    fireEvent.click(screen.getByRole("button", { name: "Update credentials" }));
    await screen.findByText("Credential update failed");
    fireEvent.change(screen.getByLabelText(label), { target: { value: original.effective[field] } });
    fireEvent.click(screen.getByRole("button", { name: "Update credentials" }));
    await waitFor(() => expect(authorize).toHaveBeenCalledTimes(2));
    expect(update).toHaveBeenNthCalledWith(2, AGENT_ID, SERVER_ID, { [field]: original.effective[field] });
    expect(update.mock.invocationCallOrder[1]).toBeLessThan(authorize.mock.invocationCallOrder[1] as number);
  });

  it("clears successfully saved custom headers when retrying OAuth with account defaults", async () => {
    const original = entry({ authorization: null });
    stub([original]);
    const update = vi.spyOn(browserApi, "updateAgentMcpServer").mockResolvedValue(
      entry({
        authorization: null,
        effective: { ...original.effective, extraHeaders: { "x-workspace-id": "custom-workspace" } },
        overridden: { ...original.overridden, extraHeaders: true },
      }),
    );
    const oauth = vi.spyOn(browserApi, "startMcpOAuth").mockRejectedValue(new ApiError(503, "OAuth unavailable"));
    wrap(<McpPage agentId={AGENT_ID} />);
    await menuAction("Authentication");
    fireEvent.click(screen.getByRole("button", { name: "Advanced connection settings" }));
    fireEvent.click(screen.getByRole("radio", { name: "Custom headers" }));
    fireEvent.change(screen.getByLabelText("Header value"), { target: { value: "custom-workspace" } });
    fireEvent.click(screen.getByRole("button", { name: "Authorize in browser" }));
    await screen.findByText("OAuth unavailable");
    fireEvent.click(screen.getByRole("radio", { name: "Use account defaults" }));
    fireEvent.click(screen.getByRole("button", { name: "Authorize in browser" }));
    await waitFor(() => expect(oauth).toHaveBeenCalledTimes(2));
    expect(update).toHaveBeenNthCalledWith(2, AGENT_ID, SERVER_ID, { clearExtraHeaders: true });
    expect(update.mock.invocationCallOrder[1]).toBeLessThan(oauth.mock.invocationCallOrder[1] as number);
  });
});
