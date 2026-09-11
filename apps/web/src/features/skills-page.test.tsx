import {
  type ListSkillsResponse,
  SKILL_ARCHIVE_MAX_BYTES,
  type SkillAgentsResponse,
  type SkillDetail,
  type SkillSummary,
  skillArchivePath,
} from "@opentag/shared/browser";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderInRouter } from "../__tests__/support/router.js";
import { ApiError, browserApi } from "../api.js";
import { SkillsPage } from "./skills-page.js";

const digest = "a".repeat(64);
const releaseNotes = {
  name: "release-notes",
  description: "Turns merged changes into release notes",
  digest,
  archiveSha256: digest,
  archiveBytes: 2048,
  fileCount: 3,
  totalBytes: 4096,
  agentCount: 2,
  updatedAt: "2026-09-10T10:00:00.000Z",
  updatedBy: { kind: "user", id: "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e" },
} satisfies SkillSummary;
const triage = {
  ...releaseNotes,
  name: "issue-triage",
  description: "Classifies incoming issues",
  fileCount: 1,
  totalBytes: 1536,
  agentCount: 1,
  updatedBy: { kind: "session", id: "11111111-1111-4111-8111-111111111111" },
} satisfies SkillSummary;
const detail = {
  ...releaseNotes,
  manifest: {
    schemaVersion: 1,
    name: "release-notes",
    files: [{ path: "SKILL.md", sha256: digest, size: 100, mode: "0644" }],
  },
} satisfies SkillDetail;
const page = (skills: SkillSummary[]): ListSkillsResponse => ({ skills, nextCursor: null });

function zipFile(name = "release-notes.zip", size = 16): File {
  return new File([new Uint8Array(size)], name, { type: "application/zip" });
}

function chooseFile(file: File) {
  const input = document.querySelector<HTMLInputElement>('[data-ui="skills-upload-input"]');
  if (!input) throw new Error("Expected the hidden upload input");
  fireEvent.change(input, { target: { files: [file] } });
}

function rowFor(name: string): HTMLElement {
  const cell = screen.getByText(name, { selector: '[data-ui="skill-name"]' });
  const row = cell.closest<HTMLElement>('[data-ui="skill-row"]');
  if (!row) throw new Error(`Expected a row for ${name}`);
  return row;
}

afterEach(() => vi.restoreAllMocks());

