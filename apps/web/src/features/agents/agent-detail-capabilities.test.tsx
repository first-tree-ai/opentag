import type { AgentSkillsResponse, ListSkillsResponse, SkillSummary } from "@opentag/shared/browser";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderInRouter } from "../../__tests__/support/router.js";
import { ApiError, browserApi } from "../../api.js";
import {
  AgentIntegrationsPreview,
  AgentIntegrationsTab,
  AgentSkillsPage,
  AgentSkillsTab,
} from "./agent-detail-capabilities.js";

const agentId = "1a63a21e-f6c7-4474-91ea-4dabf0566a24";
const digest = "b".repeat(64);
const releaseNotes = {
  name: "release-notes",
  description: "Turns merged changes into release notes",
  digest,
  archiveSha256: digest,
  archiveBytes: 2048,
  fileCount: 3,
  totalBytes: 4096,
  agentCount: 1,
  updatedAt: "2026-09-10T10:00:00.000Z",
  updatedBy: { kind: "user", id: "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e" },
} satisfies SkillSummary;
const triage = { ...releaseNotes, name: "issue-triage", description: "Classifies incoming issues", agentCount: 0 };
const library: ListSkillsResponse = { skills: [releaseNotes, triage], nextCursor: null };
const assignment = { agentId, digest, skills: [releaseNotes] } satisfies AgentSkillsResponse;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("Agent Skills assignment", () => {
  it("lists the library with checkboxes reflecting the Agent's assignment", async () => {
    vi.spyOn(browserApi, "skills").mockResolvedValue(library);
    vi.spyOn(browserApi, "agentSkills").mockResolvedValue(assignment);
    await renderInRouter(<AgentSkillsPage agentId={agentId} />);

    expect(await screen.findByText("1 of 2 assigned")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Skills" })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: /release-notes/ }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("checkbox", { name: /issue-triage/ }).getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText("Only assigned skills are synced to this Agent's workspace on its Computer.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "View Skills" }).getAttribute("href")).toBe("/skills");
    expect(screen.queryByText("Preview data")).toBeNull();
    expect(screen.queryByText("Release notes writer")).toBeNull();
  });

  it("sends the whole resulting set when a skill is assigned or unassigned", async () => {
    vi.spyOn(browserApi, "skills").mockResolvedValue(library);
    vi.spyOn(browserApi, "agentSkills").mockResolvedValue(assignment);
    const replace = vi
      .spyOn(browserApi, "replaceAgentSkills")
      .mockResolvedValueOnce({ ...assignment, skills: [triage, releaseNotes] })
      .mockResolvedValueOnce({ ...assignment, skills: [triage] });
    await renderInRouter(<AgentSkillsTab agentId={agentId} />);
    await screen.findByText("1 of 2 assigned");

    fireEvent.click(screen.getByRole("checkbox", { name: /issue-triage/ }));
    await waitFor(() => expect(replace).toHaveBeenCalledWith(agentId, ["issue-triage", "release-notes"]));
    expect(await screen.findByText("2 of 2 assigned")).toBeTruthy();

    fireEvent.click(screen.getByRole("checkbox", { name: /release-notes/ }));
    await waitFor(() => expect(replace).toHaveBeenCalledWith(agentId, ["issue-triage"]));
    expect(await screen.findByText("1 of 2 assigned")).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: /release-notes/ }).getAttribute("aria-checked")).toBe("false");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps the last saved assignment and reports a refused save", async () => {
    vi.spyOn(browserApi, "skills").mockResolvedValue(library);
    vi.spyOn(browserApi, "agentSkills").mockResolvedValue(assignment);
    vi.spyOn(browserApi, "replaceAgentSkills").mockRejectedValue(
      new ApiError(400, "Unknown skill: issue-triage", "SKILL_NOT_FOUND"),
    );
    await renderInRouter(<AgentSkillsTab agentId={agentId} />);
    await screen.findByText("1 of 2 assigned");

    fireEvent.click(screen.getByRole("checkbox", { name: /issue-triage/ }));
    expect((await screen.findByRole("alert")).textContent).toContain("Unknown skill: issue-triage");
    expect(screen.getByRole("checkbox", { name: /issue-triage/ }).getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText("1 of 2 assigned")).toBeTruthy();
  });

  it("explains an empty library and a failed read", async () => {
    vi.spyOn(browserApi, "skills").mockResolvedValue({ skills: [], nextCursor: null });
    vi.spyOn(browserApi, "agentSkills").mockResolvedValue({ ...assignment, skills: [] });
    const { rerender } = await renderInRouter(<AgentSkillsTab agentId={agentId} />);
    expect(await screen.findByText(/The skill library is empty/)).toBeTruthy();

    vi.spyOn(browserApi, "agentSkills").mockRejectedValue(new ApiError(404, "Agent not found"));
    rerender(<AgentSkillsTab agentId="2b74b32f-a7d8-4585-92fb-5ecbf1677b35" />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Skills could not be loaded.");
    expect(alert.textContent).toContain("Agent not found");
  });
});

describe("Agent detail Integration preview", () => {
  it("shows honest Integration preview identities, scope, and connection state", async () => {
    await renderInRouter(<AgentIntegrationsPreview />);

    expect(screen.getByText("Preview data")).toBeTruthy();
    expect(screen.getByText("GitHub")).toBeTruthy();
    expect(screen.getByText("opentag-preview")).toBeTruthy();
    expect(screen.getByText("opentag/preview-repository · read and pull requests")).toBeTruthy();
    expect(screen.getByText("Available")).toBeTruthy();
    expect(screen.getByText("Connection error")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByText(/Feishu|Lark|Slack/)).toBeNull();
  });

  it("never exposes preview records on the production no-contract path", async () => {
    vi.stubEnv("DEV", false);
    await renderInRouter(<AgentIntegrationsTab />);
    expect(screen.getByRole("heading", { name: "Agent Integrations are not available yet" })).toBeTruthy();
    expect(screen.getByText("No preview records are shown in production.")).toBeTruthy();
    expect(screen.queryByText("GitHub")).toBeNull();
  });

  it("keeps preview rendering behind an explicit availability gate", async () => {
    vi.stubEnv("DEV", true);
    await renderInRouter(<AgentIntegrationsTab />);
    expect(screen.getByLabelText("Preview Agent integrations")).toBeTruthy();
  });
});
