import {
  MAX_UNKNOWN_KEY_PASSES as SHARED_MAX_UNKNOWN_KEY_PASSES,
  parseResponseIgnoringUnknownKeys as sharedParseResponseIgnoringUnknownKeys,
} from "@opentag/shared";
import { describe, expect, it } from "vitest";
import { MAX_UNKNOWN_KEY_PASSES, parseResponseIgnoringUnknownKeys } from "../response-parse.js";

describe("client response-parse re-exports", () => {
  it("re-exports parseResponseIgnoringUnknownKeys and MAX_UNKNOWN_KEY_PASSES from @opentag/shared", () => {
    expect(MAX_UNKNOWN_KEY_PASSES).toBe(SHARED_MAX_UNKNOWN_KEY_PASSES);
    expect(parseResponseIgnoringUnknownKeys).toBe(sharedParseResponseIgnoringUnknownKeys);
  });
});
