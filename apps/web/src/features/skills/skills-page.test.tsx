import { SKILL_ARCHIVE_MAX_BYTES, SKILL_ERROR_CODES, type Skill } from "@opentag/shared/browser";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, browserApi } from "../../api.js";
import { SkillsPage } from "./skills-page.js";

/**
 * The page's contract, asserted where it is easiest for a reader to get wrong:
 *
 * - It renders from the list response alone. Storage status rides on that response, so a deployment
 *   without object storage shows a calm notice, not a failed request or a dead button.
 * - A name conflict is the one failure the user resolves, so it opens a confirmation and only then
 *   re-uploads with `replace: true`; cancelling never overwrites anything.
 * - Client-side checks reject an archive before any request is made.
 */

const AGENT_ID = "1a63a21e-f6c7-4474-91ea-4dabf0566a24";
const SKILL_ID = "9d4e1378-8ff2-4e41-a6dd-e8bf59ed775b";

function skill(overrides: Partial<Skill> = {}): Skill {
  return {
    id: SKILL_ID,
    agentId: AGENT_ID,
    name: "Release notes writer",
    description: "Turns merged changes into clear release notes",
    enabled: true,
    source: "web_upload",
    archiveSha256: "a".repeat(64),
    archiveBytes: 2048,
    fileCount: 3,
    revision: 1,
    createdAt: "2026-09-15T00:00:00.000Z",
    updatedAt: "2026-09-16T00:00:00.000Z",
    ...overrides,
  };
}

function stubList(skills: Skill[], storage: "available" | "unavailable" = "available") {
  return vi.spyOn(browserApi, "agentSkills").mockResolvedValue({ skills, storage });
}

function wrap(children: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}>{children}</QueryClientProvider>);
}

function fileInput(): HTMLInputElement {
  const input = document.querySelector('[data-ui="skill-upload-input"]');
  if (!(input instanceof HTMLInputElement)) throw new Error("The upload input is not rendered");
  return input;
}

function archiveFile(name: string, contents: string): File {
  return new File([contents], name, { type: "application/octet-stream" });
}

afterEach(() => vi.restoreAllMocks());

