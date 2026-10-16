import { MCP_ERROR_CODES } from "@opentag/shared/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, browserApi } from "../../api.js";
import { discardMcpSetup } from "./mcp-setup-cleanup.js";
import { AGENT_ID, authorization, entry, SERVER_ID } from "./mcp-test-fixtures.js";

afterEach(() => vi.restoreAllMocks());
describe("same-tab setup cancellation", () => {
  it("cancels only the returned attempt before discarding a provisional binding", async () => {
    const pending = entry({
      authorization: { ...authorization(), kind: "oauth", status: "pending", hasCredential: false },
    });
    vi.spyOn(browserApi, "agentMcpServers").mockResolvedValue({ servers: [pending] });
    const revoke = vi.spyOn(browserApi, "revokeMcpAuthorization").mockImplementation(async () => {
      pending.authorization = { ...authorization(), kind: "oauth", status: "revoked", hasCredential: false };
      return pending;
    });
    const detach = vi.fn().mockResolvedValue(undefined);
    const remove = vi.spyOn(browserApi, "removeMcpServer").mockResolvedValue(undefined);
    expect(await discardMcpSetup(AGENT_ID, SERVER_ID, detach, "returned-state")).toBe(true);
    expect(revoke).toHaveBeenCalledWith(AGENT_ID, SERVER_ID, "returned-state");
    expect(detach).toHaveBeenCalledWith(SERVER_ID);
    expect(remove).toHaveBeenCalledWith(SERVER_ID);
  });
  it("preserves the binding when the returned attempt no longer matches", async () => {
    const pending = entry({
      authorization: { ...authorization(), kind: "oauth", status: "pending", hasCredential: false },
    });
    const read = vi.spyOn(browserApi, "agentMcpServers").mockResolvedValue({ servers: [pending] });
    vi.spyOn(browserApi, "revokeMcpAuthorization").mockRejectedValue(
      new ApiError(400, "Ended attempt", MCP_ERROR_CODES.OAUTH_FLOW_INVALID),
    );
    const detach = vi.fn();
    expect(await discardMcpSetup(AGENT_ID, SERVER_ID, detach, "older-state")).toBe(false);
    expect(read).toHaveBeenCalledTimes(1);
    expect(detach).not.toHaveBeenCalled();
  });
});
