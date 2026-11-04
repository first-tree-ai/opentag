import { MCP_ERROR_CODES } from "@opentag/shared/browser";
import { expect, it } from "vitest";
import { ApiError } from "../../../api.js";
import { catalogFailure } from "./mcp-catalog-feedback.js";

it("keeps upstream details private and preserves actionable failure reasons", () => {
  expect(catalogFailure(new ApiError(502, "Private upstream response"))).toBe("Couldn't load tools. Try again.");
  expect(catalogFailure(new TypeError("Failed to fetch"))).toBe("Can't reach the service. Try again later.");
  expect(catalogFailure(new TypeError("Invalid internal value"))).toBe("Couldn't load tools. Try again.");
  expect(catalogFailure(new ApiError(410, "Expired flow", MCP_ERROR_CODES.OAUTH_FLOW_EXPIRED))).toBe(
    "Authorization expired",
  );
});

it("reads a blocked catalog address as the connector being unavailable, not as an address to check", () => {
  expect(catalogFailure(new ApiError(400, "private", MCP_ERROR_CODES.URL_BLOCKED))).toBe(
    "Connector temporarily unavailable",
  );
});
