import { SKILL_ARCHIVE_MAX_BYTES, SKILL_ERROR_CODES, type Skill } from "@opentag/shared/browser";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, browserApi } from "../../api.js";
import { queryKeys } from "../../query/keys.js";
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

function wrap(children: ReactNode, client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  return render(<QueryClientProvider client={client}>{children}</QueryClientProvider>);
}

function uploadButton(): HTMLButtonElement {
  return screen.getAllByRole("button", { name: "Add skill" })[0] as HTMLButtonElement;
}

function fileInput(): HTMLInputElement {
  const input = document.querySelector('[data-ui="skill-upload-input"]');
  if (!(input instanceof HTMLInputElement)) throw new Error("The upload input is not rendered");
  return input;
}

function archiveFile(name: string, contents: string): File {
  return new File([contents], name, { type: "application/octet-stream" });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

afterEach(() => vi.restoreAllMocks());

describe("SkillsPage", () => {
  it("shows names and descriptions, with archive download available through More", async () => {
    stubList([skill()]);
    wrap(<SkillsPage agentId={AGENT_ID} />);

    expect(await screen.findByText("Release notes writer")).toBeTruthy();
    expect(screen.getByText("Turns merged changes into clear release notes")).toBeTruthy();
    expect(screen.queryByText("Web upload")).toBeNull();
    expect(screen.queryByText(/2 KB · 3 files · Updated/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "More actions for Release notes writer" }));
    const download = await screen.findByRole("menuitem", { name: "Download skill" });
    expect(download.getAttribute("href")).toBe(`/api/v1/agents/${AGENT_ID}/skills/${SKILL_ID}/bundle`);
    // W2: the saved filename is the canonical archive this page's own upload pre-check accepts.
    expect(download.getAttribute("download")).toBe("Release notes writer.tar.gz");
    fireEvent.click(download);
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });

  it("offers remote installation and opens the dialog", async () => {
    stubList([]);
    const resolve = vi
      .spyOn(browserApi, "resolveRemoteSkills")
      .mockResolvedValue({ source: { kind: "github", url: "https://github.com/o/r.git" }, skills: [] });
    wrap(<SkillsPage agentId={AGENT_ID} />);

    // The button exists before the list arrives, when storage is still unknown and it is disabled;
    // storage is only a fact once a successful list has said so.
    await screen.findByText(/No Skills yet/);
    const install = screen.getByRole("button", { name: "Add skill" }) as HTMLButtonElement;
    expect(install.disabled).toBe(false);
    fireEvent.click(install);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Install from URL" }));
    expect(await screen.findByText("Install from URL")).toBeTruthy();
    // Opening the dialog only opens it: no source has been read yet.
    expect(resolve).not.toHaveBeenCalled();
  });

  it("offers the preset catalog and opens it without reading anything else", async () => {
    stubList([]);
    const presets = vi.spyOn(browserApi, "skillPresets").mockResolvedValue({
      categories: [{ id: "getting-started", order: 10 }],
      presets: [
        {
          name: "mcp-onboarding",
          description: "Add MCP tools to this Agent",
          category: "getting-started",
          order: 10,
          archiveSha256: "a".repeat(64),
          archiveBytes: 2048,
          fileCount: 2,
          state: "not_installed",
        },
      ],
    });
    wrap(<SkillsPage agentId={AGENT_ID} />);

    await screen.findByText(/No Skills yet/);
    // The header and empty-state Browse skills actions both open the independent catalog.
    const buttons = screen.getAllByRole("button", { name: "Browse skills" }) as HTMLButtonElement[];
    expect(buttons.length).toBeGreaterThan(0);
    expect(buttons[0]?.disabled).toBe(false);
    fireEvent.click(buttons[0] as HTMLButtonElement);
    expect((await screen.findAllByText("Browse skills")).length).toBeGreaterThan(0);
    expect(presets).toHaveBeenCalledWith(AGENT_ID);
  });

  it("disables remote installation when the deployment has no Skill storage", async () => {
    stubList([], "unavailable");
    wrap(<SkillsPage agentId={AGENT_ID} />);

    expect(await screen.findByText(/Skill storage is not configured/)).toBeTruthy();
    const install = screen.getByRole("button", { name: "Add skill" }) as HTMLButtonElement;
    expect(install.disabled).toBe(true);
    fireEvent.click(install);
    expect(screen.queryByText("Install from URL")).toBeNull();
  });

  it("shows the empty state when the Agent has no Skills", async () => {
    stubList([]);
    wrap(<SkillsPage agentId={AGENT_ID} />);

    expect(await screen.findByText(/No Skills yet/)).toBeTruthy();
    expect(screen.getByText("Add skills to give this Agent reusable know-how.")).toBeTruthy();
    const chooseFile = vi.spyOn(fileInput(), "click");
    fireEvent.click(screen.getByRole("button", { name: "Add skill" }) as HTMLButtonElement);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Upload skill" }));
    expect(chooseFile).toHaveBeenCalledOnce();
  });

  it("keeps upload disabled while hashing an archive", async () => {
    stubList([]);
    const upload = vi
      .spyOn(browserApi, "uploadAgentSkill")
      .mockResolvedValue({ ...skill(), files: [], filesTruncated: false });
    wrap(<SkillsPage agentId={AGENT_ID} />);
    await screen.findByText(/No Skills yet/);
    const hash = deferred<ArrayBuffer>();
    const file = archiveFile("notes.zip", "hello");
    Object.defineProperty(file, "arrayBuffer", { value: () => hash.promise });

    fireEvent.change(fileInput(), { target: { files: [file] } });

    expect(screen.getByText("Uploading notes.zip…").getAttribute("role")).toBe("status");
    for (const button of screen.getAllByRole("button", { name: "Add skill" })) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
    }
    expect(upload).not.toHaveBeenCalled();
    await act(async () => hash.resolve(new TextEncoder().encode("hello").buffer));
    await waitFor(() => expect(upload).toHaveBeenCalledOnce());
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

  it("reports an upload revision conflict, opens no replace dialog, and refreshes the list", async () => {
    const list = stubList([]);
    vi.spyOn(browserApi, "uploadAgentSkill").mockRejectedValue(
      new ApiError(409, "conflict", SKILL_ERROR_CODES.REVISION_CONFLICT),
    );
    wrap(<SkillsPage agentId={AGENT_ID} />);
    await screen.findByText(/No Skills yet/);

    fireEvent.change(fileInput(), { target: { files: [archiveFile("notes.zip", "hello")] } });

    expect(await screen.findByText("This Skill changed while you were working. Reload and try again.")).toBeTruthy();
    expect(screen.queryByText(/Replace the existing Skill/)).toBeNull();
    // The list is invalidated so a Skill that changed underneath the user is re-read.
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
  });

  it("reports a revision conflict from a toggle without a replace dialog", async () => {
    stubList([skill({ enabled: true })]);
    vi.spyOn(browserApi, "updateAgentSkill").mockRejectedValue(
      new ApiError(409, "conflict", SKILL_ERROR_CODES.REVISION_CONFLICT),
    );
    wrap(<SkillsPage agentId={AGENT_ID} />);

    fireEvent.click(await screen.findByRole("switch", { name: "Enable Release notes writer" }));

    expect(await screen.findByText("This Skill changed while you were working. Reload and try again.")).toBeTruthy();
    const row = screen.getByRole("heading", { name: "Release notes writer" }).closest("li");
    expect(row).not.toBeNull();
    expect(
      within(row as HTMLElement).getByText("This Skill changed while you were working. Reload and try again."),
    ).toBeTruthy();
    expect(screen.queryByText(/Replace the existing Skill/)).toBeNull();
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

    fireEvent.click(await screen.findByRole("button", { name: "More actions for Release notes writer" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete skill" }));
    expect(await screen.findByText("Delete Release notes writer?")).toBeTruthy();
    expect(remove).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Delete Skill" }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith(AGENT_ID, SKILL_ID));
  });

  it("keeps deletion open while busy and shows a failed deletion inside its dialog", async () => {
    stubList([skill()]);
    const deletion = deferred<void>();
    const remove = vi.spyOn(browserApi, "removeAgentSkill").mockReturnValue(deletion.promise);
    wrap(<SkillsPage agentId={AGENT_ID} />);
    fireEvent.click(await screen.findByRole("button", { name: "More actions for Release notes writer" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete skill" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete Skill" }));

    expect(await screen.findByRole("button", { name: "Deleting…" })).toBeTruthy();
    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" });
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    expect(remove).toHaveBeenCalledOnce();

    await act(async () => deletion.reject(new ApiError(503, "Unavailable")));
    const dialog = screen.getByRole("alertdialog");
    expect(await within(dialog).findByText("The Skill request failed. Try again.")).toBeTruthy();
    expect((within(dialog).getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("heading", { name: "Release notes writer" })).toBeTruthy();
  });

  it("keeps replacement open while its upload is running", async () => {
    stubList([]);
    const replacement = deferred<Awaited<ReturnType<typeof browserApi.uploadAgentSkill>>>();
    const upload = vi
      .spyOn(browserApi, "uploadAgentSkill")
      .mockRejectedValueOnce(new ApiError(409, "conflict", SKILL_ERROR_CODES.NAME_CONFLICT))
      .mockReturnValueOnce(replacement.promise);
    wrap(<SkillsPage agentId={AGENT_ID} />);
    await screen.findByText(/No Skills yet/);
    fireEvent.change(fileInput(), { target: { files: [archiveFile("notes.zip", "hello")] } });
    fireEvent.click(await screen.findByRole("button", { name: "Replace Skill" }));

    expect(await screen.findByRole("button", { name: "Replacing…" })).toBeTruthy();
    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" });
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    expect(upload).toHaveBeenCalledTimes(2);

    await act(async () => replacement.resolve({ ...skill(), files: [], filesTruncated: false }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });

  /*
   * W3: unknown storage is not available storage. Before the first successful list the page knows
   * nothing, so it must fail closed — no enabled Upload, no empty text, no "unavailable" claim.
   */
  it("fails closed while the first list is still pending", () => {
    const list = vi.spyOn(browserApi, "agentSkills").mockReturnValue(new Promise(() => undefined) as never);
    wrap(<SkillsPage agentId={AGENT_ID} />);

    expect(uploadButton().disabled).toBe(true);
    expect(screen.queryByText(/No Skills yet/)).toBeNull();
    expect(screen.queryByText(/Skill storage is not configured/)).toBeNull();
    expect(screen.getByText("Loading")).toBeTruthy();
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("shows the error alone — not an empty list or an unavailable notice — when the first list fails", async () => {
    vi.spyOn(browserApi, "agentSkills").mockRejectedValue(new ApiError(503, "Skill storage unavailable"));
    wrap(<SkillsPage agentId={AGENT_ID} />);

    expect(await screen.findByText("Skill storage unavailable")).toBeTruthy();
    expect(uploadButton().disabled).toBe(true);
    expect(screen.queryByText(/No Skills yet/)).toBeNull();
    expect(screen.queryByText(/Skill storage is not configured/)).toBeNull();
  });

  it("retries a failed initial load from the error banner", async () => {
    const list = vi
      .spyOn(browserApi, "agentSkills")
      .mockRejectedValueOnce(new ApiError(503, "Skill storage unavailable"));
    wrap(<SkillsPage agentId={AGENT_ID} />);
    await screen.findByText("Skill storage unavailable");
    list.mockResolvedValue({ skills: [skill()], storage: "available" });

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByText("Release notes writer")).toBeTruthy();
    expect(screen.queryByText("Skill storage unavailable")).toBeNull();
  });

  it("enables Upload and shows the empty state for a successful empty list", async () => {
    stubList([], "available");
    wrap(<SkillsPage agentId={AGENT_ID} />);

    expect(await screen.findByText(/No Skills yet/)).toBeTruthy();
    expect(uploadButton().disabled).toBe(false);
  });

  it("keeps the last known list and storage when a background refetch fails", async () => {
    const list = stubList([skill()], "available");
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    wrap(<SkillsPage agentId={AGENT_ID} />, client);
    expect(await screen.findByText("Release notes writer")).toBeTruthy();

    list.mockRejectedValue(new ApiError(503, "Skill storage unavailable"));
    await client.refetchQueries({ queryKey: queryKeys.skills.agentSkills(AGENT_ID) });

    expect(await screen.findByText("Skill storage unavailable")).toBeTruthy();
    expect(screen.getByText("Release notes writer")).toBeTruthy();
    expect(uploadButton().disabled).toBe(false);
    expect(screen.queryByText(/No Skills yet/)).toBeNull();
  });

  /*
   * W4: a write the Server confirmed must survive a failed follow-up refetch. Before the fix every
   * `onSuccess` only invalidated, so a 503 on the refetch left the pre-mutation cache on screen and
   * the UI denied a write that had actually happened.
   */
  it("keeps an uploaded Skill on screen when the follow-up refetch fails", async () => {
    const list = stubList([], "available");
    const created = skill({ name: "Alpha", id: SKILL_ID });
    vi.spyOn(browserApi, "uploadAgentSkill").mockResolvedValue({ ...created, files: [], filesTruncated: false });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    wrap(<SkillsPage agentId={AGENT_ID} />, client);
    await screen.findByText(/No Skills yet/);

    // The list refetch the mutation triggers fails; the confirmed write must still reach the screen.
    list.mockRejectedValue(new ApiError(503, "Skill storage unavailable"));
    fireEvent.change(fileInput(), { target: { files: [archiveFile("alpha.tar.gz", "hello")] } });

    expect(await screen.findByText("Alpha")).toBeTruthy();
    expect(await screen.findByText("Skill storage unavailable")).toBeTruthy();
    expect(screen.queryByText(/Couldn/)).toBeNull();
    expect(screen.queryByText(/No Skills yet/)).toBeNull();
  });

  it("keeps the flipped toggle on screen when the follow-up refetch fails", async () => {
    const list = stubList([skill({ enabled: true })], "available");
    vi.spyOn(browserApi, "updateAgentSkill").mockResolvedValue({
      ...skill({ enabled: false }),
      files: [],
      filesTruncated: false,
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    wrap(<SkillsPage agentId={AGENT_ID} />, client);
    const toggle = await screen.findByRole("switch", { name: "Enable Release notes writer" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");

    list.mockRejectedValue(new ApiError(503, "Skill storage unavailable"));
    fireEvent.click(toggle);

    await waitFor(() =>
      expect(screen.getByRole("switch", { name: "Enable Release notes writer" }).getAttribute("aria-checked")).toBe(
        "false",
      ),
    );
    expect(await screen.findByText("Skill storage unavailable")).toBeTruthy();
  });

  it("keeps a deleted Skill off screen when the follow-up refetch fails", async () => {
    const list = stubList([skill()], "available");
    vi.spyOn(browserApi, "removeAgentSkill").mockResolvedValue(undefined);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    wrap(<SkillsPage agentId={AGENT_ID} />, client);
    fireEvent.click(await screen.findByRole("button", { name: "More actions for Release notes writer" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete skill" }));
    await screen.findByText("Delete Release notes writer?");

    list.mockRejectedValue(new ApiError(503, "Skill storage unavailable"));
    fireEvent.click(screen.getByRole("button", { name: "Delete Skill" }));

    await waitFor(() => expect(screen.queryByText("Release notes writer")).toBeNull());
    expect(await screen.findByText("Skill storage unavailable")).toBeTruthy();
    expect(screen.queryByText(/Couldn/)).toBeNull();
  });

  it("renders the storage-unavailable notice from the list response with no extra request", async () => {
    const list = stubList([skill()], "unavailable");
    const detail = vi.spyOn(browserApi, "agentSkill");
    const upload = vi.spyOn(browserApi, "uploadAgentSkill");
    wrap(<SkillsPage agentId={AGENT_ID} />);

    expect(await screen.findByText(/Skill storage is not configured/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Add skill" }) as HTMLButtonElement).disabled).toBe(true);
    // The Skill is still listed, with download disabled in its More menu.
    expect(screen.getByText("Release notes writer")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "More actions for Release notes writer" }));
    const download = await screen.findByRole("menuitem", { name: "Download skill" });
    expect(download.getAttribute("aria-disabled")).toBe("true");

    expect(list).toHaveBeenCalledTimes(1);
    expect(detail).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
  });
});
