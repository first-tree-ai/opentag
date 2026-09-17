import { describe, expect, it } from "vitest";
import { probedServerDescription } from "../mcp.js";

/**
 * The Server's own description, read out of the `serverInfo` a probe recorded.
 *
 * This is derived on read rather than stored, so the only thing that can be wrong here is the
 * extraction: `server_info` is jsonb written from a peer's response and read back by a later build,
 * which means every input below is untrusted and most of them are not the specification's
 * `Implementation` shape at all.
 */
describe("probedServerDescription", () => {
  it("reads the description out of a specification-shaped serverInfo", () => {
    expect(probedServerDescription({ name: "linear", version: "1.2.0", description: "Issue tracking" })).toBe(
      "Issue tracking",
    );
  });

  it("returns null when the Server omitted the field, since it is optional in the specification", () => {
    expect(probedServerDescription({ name: "linear", version: "1.2.0" })).toBeNull();
    expect(probedServerDescription({ name: "linear", description: "" })).toBeNull();
    expect(probedServerDescription({ name: "linear", description: "   " })).toBeNull();
  });

  it("returns null for every value that is not an object with a string description", () => {
    for (const value of [null, undefined, "Issue tracking", 42, true, [], [1, 2], { description: 42 }]) {
      expect(probedServerDescription(value)).toBeNull();
    }
  });

  it("trims the value and bounds it to the column's 1024 characters", () => {
    expect(probedServerDescription({ description: "  Issue tracking  " })).toBe("Issue tracking");
    expect(probedServerDescription({ description: "x".repeat(5000) })).toHaveLength(1024);
  });

  it("ignores a nested description, which belongs to some other object", () => {
    expect(probedServerDescription({ name: "linear", nested: { description: "Issue tracking" } })).toBeNull();
  });
});
