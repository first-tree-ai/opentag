import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AgentIntegrationsPreview,
  AgentIntegrationsTab,
  AgentSkillsPreview,
  AgentSkillsTab,
} from "./agent-detail-capabilities.js";

describe("Agent detail capability previews", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("shows honest Integration preview identities, scope, and connection state", () => {
    render(
      <MemoryRouter>
        <AgentIntegrationsPreview />
      </MemoryRouter>,
    );

    expect(screen.getByText("Preview data")).toBeTruthy();
    expect(screen.getByText("GitHub")).toBeTruthy();
    expect(screen.getByText("opentag-preview")).toBeTruthy();
    expect(screen.getByText("opentag/preview-repository · read and pull requests")).toBeTruthy();
    expect(screen.getByText("Available")).toBeTruthy();
    expect(screen.getByText("Needs attention")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByText(/Feishu|Slack/)).toBeNull();
  });

  it("shows Skill preview source and assignment state with a real Workspace-list link", () => {
    render(
      <MemoryRouter>
        <AgentSkillsPreview />
      </MemoryRouter>,
    );

    expect(screen.getByText("Release notes writer")).toBeTruthy();
    expect(screen.getAllByText("Shared source")).toHaveLength(2);
    expect(screen.getAllByText("Assigned")).toHaveLength(2);
    expect(screen.getByText("Assignment unavailable")).toBeTruthy();
    expect(screen.getByRole("link", { name: "View Skills" }).getAttribute("href")).toBe("/skills");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("never exposes preview records on the production no-contract path", () => {
    vi.stubEnv("DEV", false);
    const { rerender } = render(
      <MemoryRouter>
        <AgentIntegrationsTab />
      </MemoryRouter>,
    );
    expect(screen.getByRole("heading", { name: "Agent Integrations are not available yet" })).toBeTruthy();
    expect(screen.getByText("No preview records are shown in production.")).toBeTruthy();
    expect(screen.queryByText("GitHub")).toBeNull();

    rerender(
      <MemoryRouter>
        <AgentSkillsTab />
      </MemoryRouter>,
    );
    expect(screen.getByRole("heading", { name: "Agent Skills are not available yet" })).toBeTruthy();
    expect(screen.queryByText("Release notes writer")).toBeNull();
  });

  it("keeps preview rendering behind an explicit availability gate", () => {
    vi.stubEnv("DEV", true);
    const { rerender } = render(
      <MemoryRouter>
        <AgentIntegrationsTab />
      </MemoryRouter>,
    );
    expect(screen.getByLabelText("Preview Agent integrations")).toBeTruthy();

    rerender(
      <MemoryRouter>
        <AgentSkillsTab />
      </MemoryRouter>,
    );
    expect(screen.getByLabelText("Preview Agent skills")).toBeTruthy();
  });
});
