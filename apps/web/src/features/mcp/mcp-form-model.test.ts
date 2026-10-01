import { describe, expect, it } from "vitest";
import { serverNameFromUrl, suggestServerName } from "./mcp-form-model.js";

describe("serverNameFromUrl", () => {
  it.each([
    ["http://mcp.internal", "internal"],
    ["https://mcp.local", "local"],
    ["https://www.mcp.io", "io"],
    ["https://api.example.com", "api-example"],
    ["https://www.mcp", "server"],
  ])("suggests %s as %s", (url, expected) => {
    expect(serverNameFromUrl(url)).toBe(expected);
  });
});

describe("suggestServerName", () => {
  it("keeps the base name when it is available", () => {
    expect(suggestServerName("https://api.example.com", [])).toBe("api-example");
  });

  it("uses the first available numbered suffix", () => {
    expect(
      suggestServerName("https://api.example.com", [
        { name: "api-example" },
        { name: "api-example-2" },
        { name: "api-example-4" },
      ]),
    ).toBe("api-example-3");
  });
});
