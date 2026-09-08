import { describe, expect, it } from "vitest";
import { analyticsEnabled, analyticsTrafficType, isMeasuredHost } from "./config.js";

describe("analytics switch", () => {
  it("measures this site and its subdomains", () => {
    // app.opentag.build is what serves readers; the rest is the marketing site and staging.
    expect(isMeasuredHost("app.opentag.build")).toBe(true);
    expect(isMeasuredHost("opentag.build")).toBe(true);
    expect(isMeasuredHost("www.opentag.build")).toBe(true);
    expect(isMeasuredHost("staging.opentag.build")).toBe(true);
    expect(isMeasuredHost("APP.OPENTAG.BUILD")).toBe(true);
  });

  it("calls everything but the production host internal traffic", () => {
    expect(analyticsTrafficType("app.opentag.build")).toBeUndefined();
    expect(analyticsTrafficType("APP.OPENTAG.BUILD")).toBeUndefined();
    // Staging shares the property, so it has to say so or it fuses into every production number.
    expect(analyticsTrafficType("staging.opentag.build")).toBe("internal");
    expect(analyticsTrafficType("opentag.build")).toBe("internal");
  });

  it("refuses every loopback origin, which is what the end-to-end stack and a local preview serve", () => {
    for (const host of ["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]", "app.localhost", "LOCALHOST"]) {
      expect(isMeasuredHost(host)).toBe(false);
    }
  });

  it("measures nobody else's deployment", () => {
    // OpenTag is open source and meant to be self-hosted. Excluding only loopback would report a
    // self-hoster's readers into this property, which nobody asked for and nobody here wants.
    for (const host of ["opentag.example.com", "agents.acme.internal", "opentag.build.evil.test"]) {
      expect(isMeasuredHost(host)).toBe(false);
    }
  });

  it("refuses an empty host rather than guessing", () => {
    expect(isMeasuredHost("")).toBe(false);
  });

  it("is off under test, which is what keeps every other suite from reporting", () => {
    expect(analyticsEnabled({ location: { hostname: "opentag.build" } } as Window)).toBe(false);
  });
});
