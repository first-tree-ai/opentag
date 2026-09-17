import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
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
    expect(screen.getByRole("heading", { name: "All skills" })).toBeTruthy();
    expect(screen.getAllByRole("article")).toHaveLength(3);
    expect(screen.getByRole("button", { name: /Upload skill/ }).getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByText("Built by OpenTag")).toBeTruthy();
    expect(screen.getAllByText("Shared")).toHaveLength(2);
    expect(screen.queryByText("Workspace")).toBeNull();
    expect(screen.queryByText("Repositories")).toBeNull();
    expect(screen.queryByText("Tools")).toBeNull();
    expect(screen.queryByText("Prompts")).toBeNull();

    expect(screen.queryByText("Instructions preview")).toBeNull();
    const previewButton = screen.getAllByRole("button", { name: "Preview" })[0];
    if (!previewButton) throw new Error("Expected at least one Skill preview button");
    fireEvent.click(previewButton);
    expect(screen.getByText("Instructions preview")).toBeTruthy();
  });
});
