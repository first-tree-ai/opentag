import { type ReadSkillFileResponse, SKILL_ERROR_CODES, type Skill } from "@opentag/shared/browser";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, browserApi } from "../../api.js";
import { queryKeys } from "../../query/keys.js";
import { SkillDetailsDialog } from "./skill-details-dialog.js";
import { SkillReaderMarkdown } from "./skill-reader-markdown.js";
import { SkillsPage } from "./skills-page.js";

const skill: Skill = {
  id: "9d4e1378-8ff2-4e41-a6dd-e8bf59ed775b",
  agentId: "1a63a21e-f6c7-4474-91ea-4dabf0566a24",
  name: "reader",
  description: "A package to read",
  archiveSha256: "a".repeat(64),
  archiveBytes: 100,
  fileCount: 3,
  enabled: true,
  revision: 1,
  source: "web_upload",
  createdAt: "2026-10-09T00:00:00.000Z",
  updatedAt: "2026-10-09T00:00:00.000Z",
};
const content =
  "---\nname: reader\ndescription: A package to read\n---\n# Complete instructions\n\n[Guide](references/guide.md)\n\n<script>alert('unsafe')</script>\n\n![remote](https://example.test/track.png)\n\n[unsafe](javascript:alert(1))\n\n## Final section\n\nThe full ending.";
const files = [
  { path: "SKILL.md", bytes: content.length },
  { path: "references/guide.md", bytes: 8 },
  { path: "scripts/draft.ts", bytes: 18 },
];
function response(
  path = "SKILL.md",
  preview: ReadSkillFileResponse["preview"] = { status: "text", content },
): ReadSkillFileResponse {
  return { path, files, archiveSha256: skill.archiveSha256, preview };
}
function wrap(node: React.ReactNode, client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}
afterEach(() => vi.restoreAllMocks());

