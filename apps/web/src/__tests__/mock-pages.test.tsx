import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IntegrationsPage } from "../features/integrations-page.js";

describe("capability entry pages", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("renders an explicitly labeled Integrations mock in production mode", () => {
    vi.stubEnv("DEV", false);
    render(<IntegrationsPage />);

    expect(screen.getByRole("heading", { name: "Integrations" })).toBeTruthy();
    expect(screen.getByText("Demo data")).toBeTruthy();
    expect(screen.getByText("GitHub")).toBeTruthy();
    expect(screen.getByText("Google Drive")).toBeTruthy();
    expect(screen.getAllByText("Demo")).toHaveLength(6);
    expect(screen.getByText("Scroll horizontally to see category and status.")).toBeTruthy();
    const scrollRegion = screen.getByRole("region", { name: "Integrations table" });
    expect(scrollRegion.tabIndex).toBe(0);
    expect(scrollRegion.getAttribute("aria-describedby")).toBe("integrations-scroll-hint");
    const table = screen.getByRole("table", { name: "Demo Integrations" });
    expect(table.closest('[data-ui="integrations-card"]')).toBeTruthy();
    expect(screen.getAllByRole("columnheader").map((header) => header.textContent)).toEqual([
      "Name",
      "Category",
      "Status",
    ]);
    expect(
      screen.getByRole("cell", { name: "GitHub. Read repositories, issues, pull requests, and checks." }),
    ).toBeTruthy();
    expect(screen.getByText("GitHub").tagName).toBe("STRONG");
    expect(table.querySelectorAll("tbody tr")).toHaveLength(6);
    const marks = table.querySelectorAll('[data-ui="integration-mark"]');
    expect(marks).toHaveLength(6);
    expect(Array.from(marks).map((mark) => mark.getAttribute("data-integration"))).toEqual([
      "github",
      "google-drive",
      "linear",
      "notion",
      "sentry",
      "figma",
    ]);
    for (const mark of marks) {
      const image = mark.querySelector("img");
      expect(image?.getAttribute("alt")).toBe("");
      expect(image?.getAttribute("height")).toBe("20");
      expect(image?.getAttribute("width")).toBe("20");
    }
    expect(screen.queryByText("Connected")).toBeNull();
    expect(screen.queryByText("Agents with access")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
