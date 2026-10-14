import type { CreateMCPServerRequest } from "@opentag/shared/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, browserApi } from "../../api.js";
import { createMcpInstallation } from "./mcp-installation.js";
import { detail } from "./mcp-test-fixtures.js";

afterEach(() => vi.restoreAllMocks());
const input: CreateMCPServerRequest = { name: "linear", url: "https://example.com/mcp", defaultAuthKind: "oauth" };
const conflict = () => new ApiError(409, "Name exists", "MCP_SERVER_NAME_CONFLICT");

describe("independent connector creation", () => {
  it("creates without reading the Account pool", async () => {
    const pool = vi.spyOn(browserApi, "mcpServers");
    const create = vi.fn().mockResolvedValue(detail(0).server);
    await createMcpInstallation(input, create);
    expect(create).toHaveBeenCalledExactlyOnceWith(input);
    expect(pool).not.toHaveBeenCalled();
  });

  it("handles concurrent conflicts and case-insensitive names without reusing a matching URL", async () => {
    vi.spyOn(browserApi, "mcpServers").mockResolvedValue({
      servers: [detail(1).server, { ...detail(1).server, name: "LINEAR-2", url: input.url }],
    });
    const fresh = { ...detail(0).server, id: "44444444-4444-4444-8444-444444444444" };
    const create = vi.fn().mockRejectedValueOnce(conflict()).mockRejectedValueOnce(conflict()).mockResolvedValue(fresh);
    expect(await createMcpInstallation(input, create)).toBe(fresh);
    expect(create.mock.calls.map(([body]) => body.name)).toEqual(["linear", "linear-3", "linear-4"]);
  });

  it("bounds retries and keeps suffixes within the name limit", async () => {
    vi.spyOn(browserApi, "mcpServers").mockResolvedValue({ servers: [] });
    const create = vi.fn().mockRejectedValue(conflict());
    await expect(createMcpInstallation({ ...input, name: "a".repeat(64) }, create)).rejects.toMatchObject({
      code: "MCP_SERVER_NAME_CONFLICT",
    });
    expect(create).toHaveBeenCalledTimes(3);
    expect(create.mock.calls.map(([body]) => body.name.length)).toEqual([64, 64, 64]);
  });

  it("does not retry unrelated errors", async () => {
    const pool = vi.spyOn(browserApi, "mcpServers");
    const error = new ApiError(503, "Unavailable");
    const create = vi.fn().mockRejectedValue(error);
    await expect(createMcpInstallation(input, create)).rejects.toBe(error);
    expect(create).toHaveBeenCalledTimes(1);
    expect(pool).not.toHaveBeenCalled();
  });
});