describe("SkillsPage", () => {
  it("renders the Agent's Skills with their source, size, file count and download link", async () => {
    stubList([skill()]);
    wrap(<SkillsPage agentId={AGENT_ID} />);

    expect(await screen.findByText("Release notes writer")).toBeTruthy();
    expect(screen.getByText("Turns merged changes into clear release notes")).toBeTruthy();
    expect(screen.getByText("Uploaded here")).toBeTruthy();
    expect(screen.getByText(/2 KB · 3 files · Updated/)).toBeTruthy();
    const download = screen.getByRole("link", { name: "Download" });
    expect(download.getAttribute("href")).toBe(`/api/v1/agents/${AGENT_ID}/skills/${SKILL_ID}/bundle`);
  });

  it("shows the empty state when the Agent has no Skills", async () => {
    stubList([]);
    wrap(<SkillsPage agentId={AGENT_ID} />);

    expect(await screen.findByText(/No Skills yet/)).toBeTruthy();
  });

  it("uploads an archive with the detected format, its sha256, and replace off", async () => {
    stubList([]);
    const uploads: unknown[] = [];
    vi.spyOn(browserApi, "uploadAgentSkill").mockImplementation((async (_agentId: string, input: unknown) => {
      uploads.push(input);
      return skill();
    }) as never);
    wrap(<SkillsPage agentId={AGENT_ID} />);
    await screen.findByText(/No Skills yet/);

    fireEvent.change(fileInput(), { target: { files: [archiveFile("notes.skill", "hello")] } });

    await waitFor(() => expect(uploads).toHaveLength(1));
    expect(uploads[0]).toMatchObject({
      format: "zip",
      replace: false,
      sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    });
  });

  it("confirms a name conflict and only then re-uploads with replace on", async () => {
    stubList([]);
    const replacements: { replace: boolean }[] = [];
    vi.spyOn(browserApi, "uploadAgentSkill").mockImplementation((async (
      _agentId: string,
      input: { replace: boolean },
    ) => {
      replacements.push(input);
      if (!input.replace) throw new ApiError(409, "conflict", SKILL_ERROR_CODES.NAME_CONFLICT);
      return skill();
    }) as never);
    wrap(<SkillsPage agentId={AGENT_ID} />);
    await screen.findByText(/No Skills yet/);

    fireEvent.change(fileInput(), { target: { files: [archiveFile("notes.zip", "hello")] } });

    expect(await screen.findByText("Replace the existing Skill with notes.zip?")).toBeTruthy();
    expect(replacements).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Replace Skill" }));

    await waitFor(() => expect(replacements).toHaveLength(2));
    expect(replacements[0]?.replace).toBe(false);
    expect(replacements[1]?.replace).toBe(true);
  });

  it("does not re-upload when the replace confirmation is cancelled", async () => {
    stubList([]);
    const upload = vi
      .spyOn(browserApi, "uploadAgentSkill")
      .mockRejectedValueOnce(new ApiError(409, "conflict", SKILL_ERROR_CODES.NAME_CONFLICT));
    wrap(<SkillsPage agentId={AGENT_ID} />);
    await screen.findByText(/No Skills yet/);

    fireEvent.change(fileInput(), { target: { files: [archiveFile("notes.zip", "hello")] } });
    await screen.findByText("Replace the existing Skill with notes.zip?");

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByText(/Replace the existing Skill/)).toBeNull());
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it("rejects an oversized archive client-side without a request", async () => {
    stubList([]);
    const upload = vi.spyOn(browserApi, "uploadAgentSkill");
    wrap(<SkillsPage agentId={AGENT_ID} />);
    await screen.findByText(/No Skills yet/);

    const oversized = archiveFile("notes.zip", "x");
    Object.defineProperty(oversized, "size", { value: SKILL_ARCHIVE_MAX_BYTES + 1 });
    fireEvent.change(fileInput(), { target: { files: [oversized] } });

    expect(await screen.findByText("This archive is larger than 16 MiB.")).toBeTruthy();
    expect(upload).not.toHaveBeenCalled();
  });

  it("rejects an unknown extension client-side without a request", async () => {
    stubList([]);
    const upload = vi.spyOn(browserApi, "uploadAgentSkill");
    wrap(<SkillsPage agentId={AGENT_ID} />);
    await screen.findByText(/No Skills yet/);

    fireEvent.change(fileInput(), { target: { files: [archiveFile("notes.txt", "hello")] } });

    expect(await screen.findByText("Choose a .zip, .skill, .tar.gz, or .tgz archive.")).toBeTruthy();
    expect(upload).not.toHaveBeenCalled();
  });

  it("writes the enabled state through the update call", async () => {
    stubList([skill({ enabled: true })]);
    const update = vi.spyOn(browserApi, "updateAgentSkill").mockResolvedValue({} as never);
    wrap(<SkillsPage agentId={AGENT_ID} />);

    fireEvent.click(await screen.findByRole("switch", { name: "Enable Release notes writer" }));

    await waitFor(() => expect(update).toHaveBeenCalledWith(AGENT_ID, SKILL_ID, { enabled: false }));
  });

  it("deletes only after the confirmation", async () => {
    stubList([skill()]);
    const remove = vi.spyOn(browserApi, "removeAgentSkill").mockResolvedValue(undefined);
    wrap(<SkillsPage agentId={AGENT_ID} />);

    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    expect(await screen.findByText("Delete Release notes writer?")).toBeTruthy();
    expect(remove).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Delete Skill" }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith(AGENT_ID, SKILL_ID));
  });

  it("renders the storage-unavailable notice from the list response with no extra request", async () => {
    const list = stubList([skill()], "unavailable");
    const detail = vi.spyOn(browserApi, "agentSkill");
    const upload = vi.spyOn(browserApi, "uploadAgentSkill");
    wrap(<SkillsPage agentId={AGENT_ID} />);

    expect(await screen.findByText(/Skill storage is not configured/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Upload skill" }) as HTMLButtonElement).disabled).toBe(true);
    // The Skill is still listed; only its download is withheld.
    expect(screen.getByText("Release notes writer")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Download" })).toBeNull();

    expect(list).toHaveBeenCalledTimes(1);
    expect(detail).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
  });
});
