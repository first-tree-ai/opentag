import { describe, expect, it } from "vitest";
import { analyticsEnabled, isMeasuredHost } from "./config.js";

describe("analytics switch", () => {
  it("refuses every loopback origin", () => {
    for (const host of ["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]", "app.localhost", "LOCALHOST"]) {
      expect(isMeasuredHost(host)).toBe(false);
    }
  });

  it("measures a deployed host", () => {
    expect(isMeasuredHost("opentag.build")).toBe(true);
    expect(isMeasuredHost("staging.opentag.build")).toBe(true);
  });

  it("refuses an empty host rather than guessing", () => {
    expect(isMeasuredHost("")).toBe(false);
  });

  it("is off under test, which is what keeps every other suite from reporting", () => {
    expect(analyticsEnabled({ location: { hostname: "opentag.build" } } as Window)).toBe(false);
  });
});
