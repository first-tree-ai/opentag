import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { IntegrationsPage } from "../features/integrations-page.js";
import { ResourcesPage } from "../features/resources-page.js";
import { UsagePage } from "../features/usage-page.js";

describe("capability entry pages", () => {
  it("renders Resources as an explicit demo and filters the static resource list", () => {
    render(<ResourcesPage />);

    expect(screen.getByRole("heading", { name: "Resources" })).toBeTruthy();
    expect(screen.getByText("Demo data preview")).toBeTruthy();
    expect(screen.getByText("OpenTag workspace")).toBeTruthy();
    expect(screen.getByText("Release notes writer")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Skills" }));

    expect(screen.getByText("Release notes writer")).toBeTruthy();
    expect(screen.queryByText("OpenTag workspace")).toBeNull();
    expect(screen.getByRole("button", { name: "Skills" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("keeps resource creation visibly unavailable", () => {
    render(<ResourcesPage />);

    const addResource = screen.getByRole("button", {
      name: "Add resource (Coming soon)",
    }) as HTMLButtonElement;
    expect(addResource.disabled).toBe(true);
    expect(addResource.textContent).toContain("Coming soon");
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
