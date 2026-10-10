import type { RemoteSkillCandidate, RemoteSkillInstallResult } from "@opentag/shared/browser";
import { SKILL_ERROR_CODES } from "@opentag/shared/browser";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, browserApi } from "../../api.js";
import { InstallSkillDialog } from "./install-skill-dialog.js";

/**
 * The install dialog's contract: a lookup writes nothing and shows what the source holds, the user
 * chooses by name, and the install reports what happened to every name that was asked for.
 */

const AGENT_ID = "1a63a21e-f6c7-4474-91ea-4dabf0566a24";

function candidate(overrides: Partial<RemoteSkillCandidate> = {}): RemoteSkillCandidate {
  return {
    name: "demo",
    description: "A demo Skill",
    path: "skills/demo",
    fileCount: 2,
    alreadyInstalled: false,
    fingerprint: `sha256:${"a".repeat(64)}`,
    ...overrides,
  };
}

function renderDialog() {
  const onClose = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  render(<InstallSkillDialog agentId={AGENT_ID} onClose={onClose} />, { wrapper });
  return { onClose, client };
}

function stubResolve(skills: RemoteSkillCandidate[] | Error) {
  const resolve = vi.spyOn(browserApi, "resolveRemoteSkills");
  if (skills instanceof Error) resolve.mockRejectedValue(skills);
  else resolve.mockResolvedValue({ source: { kind: "github", url: "https://github.com/o/r.git" }, skills });
  return resolve;
}

function stubInstall(results: RemoteSkillInstallResult[] | Error) {
  const install = vi.spyOn(browserApi, "installRemoteSkills");
  if (results instanceof Error) install.mockRejectedValue(results);
  else install.mockResolvedValue({ results });
  return install;
}

async function lookUp(source = "owner/repo") {
  fireEvent.change(screen.getByLabelText("URL"), { target: { value: source } });
  fireEvent.keyDown(screen.getByLabelText("URL"), { key: "Enter" });
  await waitFor(() => expect(screen.queryByText("Loading skills…")).toBeNull());
}

afterEach(() => vi.restoreAllMocks());

