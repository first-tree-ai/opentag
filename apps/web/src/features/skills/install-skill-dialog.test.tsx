import type { RemoteSkillCandidate, RemoteSkillInstallResult } from "@opentag/shared/browser";
import { SKILL_ERROR_CODES } from "@opentag/shared/browser";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  fireEvent.change(screen.getByLabelText("Source"), { target: { value: source } });
  fireEvent.click(screen.getByRole("button", { name: "Find Skills" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "Looking up…" })).toBeNull());
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

    expect((screen.getByRole("button", { name: "Install selected" }) as HTMLButtonElement).disabled).toBe(true);
    await lookUp();

    expect(resolve).toHaveBeenCalledWith(AGENT_ID, "owner/repo");
    expect(install).not.toHaveBeenCalled();
    expect(screen.getByRole("checkbox", { name: "demo" })).toBeTruthy();
    expect(screen.getByText("A demo Skill")).toBeTruthy();
    expect(screen.getByText(/skills\/other/)).toBeTruthy();
  });

  it("keeps the install action disabled until something is selected", async () => {
    stubResolve([candidate(), candidate({ name: "other", description: "Another Skill" })]);
    renderDialog();
    await lookUp();

    const confirm = () => screen.getByRole("button", { name: "Install selected" }) as HTMLButtonElement;
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

    fireEvent.click(screen.getByRole("button", { name: "Select all" }));
    fireEvent.click(screen.getByRole("button", { name: "Install selected" }));

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

  it("marks a candidate that already exists and still allows choosing it", async () => {
    stubResolve([candidate({ alreadyInstalled: true })]);
    renderDialog();
    await lookUp();

    expect(screen.getByText("Already installed — it will be skipped")).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: "demo" }));
    expect((screen.getByRole("button", { name: "Install selected" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("shows a candidate the Server cannot package, disabled, with the reason", async () => {
    stubResolve([candidate({ name: "git", unavailableReason: "name_reserved" })]);
    renderDialog();
    await lookUp();

    expect(screen.getByText("Its name is reserved by the platform")).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "git" }).getAttribute("aria-disabled")).toBe("true");
    // Nothing is selectable, so the action stays unavailable rather than offering a doomed install.
    expect((screen.getByRole("button", { name: "Install selected" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("installs from the address that produced the list, not from a later edit", async () => {
    stubResolve([candidate()]);
    const install = stubInstall([{ name: "demo", status: "installed" }]);
    renderDialog();
    await lookUp("owner/first");

    // Editing the field after a preview drops the preview: the list on screen belongs to `owner/first`,
    // so installing under `owner/second` would install a Skill this user never saw.
    fireEvent.change(screen.getByLabelText("Source"), { target: { value: "owner/second" } });
    expect(screen.queryByRole("checkbox", { name: "demo" })).toBeNull();
    expect((screen.getByRole("button", { name: "Install selected" }) as HTMLButtonElement).disabled).toBe(true);

    await lookUp("owner/second");
    fireEvent.click(screen.getByRole("checkbox", { name: "demo" }));
    fireEvent.click(screen.getByRole("button", { name: "Install selected" }));

    await waitFor(() => expect(install).toHaveBeenCalled());
    expect(install).toHaveBeenCalledWith(AGENT_ID, expect.objectContaining({ source: "owner/second" }));
  });

  it("explains a source that holds nothing without losing the address", async () => {
    stubResolve([]);
    renderDialog();
    await lookUp("owner/empty");

    expect(screen.getByText("No Skills were found at that source.")).toBeTruthy();
    expect((screen.getByLabelText("Source") as HTMLInputElement).value).toBe("owner/empty");
  });

  it("shows a readable reason and keeps the address when the lookup fails", async () => {
    stubResolve(new ApiError(502, "unreachable", SKILL_ERROR_CODES.SOURCE_UNREACHABLE));
    renderDialog();
    await lookUp("owner/gone");

    expect(screen.getByText(/could not be reached/)).toBeTruthy();
    expect((screen.getByLabelText("Source") as HTMLInputElement).value).toBe("owner/gone");
  });

  it("reports a failed install without pretending anything was installed", async () => {
    stubResolve([candidate()]);
    stubInstall(new ApiError(503, "no storage", SKILL_ERROR_CODES.STORAGE_UNAVAILABLE));
    renderDialog();
    await lookUp();

    fireEvent.click(screen.getByRole("checkbox", { name: "demo" }));
    fireEvent.click(screen.getByRole("button", { name: "Install selected" }));

    await waitFor(() => expect(screen.getByText(/storage is unavailable/)).toBeTruthy());
    expect(screen.queryByRole("list", { name: "Install results" })).toBeNull();
  });
});
