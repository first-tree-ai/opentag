import { MCP_ERROR_CODES } from "@opentag/shared/browser";
import { expect, it } from "vitest";
import { ApiError } from "../../../api.js";
import { catalogFailure } from "./mcp-catalog-feedback.js";

it("keeps upstream details private and preserves actionable failure reasons", () => {
  expect(catalogFailure(new ApiError(502, "Private upstream response"))).toBe("Connection failed");
  expect(catalogFailure(new TypeError("Failed to fetch"))).toBe("Network error");
  expect(catalogFailure(new TypeError("Invalid internal value"))).toBe("Connection failed");
  expect(catalogFailure(new ApiError(410, "Expired flow", MCP_ERROR_CODES.OAUTH_FLOW_EXPIRED))).toBe(
    "Authorization expired",
  );
});
