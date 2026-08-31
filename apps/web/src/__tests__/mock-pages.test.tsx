import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IntegrationsPage } from "../features/integrations-page.js";
import { SkillsPage } from "../features/skills-page.js";

describe("capability entry pages", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("renders a minimal interactive Skills demo", () => {
    render(<SkillsPage />);

    expect(screen.getByRole("heading", { name: "Skills" })).toBeTruthy();
    expect(screen.getByText("Demo data")).toBeTruthy();
    expect(screen.getByText("Release notes writer")).toBeTruthy();
    expect(screen.getByText("Browser validation")).toBeTruthy();
    expect(screen.getByText("Issue triage")).toBeTruthy();
    expect(screen.getAllByText("Demo")).toHaveLength(3);
    expect(screen.getByRole("heading", { name: "All skills" })).toBeTruthy();
    expect(screen.getAllByRole("article")).toHaveLength(3);
    expect(screen.getByRole("button", { name: "Upload skill" })).toBeTruthy();
    expect(screen.getByText("Built by OpenTag")).toBeTruthy();
    expect(screen.queryByText("Workspace")).toBeNull();
    expect(screen.queryByText("Repositories")).toBeNull();
    expect(screen.queryByText("Tools")).toBeNull();
    expect(screen.queryByText("Prompts")).toBeNull();

    fireEvent.change(screen.getByLabelText("Skill file"), {
      target: { files: [new File(["# Skill"], "release-notes.md", { type: "text/markdown" })] },
    });
    expect(screen.getByRole("status").textContent).toBe("release-notes.md selected · Demo only, not uploaded");
  });

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
    expect(screen.queryByText("Connected")).toBeNull();
    expect(screen.queryByText("Agents with access")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