describe("Skills page", () => {
  it("shows the empty library with upload guidance and no demo rows", async () => {
    vi.spyOn(browserApi, "skills").mockResolvedValue(page([]));
    await renderInRouter(<SkillsPage />);

    expect(await screen.findByRole("heading", { name: "No skills yet" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Skills" })).toBeTruthy();
    expect(screen.getByText(/Only upload skills from sources you trust/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Upload skill" }).getAttribute("aria-disabled")).toBeNull();
    expect(screen.queryByText("Demo data")).toBeNull();
    expect(screen.queryByText("Release notes writer")).toBeNull();
  });

  it("lists every skill with its description, size, provenance, Agent count and download link", async () => {
    vi.spyOn(browserApi, "skills").mockResolvedValue(page([releaseNotes, triage]));
    await renderInRouter(<SkillsPage />);

    const row = await waitFor(() => rowFor("release-notes"));
    expect(within(row).getByText("Turns merged changes into release notes")).toBeTruthy();
    expect(within(row).getByText("3 files · 4 KiB")).toBeTruthy();
    expect(within(row).getByText("Web upload")).toBeTruthy();
    expect(within(row).getByText("2 Agents")).toBeTruthy();
    expect(within(row).getByRole("link", { name: "Download" }).getAttribute("href")).toBe(
      skillArchivePath("release-notes"),
    );
    expect(within(row).getByRole("link", { name: "Download" }).getAttribute("download")).toBe("release-notes.zip");
    const other = rowFor("issue-triage");
    expect(within(other).getByText("1 file · 1.5 KiB")).toBeTruthy();
    expect(within(other).getByText("Agent session")).toBeTruthy();
    expect(within(other).getByText("1 Agent")).toBeTruthy();
    expect(screen.getByText("2 skills")).toBeTruthy();
    expect(screen.getByRole("table", { name: "Skill library" })).toBeTruthy();
  });

  it("uploads a chosen archive and re-reads the library", async () => {
    const skills = vi.spyOn(browserApi, "skills").mockResolvedValue(page([]));
    const upload = vi.spyOn(browserApi, "uploadSkill").mockResolvedValue(detail);
    await renderInRouter(<SkillsPage />);
    await screen.findByRole("heading", { name: "No skills yet" });
    skills.mockResolvedValue(page([releaseNotes]));

    const file = zipFile();
    chooseFile(file);

    expect(await screen.findByRole("status")).toHaveProperty(
      "textContent",
      expect.stringContaining("release-notes was uploaded."),
    );
    expect(upload).toHaveBeenCalledTimes(1);
    expect(upload.mock.calls[0]?.[0]).toBe(file);
    expect(upload.mock.calls[0]?.[1]).toEqual({ onConflict: "fail" });
    await waitFor(() => expect(skills.mock.calls.length).toBeGreaterThanOrEqual(2));
    await waitFor(() => rowFor("release-notes"));
  });

  it("asks before replacing a same-name skill and resends with onConflict=replace", async () => {
    vi.spyOn(browserApi, "skills").mockResolvedValue(page([releaseNotes]));
    const upload = vi
      .spyOn(browserApi, "uploadSkill")
      .mockRejectedValueOnce(new ApiError(409, "A skill named release-notes already exists"))
      .mockResolvedValueOnce(detail);
    await renderInRouter(<SkillsPage />);
    await waitFor(() => rowFor("release-notes"));

    const file = zipFile();
    chooseFile(file);
    const dialog = await screen.findByRole("alertdialog", { name: "Replace the existing skill?" });
    expect(within(dialog).getByText(/same name as release-notes\.zip already exists/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Replace" }));

    await waitFor(() => expect(upload).toHaveBeenCalledTimes(2));
    expect(upload.mock.calls[1]?.[0]).toBe(file);
    expect(upload.mock.calls[1]?.[1]).toEqual({ onConflict: "replace" });
    expect(await screen.findByText("release-notes was replaced.")).toBeTruthy();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("keeps the library untouched when the replacement is declined", async () => {
    vi.spyOn(browserApi, "skills").mockResolvedValue(page([releaseNotes]));
    const upload = vi.spyOn(browserApi, "uploadSkill").mockRejectedValue(new ApiError(409, "exists"));
    await renderInRouter(<SkillsPage />);
    await waitFor(() => rowFor("release-notes"));

    chooseFile(zipFile());
    const dialog = await screen.findByRole("alertdialog", { name: "Replace the existing skill?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(upload).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("explains a Server refusal in product copy rather than an error code", async () => {
    vi.spyOn(browserApi, "skills").mockResolvedValue(page([]));
    vi.spyOn(browserApi, "uploadSkill").mockRejectedValue(
      new ApiError(413, "Archive exceeds 5242880 bytes", "SKILL_ARCHIVE_TOO_LARGE", "validation"),
    );
    await renderInRouter(<SkillsPage />);
    await screen.findByRole("heading", { name: "No skills yet" });

    chooseFile(zipFile());
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("The Server refused the archive because it is larger than 5 MiB.");
    expect(alert.textContent).toContain("Archive exceeds 5242880 bytes");
    expect(alert.textContent).not.toContain("SKILL_ARCHIVE_TOO_LARGE");
  });

  it("maps the manifest and storage refusals to their own sentences", async () => {
    vi.spyOn(browserApi, "skills").mockResolvedValue(page([]));
    const upload = vi
      .spyOn(browserApi, "uploadSkill")
      .mockRejectedValueOnce(new ApiError(400, "SKILL.md frontmatter is missing description", "SKILL_MANIFEST_INVALID"))
      .mockRejectedValueOnce(new ApiError(503, "Storage unavailable"))
      .mockRejectedValueOnce(new ApiError(415, "Unsupported"));
    await renderInRouter(<SkillsPage />);
    await screen.findByRole("heading", { name: "No skills yet" });

    chooseFile(zipFile());
    expect((await screen.findByRole("alert")).textContent).toContain("The archive is not a valid skill.");
    expect(screen.getByRole("alert").textContent).toContain("frontmatter is missing description");
    chooseFile(zipFile());
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("Skill storage is temporarily unavailable"),
    );
    chooseFile(zipFile());
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("The Server only accepts application/zip archives."),
    );
    expect(upload).toHaveBeenCalledTimes(3);
  });

  it("refuses an oversized or non-zip file before any request is made", async () => {
    vi.spyOn(browserApi, "skills").mockResolvedValue(page([]));
    const upload = vi.spyOn(browserApi, "uploadSkill");
    await renderInRouter(<SkillsPage />);
    await screen.findByRole("heading", { name: "No skills yet" });

    chooseFile(zipFile("huge.zip", SKILL_ARCHIVE_MAX_BYTES + 1));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "huge.zip is larger than 5 MiB. Skill archives must be 5 MiB or smaller.",
    );
    chooseFile(new File(["# not a zip"], "SKILL.md", { type: "text/markdown" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Only .zip archives can be uploaded."));
    expect(upload).not.toHaveBeenCalled();
  });

  it("accepts a dropped archive on the list region", async () => {
    vi.spyOn(browserApi, "skills").mockResolvedValue(page([]));
    const upload = vi.spyOn(browserApi, "uploadSkill").mockResolvedValue(detail);
    await renderInRouter(<SkillsPage />);
    await screen.findByRole("heading", { name: "No skills yet" });
    const zone = document.querySelector<HTMLElement>('[data-ui="skills-drop-zone"]');
    if (!zone) throw new Error("Expected the drop zone");

    const file = zipFile();
    const dataTransfer = { types: ["Files"], files: [file], dropEffect: "none" };
    fireEvent.dragOver(zone, { dataTransfer });
    expect(zone.getAttribute("data-dragging")).toBe("true");
    fireEvent.drop(zone, { dataTransfer });

    await waitFor(() => expect(upload).toHaveBeenCalledWith(file, { onConflict: "fail" }));
    expect(zone.getAttribute("data-dragging")).toBeNull();
  });

  it("confirms a deletion, calls the API and drops the row", async () => {
    const skills = vi.spyOn(browserApi, "skills").mockResolvedValue(page([releaseNotes, triage]));
    const remove = vi.spyOn(browserApi, "deleteSkill").mockResolvedValue(undefined);
    await renderInRouter(<SkillsPage />);
    const row = await waitFor(() => rowFor("issue-triage"));
    skills.mockResolvedValue(page([releaseNotes]));

    fireEvent.click(within(row).getByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Delete issue-triage?" });
    expect(within(dialog).getByText(/unassigned from every Agent/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(remove).toHaveBeenCalledWith("issue-triage"));
    await waitFor(() => expect(screen.queryByText("issue-triage", { selector: '[data-ui="skill-name"]' })).toBeNull());
    expect(rowFor("release-notes")).toBeTruthy();
    expect(await screen.findByText("issue-triage was deleted.")).toBeTruthy();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("keeps the confirmation open and reports a failed deletion", async () => {
    vi.spyOn(browserApi, "skills").mockResolvedValue(page([releaseNotes]));
    vi.spyOn(browserApi, "deleteSkill").mockRejectedValue(new ApiError(503, "Skill storage is unavailable"));
    await renderInRouter(<SkillsPage />);
    const row = await waitFor(() => rowFor("release-notes"));

    fireEvent.click(within(row).getByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Delete release-notes?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    expect((await within(dialog).findByRole("alert")).textContent).toContain("Skill storage is unavailable");
    expect(rowFor("release-notes")).toBeTruthy();
  });

  it("renders SKILL.md as Markdown without executing embedded HTML", async () => {
    vi.spyOn(browserApi, "skills").mockResolvedValue(page([releaseNotes]));
    const markdown = vi
      .spyOn(browserApi, "skillMarkdown")
      .mockResolvedValue(
        "---\nname: release-notes\n---\n\n# Release notes\n\n- Group changes by impact\n- Keep it short\n\n<script>window.skillPwned = true</script>\n",
      );
    vi.spyOn(browserApi, "skillAgents").mockResolvedValue({
      agents: [{ agentId: "1a63a21e-f6c7-4474-91ea-4dabf0566a24", name: "atlas", displayName: "Atlas" }],
    } satisfies SkillAgentsResponse);
    await renderInRouter(<SkillsPage />);
    const row = await waitFor(() => rowFor("release-notes"));

    fireEvent.click(within(row).getByRole("button", { name: "View SKILL.md" }));
    const dialog = await screen.findByRole("dialog", { name: "release-notes" });
    expect(markdown).toHaveBeenCalledWith("release-notes");
    expect(await within(dialog).findByRole("heading", { name: "Release notes" })).toBeTruthy();
    expect(
      within(dialog)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["Group changes by impact", "Keep it short"]);
    expect(dialog.querySelector("script")).toBeNull();
    // The frontmatter fences would otherwise read as a rule and a setext heading.
    expect(dialog.querySelector("hr")).toBeNull();
    expect(within(dialog).queryByRole("heading", { name: /name: release-notes/ })).toBeNull();
    expect(dialog.textContent).not.toContain("name: release-notes");
    expect(dialog.textContent).not.toContain("skillPwned");
    expect((window as unknown as { skillPwned?: boolean }).skillPwned).toBeUndefined();
    expect(await within(dialog).findByText("Atlas")).toBeTruthy();
    expect(within(dialog).getByRole("link", { name: "Download" }).getAttribute("href")).toBe(
      skillArchivePath("release-notes"),
    );
  });

  it("reports a SKILL.md that could not be read and offers a retry", async () => {
    vi.spyOn(browserApi, "skills").mockResolvedValue(page([releaseNotes]));
    const markdown = vi
      .spyOn(browserApi, "skillMarkdown")
      .mockRejectedValueOnce(new ApiError(503, "Skill storage is unavailable"))
      .mockResolvedValueOnce("# Recovered");
    vi.spyOn(browserApi, "skillAgents").mockResolvedValue({ agents: [] });
    await renderInRouter(<SkillsPage />);
    const row = await waitFor(() => rowFor("release-notes"));

    fireEvent.click(within(row).getByRole("button", { name: "View SKILL.md" }));
    const dialog = await screen.findByRole("dialog", { name: "release-notes" });
    expect((await within(dialog).findByRole("alert")).textContent).toContain("SKILL.md could not be loaded.");
    expect(await within(dialog).findByText("Not assigned to any Agent yet.")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Try again" }));
    expect(await within(dialog).findByRole("heading", { name: "Recovered" })).toBeTruthy();
    expect(markdown).toHaveBeenCalledTimes(2);
  });

  it("withdraws the list on a terminal refusal and offers a retry", async () => {
    const skills = vi
      .spyOn(browserApi, "skills")
      .mockRejectedValueOnce(new ApiError(403, "Skills are not enabled for this Account"))
      .mockResolvedValueOnce(page([releaseNotes]));
    await renderInRouter(<SkillsPage />);

    expect(await screen.findByRole("heading", { name: "Skills are unavailable" })).toBeTruthy();
    expect(screen.getByText("Skills are not enabled for this Account")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => rowFor("release-notes"));
    expect(skills).toHaveBeenCalledTimes(2);
  });

  it("appends the next page on demand", async () => {
    const skills = vi
      .spyOn(browserApi, "skills")
      .mockResolvedValueOnce({ skills: [releaseNotes], nextCursor: "page-2" })
      .mockResolvedValueOnce(page([triage]));
    await renderInRouter(<SkillsPage />);
    await waitFor(() => rowFor("release-notes"));

    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() => rowFor("issue-triage"));
    expect(skills.mock.calls[1]?.[0]).toEqual({ cursor: "page-2" });
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });
});