describe("Skill details reader", () => {
  it("opens from the Skill identity and reads the full manifest rather than the list summary", async () => {
    vi.spyOn(browserApi, "agentSkills").mockResolvedValue({ skills: [skill], storage: "available" });
    const read = vi.spyOn(browserApi, "agentSkillFile").mockResolvedValue(response());
    wrap(<SkillsPage agentId={skill.agentId} />);
    fireEvent.click(await screen.findByRole("button", { name: "View reader" }));
    expect(await screen.findByRole("heading", { name: "Complete instructions" })).toBeTruthy();
    expect(screen.getByText("The full ending.")).toBeTruthy();
    expect(read).toHaveBeenCalledWith(
      skill.agentId,
      skill.id,
      "SKILL.md",
      skill.archiveSha256,
      expect.any(AbortSignal),
    );
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(skill.description)).toBeTruthy();
    expect(within(dialog).getByRole("link", { name: "Download" }).getAttribute("download")).toBe("reader.tar.gz");
    expect(within(dialog).getByText("Description:")).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: "Source" })).toBeNull();
    expect(within(dialog).queryByRole("button", { name: "Reading" })).toBeNull();
    expect(within(dialog).queryByRole("button", { name: "Frontmatter" })).toBeNull();
    expect(within(dialog).queryByText("Skill details")).toBeNull();
    expect(within(dialog).queryByText("Files")).toBeNull();
  });

  it("navigates package references and renders scripts as literal text", async () => {
    vi.spyOn(browserApi, "agentSkillFile").mockImplementation(async (_agent, _skill, path) =>
      response(path, {
        status: "text",
        content:
          path === "SKILL.md" ? content : path.endsWith(".ts") ? "<script>doNotRun()</script>" : "# Guide content",
      }),
    );
    wrap(<SkillDetailsDialog skill={skill} onClose={vi.fn()} storageAvailable />);
    fireEvent.click(await screen.findByRole("button", { name: "Guide" }));
    expect(await screen.findByRole("heading", { name: "Guide content" })).toBeTruthy();
    expect(within(screen.getByRole("dialog")).queryByText(skill.description)).toBeNull();
    expect(screen.queryByText("Description:")).toBeNull();
    const nav = screen.getByRole("navigation", { name: "Files" });
    fireEvent.click(within(nav).getByRole("button", { name: "draft.ts" }));
    expect(await screen.findByText("<script>doNotRun()</script>")).toBeTruthy();
    expect(screen.getByRole("dialog").querySelector("script")).toBeNull();
    expect(screen.queryByRole("button", { name: "Source" })).toBeNull();
    expect(within(screen.getByRole("dialog")).queryByText(skill.description)).toBeNull();
  });

  it("never loads remote images, injects HTML or activates unsafe links", async () => {
    vi.spyOn(browserApi, "agentSkillFile").mockResolvedValue(response());
    wrap(<SkillDetailsDialog skill={skill} onClose={vi.fn()} storageAvailable />);
    await screen.findByRole("heading", { name: "Complete instructions" });
    const dialog = screen.getByRole("dialog");
    expect(dialog.querySelector("img, script, iframe")).toBeNull();
    expect(dialog.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(screen.getByText("Image: remote")).toBeTruthy();
  });

  it("omits single-file navigation and keeps Frontmatter out of the reading surface", async () => {
    vi.spyOn(browserApi, "agentSkillFile").mockResolvedValue({ ...response(), files: files.slice(0, 1) });
    wrap(<SkillDetailsDialog skill={{ ...skill, fileCount: 1 }} onClose={vi.fn()} storageAvailable />);
    await screen.findByRole("heading", { name: "Complete instructions" });
    expect(screen.queryByRole("navigation", { name: "Files" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Skill file" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Frontmatter" })).toBeNull();
    expect(screen.getByRole("dialog").textContent).not.toContain("name: reader");
    expect(screen.getByText("Description:")).toBeTruthy();
  });

  it.each([
    ["binary", "Preview unavailable"],
    ["too_large", "This file is too large to preview"],
  ] as const)("explains %s files and retains the download action", async (status, title) => {
    vi.spyOn(browserApi, "agentSkillFile").mockResolvedValue(response("SKILL.md", { status }));
    wrap(<SkillDetailsDialog skill={skill} onClose={vi.fn()} storageAvailable />);
    expect(await screen.findByText(title)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Download" })).toBeTruthy();
    expect(screen.queryByText(skill.description)).toBeNull();
  });

  it("offers retry for transient failures and reports concurrent replacement clearly", async () => {
    const read = vi
      .spyOn(browserApi, "agentSkillFile")
      .mockRejectedValueOnce(new Error("failed"))
      .mockResolvedValueOnce(response());
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = wrap(<SkillDetailsDialog skill={skill} onClose={vi.fn()} storageAvailable />, client);
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "Complete instructions" })).toBeTruthy();
    read.mockRejectedValue(new ApiError(409, "Changed", SKILL_ERROR_CODES.REVISION_CONFLICT, "deterministic"));
    view.rerender(
      <QueryClientProvider client={client}>
        <SkillDetailsDialog skill={{ ...skill, archiveSha256: "b".repeat(64) }} onClose={vi.fn()} storageAvailable />
      </QueryClientProvider>,
    );
    expect(await screen.findByText(/This skill has changed/)).toBeTruthy();
    expect(screen.queryByText("The full ending.")).toBeNull();
  });

  it("only shows the description after SKILL.md has loaded", async () => {
    let resolve!: (data: ReadSkillFileResponse) => void;
    vi.spyOn(browserApi, "agentSkillFile").mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    wrap(<SkillDetailsDialog skill={skill} onClose={vi.fn()} storageAvailable />);
    expect(screen.queryByText(skill.description)).toBeNull();
    await act(async () => resolve(response()));
    expect(await screen.findByText(skill.description)).toBeTruthy();
  });

  it.each(["", "---\nname: reader\ndescription: A package to read\n---\n"])(
    "explains an empty Markdown body instead of showing a blank document",
    async (text) => {
      vi.spyOn(browserApi, "agentSkillFile").mockResolvedValue(response("SKILL.md", { status: "text", content: text }));
      wrap(<SkillDetailsDialog skill={skill} onClose={vi.fn()} storageAvailable />);
      expect(await screen.findByText("This file is empty.")).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Frontmatter" })).toBeNull();
    },
  );

  it("focuses a cross-file fragment and a repeated link to the selected file", async () => {
    const scroll = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scroll });
    vi.spyOn(browserApi, "agentSkillFile").mockImplementation(async (_agent, _skill, path) =>
      response(path, {
        status: "text",
        content:
          path === "SKILL.md"
            ? "# Instructions\n\n[Jump](references/guide.md#target-section)"
            : "# Guide\n\n[Again](guide.md#target-section)\n\n## Target section",
      }),
    );
    wrap(<SkillDetailsDialog skill={skill} onClose={vi.fn()} storageAvailable />);
    fireEvent.click(await screen.findByRole("button", { name: "Jump" }));
    const target = await screen.findByRole("heading", { name: "Target section" });
    await waitFor(() => expect(document.activeElement).toBe(target));
    expect(scroll).toHaveBeenCalledTimes(1);
    target.blur();
    fireEvent.click(screen.getByRole("button", { name: "Again" }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Target section" })));
    expect(scroll).toHaveBeenCalledTimes(2);
  });

  it("revalidates cached Skill availability and removes download after confirmed deletion", async () => {
    const missing = new ApiError(404, "Missing", SKILL_ERROR_CODES.NOT_FOUND, "deterministic");
    vi.spyOn(browserApi, "agentSkillFile").mockRejectedValue(missing);
    const detail = vi.spyOn(browserApi, "agentSkill").mockRejectedValue(missing);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(queryKeys.skills.skill(skill.agentId, skill.id), { ...skill, files, filesTruncated: false });
    wrap(<SkillDetailsDialog skill={skill} onClose={vi.fn()} storageAvailable />, client);
    expect(await screen.findByText("This skill or file is no longer available.")).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("link", { name: "Download" })).toBeNull());
    expect(detail).toHaveBeenCalledWith(skill.agentId, skill.id);
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it.each(["present", "unknown"])(
    "retains download when package availability is %s after a missing member",
    async (state) => {
      vi.spyOn(browserApi, "agentSkillFile").mockRejectedValue(
        new ApiError(404, "Missing", SKILL_ERROR_CODES.NOT_FOUND, "deterministic"),
      );
      const detail = vi.spyOn(browserApi, "agentSkill");
      if (state === "present") detail.mockResolvedValue({ ...skill, files, filesTruncated: false });
      else detail.mockRejectedValue(new Error("Availability check failed"));
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      wrap(<SkillDetailsDialog skill={skill} onClose={vi.fn()} storageAvailable />, client);
      await waitFor(() =>
        expect(client.getQueryState(queryKeys.skills.skill(skill.agentId, skill.id))?.status).toBe(
          state === "present" ? "success" : "error",
        ),
      );
      expect(screen.getByRole("link", { name: "Download" })).toBeTruthy();
    },
  );

  it("does not let a delayed previous Agent response enter the next Agent's page", async () => {
    let resolve!: (value: ReadSkillFileResponse) => void;
    const pending = new Promise<ReadSkillFileResponse>((done) => {
      resolve = done;
    });
    vi.spyOn(browserApi, "agentSkills").mockImplementation(async (agentId) => ({
      skills: [{ ...skill, agentId }],
      storage: "available",
    }));
    const read = vi.spyOn(browserApi, "agentSkillFile").mockReturnValue(pending);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = wrap(<SkillsPage agentId={skill.agentId} />, client);
    fireEvent.click(await screen.findByRole("button", { name: "View reader" }));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    view.rerender(
      <QueryClientProvider client={client}>
        <SkillsPage agentId="other-agent" />
      </QueryClientProvider>,
    );
    await act(async () => resolve(response()));
    expect(screen.queryByRole("heading", { name: "Complete instructions" })).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

it("keeps heading anchors stable under StrictMode and focuses duplicate headings", () => {
  const scroll = vi.fn();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scroll });
  wrap(
    <StrictMode>
      <SkillReaderMarkdown
        content={"[Jump](#example)\n\n[Second](#example-1)\n\n## Example\n\n## Example"}
        path="SKILL.md"
        files={files}
        onSelect={vi.fn()}
      />
    </StrictMode>,
  );
  const headings = screen.getAllByRole("heading", { name: "Example" });
  expect(headings[0]?.id).not.toBe(headings[1]?.id);
  fireEvent.click(screen.getByRole("link", { name: "Jump" }));
  expect(document.activeElement).toBe(headings[0]);
  fireEvent.click(screen.getByRole("link", { name: "Second" }));
  expect(document.activeElement).toBe(headings[1]);
  expect(scroll).toHaveBeenCalledTimes(2);
});
