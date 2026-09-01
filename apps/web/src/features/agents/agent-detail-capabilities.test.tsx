import { screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderInRouter } from "../../__tests__/support/router.js";
import {
  AgentIntegrationsPreview,
  AgentIntegrationsTab,
  AgentSkillsPreview,
  AgentSkillsTab,
} from "./agent-detail-capabilities.js";

describe("Agent detail capability previews", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("shows honest Integration preview identities, scope, and connection state", async () => {
    await renderInRouter(<AgentIntegrationsPreview />);

    expect(screen.getByText("Preview data")).toBeTruthy();
    expect(screen.getByText("GitHub")).toBeTruthy();
    expect(screen.getByText("opentag-preview")).toBeTruthy();
    expect(screen.getByText("opentag/preview-repository · read and pull requests")).toBeTruthy();
    expect(screen.getByText("Available")).toBeTruthy();
    expect(screen.getByText("Connection error")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByText(/Feishu|Slack/)).toBeNull();
  });

  it("shows Skill preview source and assignment state with a real Skills-list link", async () => {
    await renderInRouter(<AgentSkillsPreview />);

    expect(screen.getByText("Release notes writer")).toBeTruthy();
    expect(screen.getAllByText("Shared source")).toHaveLength(2);
    expect(screen.getAllByText("Assigned")).toHaveLength(2);
    expect(screen.getByText("Assignment unavailable")).toBeTruthy();
    expect(screen.getByRole("link", { name: "View Skills" }).getAttribute("href")).toBe("/skills");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("never exposes preview records on the production no-contract path", async () => {
    vi.stubEnv("DEV", false);
    const { rerender } = await renderInRouter(<AgentIntegrationsTab />);
    expect(screen.getByRole("heading", { name: "Agent Integrations are not available yet" })).toBeTruthy();
    expect(screen.getByText("No preview records are shown in production.")).toBeTruthy();
    expect(screen.queryByText("GitHub")).toBeNull();

    rerender(<AgentSkillsTab />);
    expect(screen.getByRole("heading", { name: "Agent Skills are not available yet" })).toBeTruthy();
    expect(screen.queryByText("Release notes writer")).toBeNull();
  });

  it("keeps preview rendering behind an explicit availability gate", async () => {
    vi.stubEnv("DEV", true);
    const { rerender } = await renderInRouter(<AgentIntegrationsTab />);
    expect(screen.getByLabelText("Preview Agent integrations")).toBeTruthy();

    rerender(<AgentSkillsTab />);
    expect(screen.getByLabelText("Preview Agent skills")).toBeTruthy();
  });
});
