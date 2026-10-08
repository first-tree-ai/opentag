import type { InstallSkillPresetResponse, ListSkillPresetsResponse, Skill } from "@opentag/shared/browser";
import { SKILL_ERROR_CODES } from "@opentag/shared/browser";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, browserApi } from "../../api.js";
import { SkillPresetDialog } from "./skill-preset-dialog.js";

/**
 * The preset dialog's contract: the catalog is rendered with the state the Server computed, search
 * overrides the tabs, a write is a named install, and a conflict is explained rather than offered.
 */

const AGENT_ID = "1a63a21e-f6c7-4474-91ea-4dabf0566a24";
const SKILL_ID = "9d4e1378-8ff2-4e41-a6dd-e8bf59ed775b";

function preset(overrides: Partial<ListSkillPresetsResponse["presets"][number]> = {}) {
  return {
    name: "mcp-onboarding",
    description: "Add MCP tools to this Agent",
    category: "getting-started" as const,
    order: 10,
    archiveSha256: "a".repeat(64),
    archiveBytes: 2048,
    fileCount: 2,
    state: "not_installed" as const,
    ...overrides,
  };
}

function catalog(overrides: Partial<ListSkillPresetsResponse> = {}): ListSkillPresetsResponse {
  return {
    categories: [
      { id: "getting-started", order: 10 },
      { id: "engineering", order: 20 },
    ],
    presets: [
      preset(),
      preset({ name: "mcp-catalog-entry", category: "engineering", description: "Record a remote MCP Server" }),
    ],
    ...overrides,
  };
}

function installedSkill(): Skill {
  return {
    id: SKILL_ID,
    agentId: AGENT_ID,
    name: "mcp-onboarding",
    description: "Add MCP tools to this Agent",
    enabled: true,
    source: "preset",
    archiveSha256: "b".repeat(64),
    archiveBytes: 2048,
    fileCount: 2,
    revision: 1,
    createdAt: "2026-09-15T00:00:00.000Z",
    updatedAt: "2026-09-16T00:00:00.000Z",
  };
}

function renderDialog() {
  const onClose = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  render(<SkillPresetDialog agentId={AGENT_ID} onClose={onClose} />, { wrapper });
  return { client, onClose };
}

function stubCatalog(value: ListSkillPresetsResponse | Error) {
  const spy = vi.spyOn(browserApi, "skillPresets");
  if (value instanceof Error) spy.mockRejectedValue(value);
  else spy.mockResolvedValue(value);
  return spy;
}

function stubInstall(value: InstallSkillPresetResponse | Error) {
  const spy = vi.spyOn(browserApi, "installSkillPreset");
  if (value instanceof Error) spy.mockRejectedValue(value);
  else spy.mockResolvedValue(value);
  return spy;
}

afterEach(() => vi.restoreAllMocks());

describe("SkillPresetDialog", () => {
  it("renders the active category with each preset's Server-computed state", async () => {
    stubCatalog(catalog());
    renderDialog();

    expect(await screen.findByText("mcp-onboarding")).toBeTruthy();
    expect(screen.getByText("Add MCP tools to this Agent")).toBeTruthy();
    expect(screen.getByText("Not installed")).toBeTruthy();
    // The engineering entry belongs to the other tab.
    expect(screen.queryByText("mcp-catalog-entry")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Engineering" }));
    expect(await screen.findByText("mcp-catalog-entry")).toBeTruthy();
    expect(screen.queryByText("mcp-onboarding")).toBeNull();
  });

  it("searches across categories and restores the tab when the query clears", async () => {
    stubCatalog(catalog());
    renderDialog();
    await screen.findByText("mcp-onboarding");

    fireEvent.change(screen.getByLabelText("Search presets"), { target: { value: "catalog" } });
    expect(await screen.findByText("mcp-catalog-entry")).toBeTruthy();
    expect(screen.queryByText("mcp-onboarding")).toBeNull();

    fireEvent.change(screen.getByLabelText("Search presets"), { target: { value: "nothing matches" } });
    expect(await screen.findByText("No presets match your search.")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Search presets"), { target: { value: "" } });
    expect(await screen.findByText("mcp-onboarding")).toBeTruthy();
  });

  it("installs a preset by name and reports the action the Server took", async () => {
    stubCatalog(catalog());
    const install = stubInstall({ action: "installed", skill: installedSkill() });
    renderDialog();
    await screen.findByText("mcp-onboarding");

    fireEvent.click(screen.getByRole("button", { name: "Install: mcp-onboarding" }));

    await waitFor(() => expect(screen.getByText("mcp-onboarding: Installed")).toBeTruthy());
    expect(install).toHaveBeenCalledWith(AGENT_ID, "mcp-onboarding");
  });

  it("offers an update for an outdated preset", async () => {
    stubCatalog(catalog({ presets: [preset({ state: "update_available" })] }));
    const install = stubInstall({ action: "updated", skill: installedSkill() });
    renderDialog();

    const button = await screen.findByRole("button", { name: "Update: mcp-onboarding" });
    expect(screen.getByText("Update available")).toBeTruthy();
    fireEvent.click(button);

    await waitFor(() => expect(screen.getByText("mcp-onboarding: Updated")).toBeTruthy());
    expect(install).toHaveBeenCalledWith(AGENT_ID, "mcp-onboarding");
  });

  it("disables a conflicting preset and explains why", async () => {
    stubCatalog(catalog({ presets: [preset({ state: "name_conflict" })] }));
    const install = stubInstall({ action: "installed", skill: installedSkill() });
    renderDialog();

    const button = (await screen.findByRole("button", { name: "Unavailable: mcp-onboarding" })) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByText("Another Skill already uses this name")).toBeTruthy();
    fireEvent.click(button);
    expect(install).not.toHaveBeenCalled();
  });

  it("renders a failed install as the shared error copy", async () => {
    stubCatalog(catalog());
    stubInstall(new ApiError(409, "conflict", SKILL_ERROR_CODES.NAME_CONFLICT));
    renderDialog();
    await screen.findByText("mcp-onboarding");

    fireEvent.click(screen.getByRole("button", { name: "Install: mcp-onboarding" }));

    await waitFor(() => expect(screen.getByText("A Skill with this name already exists.")).toBeTruthy());
  });

  it("reports a catalog it could not load", async () => {
    stubCatalog(new ApiError(500, "boom", "INTERNAL_ERROR"));
    renderDialog();

    expect(await screen.findByText("The presets could not be loaded.")).toBeTruthy();
  });
});
