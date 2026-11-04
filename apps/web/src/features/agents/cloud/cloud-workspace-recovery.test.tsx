import type {
  AccountSandboxRunnerStatusResponse,
  AgentCloudOverview,
  CloudSessionSummary,
} from "@opentag/shared/browser";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { renderInRouter } from "../../../__tests__/support/router.js";
import { ApiError, browserApi } from "../../../api.js";
import { CloudWorkspaceRecovery } from "./cloud-workspace-recovery.js";

const AGENT = "11111111-1111-4111-8111-111111111111";
const SESSION = "33333333-3333-4333-8333-333333333333";
const SANDBOX = "44444444-4444-4444-8444-444444444444";
const TIME = "2026-11-02T00:00:00.000Z";
function row(overrides: Partial<CloudSessionSummary> = {}): CloudSessionSummary {
  return {
    sessionId: SESSION,
    sandboxId: SANDBOX,
    kind: "channel",
    lifecycle: "ready",
    environmentGeneration: 2,
    runnerConnected: true,
    runnerReady: false,
    taskState: "idle",
    lastErrorCode: null,
    lastErrorAt: null,
    updatedAt: TIME,
    canRelease: true,
    canDiscard: false,
    ...overrides,
  };
}
function overview(rows: CloudSessionSummary[] = [row()], nextCursor: string | null = null): AgentCloudOverview {
  return {
    agentId: AGENT,
    observedAt: TIME,
    capacity: { accountUsed: 1, accountLimit: 3 },
    counts: { allocated: 1, queued: 0, running: 0, attention: rows.filter((entry) => entry.lastErrorCode).length },
    sessions: rows,
    nextCursor,
  };
}
function status(overrides: Partial<AccountSandboxRunnerStatusResponse> = {}): AccountSandboxRunnerStatusResponse {
  return {
    sandboxId: SANDBOX,
    sessionId: SESSION,
    lifecycle: "ready",
    environmentGeneration: 2,
    currentResourceName: "projects/p/locations/r/instances/fixture",
    currentResourceUid: "uid",
    currentOperationName: null,
    runnerConnected: true,
    runnerReady: false,
    runnerReadiness: null,
    lastErrorCode: null,
    lastErrorAt: null,
    updatedAt: TIME,
    ...overrides,
  };
}
function setup(rows = [row()]) {
  let page = overview(rows);
  const read = vi
    .spyOn(browserApi, "agentCloudOverview")
    .mockImplementation(async (_agent, options) => (options?.limit === 100 ? overview([]) : page));
  const readStatus = vi.spyOn(browserApi, "cloudWorkspaceStatus").mockResolvedValue(status());
  const release = vi
    .spyOn(browserApi, "releaseCloudWorkspace")
    .mockResolvedValue(status({ lifecycle: "unallocated", currentResourceName: null }));
  return {
    read,
    readStatus,
    release,
    setPage(value: AgentCloudOverview) {
      page = value;
    },
  };
}
async function renderPanel() {
  await renderInRouter(<CloudWorkspaceRecovery agentId={AGENT} initialOpen />);
  return screen.findByRole("listitem", { name: "Chat · 33333333" });
}
afterEach(() => vi.restoreAllMocks());

