import { describe, expect, it } from "vitest";
import { analyticsLocation, analyticsReferrerOrigin, analyticsRoutePath, NOT_FOUND_PATH } from "./page-location.js";

describe("analytics page location", () => {
  it("projects a route's declared parameters, keeping the name the route file gave them", () => {
    expect(analyticsRoutePath("/agents/$agentId/tasks/$taskId")).toBe("/agents/:agentId/tasks/:taskId");
    expect(analyticsRoutePath("/agents/$agentId/settings/$section")).toBe("/agents/:agentId/settings/:section");
    expect(analyticsRoutePath("/agents")).toBe("/agents");
    expect(analyticsRoutePath("/")).toBe("/");
    expect(analyticsRoutePath("/agents/")).toBe("/agents");
    expect(analyticsRoutePath("/files/$")).toBe("/files/:splat");
  });

  it("builds a location from an origin and a template, keeping campaign parameters", () => {
    expect(analyticsLocation("https://app.opentag.build", "/agents/:agentId", "?utm_source=newsletter")).toBe(
      "https://app.opentag.build/agents/:agentId?utm_source=newsletter",
    );
  });

  it("drops every query parameter that is not a campaign parameter", () => {
    const location = analyticsLocation(
      "https://app.opentag.build",
      "/login",
      "?next=%2Fagents%2F6f1b3c2e-9d4a-4f8b-8a11-2c3d4e5f6a7b&utm_source=newsletter&slack_oauth_error=denied",
    );

    expect(location).toBe("https://app.opentag.build/login?utm_source=newsletter");
    expect(location).not.toContain("6f1b3c2e");
    expect(location).not.toContain("slack_oauth_error");
  });

  it("refuses a campaign value that is address-shaped or implausibly long", () => {
    // Allowlisting the key does not make the value trusted: it is written by whoever built the link.
    expect(analyticsLocation("https://app.opentag.build", "/", "?utm_source=alice@example.com")).toBe(
      "https://app.opentag.build/",
    );
    expect(analyticsLocation("https://app.opentag.build", "/", `?utm_campaign=${"x".repeat(101)}`)).toBe(
      "https://app.opentag.build/",
    );
    expect(analyticsLocation("https://app.opentag.build", "/", "?utm_campaign=launch")).toContain(
      "utm_campaign=launch",
    );
  });

  it("names a referring site by origin and nothing more", () => {
    expect(analyticsReferrerOrigin("https://mail.example/inbox/thread?token=secret")).toBe("https://mail.example");
    expect(analyticsReferrerOrigin("")).toBeUndefined();
    expect(analyticsReferrerOrigin("not a url")).toBeUndefined();
  });

  it("reports an opaque referrer as nothing rather than as the string null", () => {
    // An Android app or an `about:` document produces `origin === "null"`.
    expect(analyticsReferrerOrigin("about:blank")).toBeUndefined();
    expect(analyticsReferrerOrigin("android-app://com.example.app")).toBeUndefined();
  });

  it("names one constant path for anything the router did not match", () => {
    expect(NOT_FOUND_PATH).toBe("/(not-found)");
  });
});
