import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { App } from "../app.js";

const teamId = "d3fda800-7ce2-4338-aae8-3d2120401ed6";

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function me(role: "admin" | "member") {
  return {
    user: { id: "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e", email: "admin@example.com", displayName: "Ada" },
    memberships: [{ teamId, teamName: "example", teamDisplayName: "Example", role }],
  };
}

describe("Admin Web", () => {
  it("renders a Google login without exposing token storage controls", () => {
    window.history.replaceState({}, "", "/admin/login");
    render(<App />);
    expect(screen.getByRole("link", { name: "Continue with Google" }).getAttribute("href")).toBe(
      "/api/v1/auth/google/start?next=%2Fadmin",
    );
    expect(document.body.textContent).not.toContain("accessToken");
  });

  it("uses live memberships for the Team selector", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response(me("admin")));
    render(<App />);
    const link = await screen.findByRole("link", { name: /Example/ });
    expect(link.getAttribute("href")).toBe(`/admin/teams/${teamId}`);
  });

  it("shows an explicit forbidden page for a non-admin Team member", async () => {
    window.history.replaceState({}, "", `/admin/teams/${teamId}`);
    vi.mocked(fetch).mockResolvedValueOnce(response(me("member")));
    render(<App />);
    expect(await screen.findByText("Admin access required")).toBeTruthy();
    expect(screen.getByText(/current Team role is member/)).toBeTruthy();
  });
});
