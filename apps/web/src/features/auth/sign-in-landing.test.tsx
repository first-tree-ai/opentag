import { DEFAULT_SIGN_IN_DESTINATION, resolveSignInDestination } from "@opentag/shared/browser";
import { render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderInRouter } from "../../__tests__/support/router.js";
import { isServerDestination, SignInLanding } from "./sign-in-landing.js";

/**
 * Where a completed sign-in sends the browser.
 *
 * The distinction is not cosmetic: the router only reaches paths it has a route for, so a server route
 * navigated to client-side never issues its request. The MCP OAuth handoff is such a route, and
 * skipping it leaves the Agent's flow unredeemed — which is what an already-signed-in visitor hit
 * before this decision existed.
 */
describe("sign-in landing", () => {
  it("recognizes a server route", () => {
    expect(isServerDestination("/api/v1/mcp-servers/oauth/handoff?token=abc")).toBe(true);
    expect(isServerDestination("/api/v1/auth/google/start")).toBe(true);
    for (const page of [DEFAULT_SIGN_IN_DESTINATION, "/settings/profile", "/account", "/login"]) {
      expect(isServerDestination(page), page).toBe(false);
    }
  });

  it("navigates the document for a server route so the request is actually sent", async () => {
    const navigate = vi.fn();
    const destination = "/api/v1/mcp-servers/oauth/handoff?token=sealed";
    render(<SignInLanding destination={destination} navigate={navigate} />);
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(destination));
  });

  it("keeps a page destination on the client-side router", async () => {
    const navigate = vi.fn();
    const destination = "/agents?tab=all";
    await renderInRouter(<SignInLanding destination={destination} navigate={navigate} />);
    // A router navigation is not a document navigation, so the injected document writer stays unused.
    expect(navigate).not.toHaveBeenCalled();
  });

  it("accepts the handoff destination the way the page resolves it", () => {
    /*
     * The page resolves `next` through this function before landing on it, so the rule is asserted
     * here too: a long generated handoff is a valid destination, and a short server path is only
     * reachable through the allowlist.
     */
    const token = "A".repeat(1216);
    const destination = `/api/v1/mcp-servers/oauth/handoff?token=${token}`;
    expect(resolveSignInDestination(destination)).toBe(destination);
    expect(isServerDestination(destination)).toBe(true);
  });
});