it("keeps recovery behind an explicit diagnostics destination, even without a failure marker", async () => {
  const fixture = setup();
  const { rerender } = await renderInRouter(<CloudWorkspaceRecovery agentId={AGENT} />);
  expect(screen.queryByRole("region", { name: "Workspace diagnostics" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Recover workspace" })).toBeNull();
  expect(fixture.read).not.toHaveBeenCalledWith(AGENT, { limit: 20 });
  rerender(<CloudWorkspaceRecovery agentId={AGENT} initialOpen />);
  await screen.findByRole("region", { name: "Workspace diagnostics" });
  await screen.findByRole("button", { name: "Save and release" });
  expect(fixture.read).toHaveBeenCalledWith(AGENT, { limit: 20 });
  expect(fixture.readStatus).not.toHaveBeenCalled();
  expect(fixture.release).not.toHaveBeenCalled();
  rerender(<CloudWorkspaceRecovery agentId={AGENT} />);
  expect(screen.queryByRole("region", { name: "Workspace diagnostics" })).toBeNull();
  rerender(<CloudWorkspaceRecovery agentId={AGENT} initialOpen />);
  await screen.findByRole("region", { name: "Workspace diagnostics" });
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(screen.queryByRole("region", { name: "Workspace diagnostics" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Recover workspace" })).toBeNull();
});

it("captures the allocation generation and accepts only one release while busy", async () => {
  const fixture = setup();
  let finish!: (value: AccountSandboxRunnerStatusResponse) => void;
  fixture.release.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const item = await renderPanel();
  const button = within(item).getByRole("button", { name: "Save and release" });
  act(() => {
    fireEvent.click(button);
    fireEvent.click(button);
  });
  await waitFor(() => expect(fixture.release).toHaveBeenCalledExactlyOnceWith(SANDBOX, { environmentGeneration: 2 }));
  expect(fixture.readStatus).toHaveBeenCalledExactlyOnceWith(SANDBOX);
  expect(button).toHaveProperty("disabled", true);
  fixture.setPage(overview([row({ lifecycle: "unallocated", canRelease: false })]));
  await act(async () => {
    finish(status({ lifecycle: "unallocated", currentResourceName: null }));
  });
  expect(await screen.findAllByText("Environment released")).not.toHaveLength(0);
  expect(fixture.release).toHaveBeenCalledOnce();
});

it("requires a second confirmation to discard and preserves the selected generation", async () => {
  const fixture = setup([row({ lifecycle: "releasing", lastErrorCode: "workspace_save_failed", canDiscard: true })]);
  const item = await renderPanel();
  const discard = within(item).getByRole("button", { name: "Discard changes and release" });
  fireEvent.click(discard);
  let dialog = await screen.findByRole("alertdialog");
  expect(dialog.textContent).toContain("permanently lost");
  expect(dialog.textContent).toContain("Completed external actions are not undone");
  expect(fixture.release).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(fixture.release).not.toHaveBeenCalled();
  fireEvent.click(discard);
  dialog = await screen.findByRole("alertdialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "Discard unsaved changes and release" }));
  await waitFor(() =>
    expect(fixture.release).toHaveBeenCalledExactlyOnceWith(SANDBOX, {
      environmentGeneration: 2,
      discardUnsavedChanges: true,
    }),
  );
});

it.each([false, true])("refreshes the save-failure notice after recovery (discard: %s)", async (discard) => {
  const fixture = setup();
  let page = overview([row({ lifecycle: "releasing", lastErrorCode: "workspace_save_failed", canDiscard: true })]);
  fixture.read.mockImplementation(async () => page);
  fixture.release.mockImplementation(async () => {
    page = overview([row({ lifecycle: "unallocated", canRelease: false })]);
    return status({ lifecycle: "unallocated", currentResourceName: null });
  });
  const item = await renderPanel();
  await screen.findByRole("alert");
  fireEvent.click(
    within(item).getByRole("button", { name: discard ? "Discard changes and release" : "Retry save and release" }),
  );
  if (discard) {
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Discard unsaved changes and release" }));
  }
  await screen.findAllByText("Environment released");
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  expect(fixture.release).toHaveBeenCalledOnce();
});

it.each(["running", "queued", "unknown"] as const)(
  "confirms before saving and releasing a %s conversation",
  async (taskState) => {
    const fixture = setup([row({ taskState })]);
    const item = await renderPanel();
    const save = within(item).getByRole("button", { name: "Save and release" });
    fireEvent.click(save);
    let dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("interrupts its current execution");
    expect(fixture.readStatus).not.toHaveBeenCalled();
    expect(fixture.release).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(fixture.release).not.toHaveBeenCalled();
    fireEvent.click(save);
    dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Save and release" }));
    await waitFor(() => expect(fixture.release).toHaveBeenCalledExactlyOnceWith(SANDBOX, { environmentGeneration: 2 }));
  },
);

it("refuses a replacement environment even when an old discard confirmation stays open", async () => {
  const fixture = setup([row({ lifecycle: "releasing", lastErrorCode: "workspace_save_failed", canDiscard: true })]);
  const item = await renderPanel();
  fireEvent.click(within(item).getByRole("button", { name: "Discard changes and release" }));
  const dialog = await screen.findByRole("alertdialog");
  fixture.readStatus.mockResolvedValue(status({ environmentGeneration: 3 }));
  fixture.setPage(overview([row({ environmentGeneration: 3 })]));
  fireEvent.click(within(dialog).getByRole("button", { name: "Discard unsaved changes and release" }));
  await screen.findByText(/now has a different environment/);
  expect(fixture.release).not.toHaveBeenCalled();
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
});

it("reads back after an uncertain mutation and never automatically resends it", async () => {
  const fixture = setup();
  fixture.release.mockRejectedValueOnce(new TypeError("private upstream detail"));
  const item = await renderPanel();
  fireEvent.click(within(item).getByRole("button", { name: "Save and release" }));
  await screen.findByText(/recovery result could not be confirmed/);
  await waitFor(() => expect(fixture.readStatus).toHaveBeenCalledTimes(2));
  expect(fixture.release).toHaveBeenCalledOnce();
  expect(document.body.textContent).not.toContain("private upstream detail");
  await waitFor(() =>
    expect(within(item).getByRole("button", { name: "Save and release" })).toHaveProperty("disabled", false),
  );
  fireEvent.click(within(item).getByRole("button", { name: "Save and release" }));
  await waitFor(() => expect(fixture.release).toHaveBeenCalledTimes(2));
  expect(fixture.readStatus).toHaveBeenCalledTimes(3);
});

it("does not mutate when the fresh allocation status cannot be read", async () => {
  const fixture = setup();
  fixture.readStatus.mockRejectedValue(new Error("private status detail"));
  const item = await renderPanel();
  fireEvent.click(within(item).getByRole("button", { name: "Save and release" }));
  await screen.findByText(/Workspace status could not be read/);
  expect(fixture.release).not.toHaveBeenCalled();
  expect(document.body.textContent).not.toContain("private status detail");
});

it("reports unavailable status after an uncertain release without inventing success", async () => {
  const fixture = setup();
  fixture.readStatus.mockResolvedValueOnce(status()).mockRejectedValue(new Error("private readback"));
  fixture.release.mockRejectedValue(new Error("private timeout"));
  const item = await renderPanel();
  fireEvent.click(within(item).getByRole("button", { name: "Save and release" }));
  await screen.findByText(/result and current status could not be confirmed/);
  expect(fixture.release).toHaveBeenCalledOnce();
  expect(screen.queryByText("Environment released")).toBeNull();
  expect(document.body.textContent).not.toContain("private");
});

it("does not treat a failed overview read as an empty workspace inventory", async () => {
  const fixture = setup();
  fixture.read.mockImplementation(async (_agent, options) => {
    if (options?.limit === 100) return overview([]);
    throw new Error("private inventory detail");
  });
  await renderInRouter(<CloudWorkspaceRecovery agentId={AGENT} initialOpen />);
  await screen.findByText(/Workspace status could not be read/);
  expect(screen.queryByText("No conversation workspaces are available.")).toBeNull();
  expect(screen.queryByRole("button", { name: "Save and release" })).toBeNull();
  expect(document.body.textContent).not.toContain("private inventory detail");
});

it("hides cached rows after access is revoked", async () => {
  const fixture = setup();
  await renderPanel();
  fixture.read.mockRejectedValue(new ApiError(403, "private forbidden"));
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await screen.findByText(/Workspace status could not be read/);
  expect(screen.queryByRole("listitem", { name: "Chat · 33333333" })).toBeNull();
  expect(fixture.release).not.toHaveBeenCalled();
});

it("loads later pages and honors the server's available actions", async () => {
  const fixture = setup();
  fixture.read.mockImplementation(async (_agent, options) => {
    if (options?.limit === 100) return overview([]);
    return options?.cursor
      ? overview([row({ kind: "internal", sessionId: "55555555-5555-4555-8555-555555555555", canRelease: false })])
      : overview([row()], SESSION);
  });
  await renderPanel();
  fireEvent.click(screen.getByRole("button", { name: "Load more conversations" }));
  const next = await screen.findByRole("listitem", { name: "Internal conversation · 55555555" });
  expect(fixture.read).toHaveBeenCalledWith(AGENT, { limit: 20, cursor: SESSION });
  expect(within(next).getByRole("button", { name: "Save and release" })).toHaveProperty("disabled", true);
});

it("keeps a release in progress noninteractive", async () => {
  setup([row({ lifecycle: "releasing" })]);
  const item = await renderPanel();
  expect(within(item).getByText("Release in progress")).toBeTruthy();
  expect(within(item).getByRole("button", { name: "Save and release" })).toHaveProperty("disabled", true);
});

it("does not submit another release for an already released allocation", async () => {
  const fixture = setup();
  fixture.readStatus.mockResolvedValue(status({ lifecycle: "unallocated", currentResourceName: null }));
  const item = await renderPanel();
  fireEvent.click(within(item).getByRole("button", { name: "Save and release" }));
  await screen.findByText("Environment released");
  expect(fixture.release).not.toHaveBeenCalled();
});