describe("InstallSkillDialog", () => {
  it("lists what the source holds without installing anything", async () => {
    const resolve = stubResolve([
      candidate(),
      candidate({ name: "other", description: "Another Skill", path: "skills/other" }),
    ]);
    const install = stubInstall([]);
    renderDialog();

    expect(screen.getByPlaceholderText("Paste a repository or skill URL")).toBe(screen.getByLabelText("URL"));
    expect(screen.queryByText("URL")).toBeNull();
    expect((screen.getByRole("button", { name: /^Install (skill|\d+ skills)$/ }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    await lookUp();

    expect(resolve).toHaveBeenCalledWith(AGENT_ID, "owner/repo");
    expect(install).not.toHaveBeenCalled();
    const checkbox = screen.getByRole("checkbox", { name: "demo" });
    expect(checkbox).toBeTruthy();
    expect(document.getElementById(checkbox.getAttribute("aria-describedby") ?? "")?.textContent).toBe("A demo Skill");
    expect(screen.getByText("A demo Skill")).toBeTruthy();
    expect(screen.getByText("Skills found at this URL")).toBeTruthy();
  });

  it("keeps the install action disabled until something is selected", async () => {
    stubResolve([candidate(), candidate({ name: "other", description: "Another Skill" })]);
    renderDialog();
    await lookUp();

    const confirm = () => screen.getByRole("button", { name: /^Install (skill|\d+ skills)$/ }) as HTMLButtonElement;
    expect(confirm().disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: "demo" }));
    expect(confirm().disabled).toBe(false);
    fireEvent.click(screen.getByRole("checkbox", { name: "demo" }));
    expect(confirm().disabled).toBe(true);
  });

  it("installs the selection and reports one line per name", async () => {
    stubResolve([candidate(), candidate({ name: "other", description: "Another Skill" })]);
    const install = stubInstall([
      { name: "demo", status: "installed" },
      { name: "other", status: "failed", errorCode: SKILL_ERROR_CODES.SOURCE_INVALID },
    ]);
    renderDialog();
    await lookUp();

    fireEvent.click(screen.getByRole("checkbox", { name: "demo" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "other" }));
    fireEvent.click(screen.getByRole("button", { name: /^Install (skill|\d+ skills)$/ }));

    await waitFor(() => expect(screen.getByText("Installed")).toBeTruthy());
    // Each selection carries the fingerprint the preview reported, so the Server installs exactly
    // the content the user saw.
    expect(install).toHaveBeenCalledWith(AGENT_ID, {
      source: "owner/repo",
      selections: [
        { name: "demo", fingerprint: `sha256:${"a".repeat(64)}` },
        { name: "other", fingerprint: `sha256:${"a".repeat(64)}` },
      ],
    });
    const results = screen.getByRole("list", { name: "Install results" });
    expect(within(results).getByText("demo")).toBeTruthy();
    expect(within(results).getByText("other")).toBeTruthy();
    expect(within(results).getByText(/could not be understood/)).toBeTruthy();
  });

  it("shows an already installed candidate without offering another install", async () => {
    stubResolve([candidate({ alreadyInstalled: true })]);
    renderDialog();
    await lookUp();
    expect(screen.getByText("Installed")).toBeTruthy();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect((screen.getByRole("button", { name: "Install skill" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows a candidate the Server cannot package, disabled, with the reason", async () => {
    stubResolve([candidate({ name: "git", unavailableReason: "name_reserved" })]);
    renderDialog();
    await lookUp();

    expect(screen.getByText("Its name is reserved by the platform")).toBeTruthy();
    expect(screen.queryByRole("checkbox")).toBeNull();
    // Nothing is selectable, so the action stays unavailable rather than offering a doomed install.
    expect((screen.getByRole("button", { name: /^Install (skill|\d+ skills)$/ }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("installs from the address that produced the list, not from a later edit", async () => {
    stubResolve([candidate()]);
    const install = stubInstall([{ name: "demo", status: "installed" }]);
    renderDialog();
    await lookUp("owner/first");

    // Editing the field after a preview drops the preview: the list on screen belongs to `owner/first`,
    // so installing under `owner/second` would install a Skill this user never saw.
    fireEvent.change(screen.getByLabelText("URL"), { target: { value: "owner/second" } });
    expect(screen.queryByText("A demo Skill")).toBeNull();
    expect((screen.getByRole("button", { name: /^Install (skill|\d+ skills)$/ }) as HTMLButtonElement).disabled).toBe(
      true,
    );

    await lookUp("owner/second");
    fireEvent.click(screen.getByRole("button", { name: /^Install (skill|\d+ skills)$/ }));

    await waitFor(() => expect(install).toHaveBeenCalled());
    expect(install).toHaveBeenCalledWith(AGENT_ID, expect.objectContaining({ source: "owner/second" }));
  });

  it("explains a source that holds nothing without losing the address", async () => {
    stubResolve([]);
    renderDialog();
    await lookUp("owner/empty");

    expect(screen.getByText("No Skills were found at that source.")).toBeTruthy();
    expect((screen.getByLabelText("URL") as HTMLInputElement).value).toBe("owner/empty");
  });

  it("shows a readable reason and keeps the address when the lookup fails", async () => {
    stubResolve(new ApiError(502, "unreachable", SKILL_ERROR_CODES.SOURCE_UNREACHABLE));
    renderDialog();
    await lookUp("owner/gone");

    expect(screen.getByText(/could not be reached/)).toBeTruthy();
    expect((screen.getByLabelText("URL") as HTMLInputElement).value).toBe("owner/gone");
  });

  it("reports a failed install without pretending anything was installed", async () => {
    stubResolve([candidate()]);
    stubInstall(new ApiError(503, "no storage", SKILL_ERROR_CODES.STORAGE_UNAVAILABLE));
    renderDialog();
    await lookUp();

    const list = screen.getByRole("region", { name: "Skill found at this URL" });
    list.scrollTop = 200;
    fireEvent.click(screen.getByRole("button", { name: /^Install (skill|\d+ skills)$/ }));

    await waitFor(() => expect(screen.getByText(/storage is unavailable/)).toBeTruthy());
    expect(list.scrollTop).toBe(0);
    expect(screen.queryByRole("list", { name: "Install results" })).toBeNull();
  });

  it("previews a pasted URL once, selecting the sole candidate without installing", async () => {
    const resolve = stubResolve([candidate()]);
    const install = stubInstall([]);
    renderDialog();
    fireEvent.paste(screen.getByLabelText("URL"), { clipboardData: { getData: () => "https://github.com/o/r" } });
    expect(await screen.findByText("Skill found at this URL")).toBeTruthy();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect((screen.getByRole("button", { name: "Install skill" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.blur(screen.getByLabelText("URL"));
    expect(resolve).toHaveBeenCalledOnce();
    expect(install).not.toHaveBeenCalled();
  });

  it("closes after a successful explicit install", async () => {
    stubResolve([candidate()]);
    stubInstall([{ name: "demo", status: "installed" }]);
    const { onClose } = renderDialog();
    await lookUp();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Install skill" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });

  it("ignores an old response while a newer source is being read", async () => {
    let finishOld!: (value: Awaited<ReturnType<typeof browserApi.resolveRemoteSkills>>) => void;
    const old = new Promise<Awaited<ReturnType<typeof browserApi.resolveRemoteSkills>>>((resolve) => {
      finishOld = resolve;
    });
    vi.spyOn(browserApi, "resolveRemoteSkills")
      .mockReturnValueOnce(old)
      .mockResolvedValueOnce({
        source: { kind: "github", url: "https://github.com/o/new.git" },
        skills: [candidate({ name: "new-skill" })],
      });
    const install = stubInstall([{ name: "new-skill", status: "installed" }]);
    renderDialog();
    fireEvent.change(screen.getByLabelText("URL"), { target: { value: "owner/old" } });
    fireEvent.keyDown(screen.getByLabelText("URL"), { key: "Enter" });
    await lookUp("owner/new");
    await act(async () => {
      finishOld({
        source: { kind: "github", url: "https://github.com/o/old.git" },
        skills: [candidate({ name: "old-skill" })],
      });
    });
    await waitFor(() => expect(screen.getByText("new-skill")).toBeTruthy());
    expect(screen.queryByText("old-skill")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Install skill" }));
    await waitFor(() =>
      expect(install).toHaveBeenCalledWith(AGENT_ID, expect.objectContaining({ source: "owner/new" })),
    );
  });

  it("retries a failed source only after the explicit retry action", async () => {
    const resolve = stubResolve(new ApiError(502, "gone", SKILL_ERROR_CODES.SOURCE_UNREACHABLE));
    renderDialog();
    await lookUp();
    expect(await screen.findByText("That source could not be reached.")).toBeTruthy();
    resolve.mockResolvedValueOnce({
      source: { kind: "github", url: "https://github.com/o/r.git" },
      skills: [candidate()],
    });
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Skill found at this URL")).toBeTruthy();
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it("ignores a late lookup error after the source is edited", async () => {
    let rejectOld!: (reason: Error) => void;
    vi.spyOn(browserApi, "resolveRemoteSkills").mockReturnValueOnce(
      new Promise((_, reject) => {
        rejectOld = reject;
      }),
    );
    renderDialog();
    fireEvent.change(screen.getByLabelText("URL"), { target: { value: "owner/old" } });
    fireEvent.keyDown(screen.getByLabelText("URL"), { key: "Enter" });
    fireEvent.change(screen.getByLabelText("URL"), { target: { value: "owner/new" } });
    await act(async () => rejectOld(new ApiError(502, "gone", SKILL_ERROR_CODES.SOURCE_UNREACHABLE)));
    expect(screen.queryByText("That source could not be reached.")).toBeNull();
    expect(screen.queryByText("Loading skills…")).toBeNull();
    expect((screen.getByLabelText("URL") as HTMLInputElement).value).toBe("owner/new");
  });

  it("resolves a typed source on blur while Cancel skips the lookup", async () => {
    const resolve = stubResolve([candidate()]);
    const { onClose } = renderDialog();
    fireEvent.change(screen.getByLabelText("URL"), { target: { value: "owner/repo" } });
    fireEvent.blur(screen.getByLabelText("URL"), {
      relatedTarget: screen.getByRole("button", { name: "Cancel" }),
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(resolve).not.toHaveBeenCalled();
    fireEvent.blur(screen.getByLabelText("URL"));
    expect(await screen.findByText("Skill found at this URL")).toBeTruthy();
    expect(resolve).toHaveBeenCalledOnce();
  });
});
