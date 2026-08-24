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

  it("renders an explicitly labeled Integrations mock", () => {
    render(<IntegrationsPage />);

    expect(screen.getByRole("heading", { name: "Integrations" })).toBeTruthy();
    expect(screen.getByText("Demo data")).toBeTruthy();
    expect(screen.getByText("GitHub")).toBeTruthy();
    expect(screen.getByText("Google Drive")).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "Connected" })).getAllByText("Connected")).toHaveLength(3);
    expect(screen.getAllByRole("button", { name: "Manage" })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "Connect" })).toHaveLength(4);
  });

  it("filters the Integrations mock and exposes preview-only connection details", () => {
    render(<IntegrationsPage />);

    fireEvent.change(screen.getByLabelText("Search integrations"), { target: { value: "errors" } });
    expect(screen.getByText("Sentry")).toBeTruthy();
    expect(screen.queryByText("GitHub")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Connect Sentry" })).toBeTruthy();
    expect(screen.getByText("Preview only")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Continue" }).hasAttribute("disabled")).toBe(true);
  });

  it("renders the fixed 30-day Usage overview without a range control", () => {
    render(<UsagePage />);

    expect(screen.getByText("Demo data preview")).toBeTruthy();
    const metrics = screen.getByLabelText("Usage metrics");
    expect(within(metrics).getByText("146")).toBeTruthy();
    expect(within(metrics).getByText("728")).toBeTruthy();
    expect(screen.getByRole("img").getAttribute("aria-label")).toContain("30 days");

    expect(screen.queryByLabelText("Time range")).toBeNull();
    expect(metrics.closest(".capability-usage-summary")).toBeTruthy();
    expect(document.querySelector(".capability-section-heading > span")).toBeNull();
    expect(screen.getByText("Turns completed during the last 30 days.")).toBeTruthy();
  });
});
