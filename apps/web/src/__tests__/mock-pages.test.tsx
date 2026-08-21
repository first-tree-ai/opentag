import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { IntegrationsPage } from "../features/integrations-page.js";
import { SkillsPage } from "../features/skills-page.js";
import { UsagePage } from "../features/usage-page.js";

describe("capability entry pages", () => {
  it("renders a minimal static Skills demo without unavailable controls", () => {
    render(<SkillsPage />);

    expect(screen.getByRole("heading", { name: "Skills" })).toBeTruthy();
    expect(screen.getByText("Demo data")).toBeTruthy();
    expect(screen.getByText("Release notes writer")).toBeTruthy();
    expect(screen.getByText("Browser validation")).toBeTruthy();
    expect(screen.getByText("Issue triage")).toBeTruthy();
    expect(screen.getAllByText("Demo")).toHaveLength(3);
    expect(screen.getAllByRole("columnheader").map((header) => header.textContent)).toEqual([
      "Name",
      "Source",
      "Used by",
      "Status",
    ]);
    expect(screen.queryByText("Repositories")).toBeNull();
    expect(screen.queryByText("Tools")).toBeNull();
    expect(screen.queryByText("Prompts")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("keeps Integrations truthful until a Workspace Integration contract exists", () => {
    render(<IntegrationsPage />);

    expect(screen.getByRole("heading", { name: "Integrations" })).toBeTruthy();
    expect(screen.getByText("Coming later")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Workspace Integrations are not available yet" })).toBeTruthy();
    expect(screen.getByText(/Provider Bot connections remain managed/)).toBeTruthy();
    expect(screen.queryByText("GitHub")).toBeNull();
    expect(screen.queryByText("Connected")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("updates the Usage overview when the demo range changes", () => {
    render(<UsagePage />);

    expect(screen.getByText("Demo data preview")).toBeTruthy();
    const metrics = screen.getByLabelText("Usage metrics");
    expect(within(metrics).getByText("146")).toBeTruthy();
    expect(within(metrics).getByText("728")).toBeTruthy();
    expect(screen.getByRole("img").getAttribute("aria-label")).toContain("30 days");

    fireEvent.change(screen.getByLabelText("Time range"), { target: { value: "7 days" } });

    expect(within(metrics).getByText("38")).toBeTruthy();
    expect(within(metrics).getByText("184")).toBeTruthy();
    expect(screen.getByRole("img").getAttribute("aria-label")).toContain("7 days");
  });
});
