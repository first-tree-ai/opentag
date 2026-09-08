import { describe, expect, it } from "vitest";
import { analyticsPageLocation, analyticsPagePath, analyticsPageReferrer } from "./page-location.js";

describe("analytics page location", () => {
  it("reduces identifier-bearing paths to a route template", () => {
    expect(
      analyticsPagePath("/agents/6f1b3c2e-9d4a-4f8b-8a11-2c3d4e5f6a7b/tasks/11112222-3333-4444-8555-666677778888"),
    ).toBe("/agents/:id/tasks/:id");
    expect(analyticsPagePath("/agents")).toBe("/agents");
  });

  it("drops every query parameter that is not a campaign parameter", () => {
    const location = analyticsPageLocation(
      "https://opentag.example/login?next=%2Fagents%2F6f1b3c2e-9d4a-4f8b-8a11-2c3d4e5f6a7b&utm_source=newsletter&slack_oauth_error=denied#section",
    );

    expect(location).toBe("https://opentag.example/login?utm_source=newsletter");
    expect(location).not.toContain("6f1b3c2e");
    expect(location).not.toContain("slack_oauth_error");
    expect(location).not.toContain("section");
  });

  it("keeps the identifiers out of the location itself, not only out of the query", () => {
    expect(analyticsPageLocation("https://opentag.example/agents/6f1b3c2e-9d4a-4f8b-8a11-2c3d4e5f6a7b/settings")).toBe(
      "https://opentag.example/agents/:id/settings",
    );
  });

  it("reduces an opaque segment that is neither a uuid nor an integer", () => {
    // `/invites/<token>` is a real route, and the token grants access to an Account. `routeTemplate`
    // alone does not catch it, which is why this pass exists.
    const token = "A".repeat(43);
    expect(analyticsPagePath(`/invites/${token}`)).toBe("/invites/:id");
    expect(analyticsPageLocation(`https://opentag.example/invites/${token}`)).toBe(
      "https://opentag.example/invites/:id",
    );
    expect(analyticsPageLocation(`https://opentag.example/invites/${token}`)).not.toContain(token);
  });

  it("leaves this application's own route names alone", () => {
    for (const path of ["/", "/login", "/agents", "/agents/setup", "/agents/computers", "/internal/agent-setup"]) {
      expect(analyticsPagePath(path)).toBe(path);
    }
    expect(analyticsPagePath("/agents/6f1b3c2e-9d4a-4f8b-8a11-2c3d4e5f6a7b/settings/messaging")).toBe(
      "/agents/:id/settings/messaging",
    );
  });

  it("returns nothing for a value that is not a URL", () => {
    expect(analyticsPageLocation("")).toBeUndefined();
    expect(analyticsPageLocation("not a url")).toBeUndefined();
  });

  it("sanitizes a same-origin referrer and reduces a foreign one to its origin", () => {
    const origin = "https://opentag.example";

    expect(analyticsPageReferrer(`${origin}/agents/6f1b3c2e-9d4a-4f8b-8a11-2c3d4e5f6a7b`, origin)).toBe(
      `${origin}/agents/:id`,
    );
    expect(analyticsPageReferrer("https://mail.example/inbox/thread?token=secret", origin)).toBe(
      "https://mail.example",
    );
    expect(analyticsPageReferrer("", origin)).toBeUndefined();
  });
});
