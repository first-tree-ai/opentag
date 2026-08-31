import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../app.js";
import { agentId, installApi, resetWebAppState } from "./support/app-fixtures.js";

describe("OpenTag Web App Shell", () => {
  beforeEach(resetWebAppState);

  it("keeps authenticated invalid Agent tabs on the plain workspace canvas", async () => {
    installApi();
    window.history.replaceState({}, "", `/agents/${agentId}/unknown`);
    render(<App />);

    const heading = await screen.findByRole("heading", { name: "Page not found" });
    expect(heading.closest('[data-ui="not-found"]')).toBeTruthy();
    expect(screen.getByRole("main").getAttribute("data-ui")).not.toBe("not-found");
  });

  it("keeps the standalone not-found route on the decorative canvas", async () => {
    window.history.replaceState({}, "", "/unknown");
    render(<App />);

    const heading = await screen.findByRole("heading", { name: "Page not found" });
    expect(heading.closest("main")?.getAttribute("data-ui")).toBe("not-found");
  });

  it.each(["/workspace", "/admins", `/invites/${"A".repeat(43)}`])(
    "does not preserve retired Workspace product route %s",
    async (path) => {
      window.history.replaceState({}, "", path);
      render(<App />);
      expect(await screen.findByRole("heading", { name: "Page not found" })).toBeTruthy();
      expect(window.location.pathname).toBe(path);
      expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    },
  );

  it("redirects legacy Agent URLs without keeping the old UI", async () => {
    installApi();
    window.history.replaceState({}, "", `/agents/${agentId}/runtime`);
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Model & reasoning" })).toBeTruthy();
    expect(window.location.pathname).toBe(`/agents/${agentId}/settings/execution`);
    expect(screen.queryByText("Runtime")).toBeNull();
  });

  it.each([
    ["integrations", "Integrations"],
    ["skills", "Skills"],
  ])("keeps Agent %s inside the selected Agent boundary", async (section, heading) => {
    installApi();
    window.history.replaceState({}, "", `/agents/${agentId}/${section}`);
    render(<App />);

    expect(await screen.findByRole("heading", { name: heading })).toBeTruthy();
    expect(window.location.pathname).toBe(`/agents/${agentId}/${section}`);
    expect(screen.getByRole("complementary", { name: "Agent navigation" })).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: section === "skills" ? "Skills" : "Integrations" })
        .getAttribute("aria-current"),
    ).toBe("page");
  });

  it("does not preserve the removed Agent Access surface", async () => {
    installApi();
    window.history.replaceState({}, "", `/agents/${agentId}/access`);
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Page not found" })).toBeTruthy();
    expect(window.location.pathname).toBe(`/agents/${agentId}/access`);
  });

  it("removes the old admin product shell without a redirect", async () => {
    window.history.replaceState({}, "", "/admin");
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Page not found" })).toBeTruthy();
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});
