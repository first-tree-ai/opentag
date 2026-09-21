import type {
  AccountComputerSummary,
  AccountSandboxRunnerStatusResponse,
  AgentCloudOverview,
  AgentDetail,
  CloudSessionSummary,
  TaskDetail,
  TaskSummary,
} from "@opentag/shared/browser";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderInRouter } from "../../../__tests__/support/router.js";
import { ApiError, browserApi, CancelledRequestError } from "../../../api.js";
import { queryKeys } from "../../../query/keys.js";
import { TaskDetailPage } from "../../tasks-page.js";
import type { AgentDetailView } from "../agent-model.js";
import { useComputersQuery } from "../agent-queries.js";
import { AgentComputerSettings } from "../agent-settings/agent-computer-settings.js";
import { AgentCloudOverviewPanel, CloudSessionEnvironmentCard } from "./cloud-environment.js";

const AGENT_ID = "3f1d3a2c-1f2e-4a1b-9c3d-5e6f70819a2b";
const OTHER_AGENT_ID = "5c4b3a2d-1e0f-4998-8877-66554433221a";
const COMPUTER_ID = "8c2b1d4e-5a6f-4b7c-8d9e-0f1a2b3c4d5e";
const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_SESSION_ID = "22222222-2222-4222-8222-222222222222";
const SANDBOX_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_SANDBOX_ID = "44444444-4444-4444-8444-444444444444";

function sessionSummary(overrides: Partial<CloudSessionSummary> = {}): CloudSessionSummary {
  return {
    sessionId: SESSION_ID,
    sandboxId: SANDBOX_ID,
    kind: "channel",
    lifecycle: "ready",
    environmentGeneration: 3,
    runnerConnected: true,
    runnerReady: true,
    taskState: "idle",
    lastErrorCode: null,
    lastErrorAt: null,
    updatedAt: "2026-09-20T00:00:00.000Z",
    canRelease: true,
    canDiscard: false,
    ...overrides,
  };
}

function overview(overrides: Partial<AgentCloudOverview> = {}): AgentCloudOverview {
  return {
    agentId: AGENT_ID,
    observedAt: "2026-09-20T00:00:00.000Z",
    capacity: { accountUsed: 1, accountLimit: 3 },
    counts: { allocated: 1, queued: 0, running: 0, attention: 0 },
    sessions: [],
    nextCursor: null,
    ...overrides,
  };
}

function stopStatus(overrides: Partial<AccountSandboxRunnerStatusResponse> = {}): AccountSandboxRunnerStatusResponse {
  return {
    sandboxId: SANDBOX_ID,
    sessionId: SESSION_ID,
    lifecycle: "unallocated",
    environmentGeneration: 3,
    currentResourceName: null,
    currentResourceUid: null,
    currentOperationName: null,
    runnerConnected: false,
    runnerReady: false,
    runnerReadiness: null,
    lastErrorCode: null,
    lastErrorAt: null,
    updatedAt: "2026-09-20T00:01:00.000Z",
    ...overrides,
  };
}

function agentView(
  kind: "cloud" | "local",
  computerState: "ready" | "action_required" | "unconfirmed" = "ready",
): AgentDetailView {
  return {
    id: AGENT_ID,
    name: "reviewer",
    displayName: "Reviewer",
    createdBy: { userId: "9a8b7c6d-5e4f-4a3b-8c1d-0e9f8a7b6c5d", displayName: "Ada" },
    computer: {
      computerId: COMPUTER_ID,
      displayName: kind === "cloud" ? "OpenTag Cloud" : "Ada's Mac",
      platform: kind === "cloud" ? "linux" : "darwin",
    },
    runtimeProvider: kind === "cloud" ? "pi" : "codex",
    receiveMode: "mention_only",
    status: "active",
    createdAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
    activity: { state: "idle" },
    availability: {
      state: computerState === "ready" ? "ready" : computerState === "unconfirmed" ? "unconfirmed" : "action_required",
      reason:
        computerState === "ready"
          ? null
          : computerState === "unconfirmed"
            ? "computer_unconfirmed"
            : "computer_offline",
      lastConfirmedAt: null,
      dependencies: {
        computer: { state: computerState, lastConfirmedAt: null },
        runtime: { provider: kind === "cloud" ? "pi" : "codex", status: "ready" },
        handoff: { state: "ready", lastConfirmedAt: null },
        channel: { state: "connected", provider: "feishu", botDisplayName: "Reviewer" },
      },
    },
    messaging: { kind: "ready", value: undefined },
    computerKind: kind,
  };
}

afterEach(() => vi.restoreAllMocks());

describe("AgentCloudOverviewPanel reads", () => {
  it("reports an unconfirmed read with a retry, never zeroed counts or an empty list", async () => {
    const read = vi
      .spyOn(browserApi, "agentCloudOverview")
      .mockRejectedValue(new ApiError(503, "The Server is unavailable", "SERVICE_UNAVAILABLE"));

    await renderInRouter(<AgentCloudOverviewPanel agentId={AGENT_ID} />);

    expect(await screen.findByText(/cannot be confirmed right now/)).toBeTruthy();
    // Nothing that a successful read would show is fabricated: no zero counts, no empty list.
    expect(screen.queryByText("Processing")).toBeNull();
    expect(screen.queryByText(/No Session has a Cloud environment yet/)).toBeNull();
    expect(screen.queryByText("Environment ready")).toBeNull();

    read.mockResolvedValue(overview({ sessions: [sessionSummary()] }));
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByText("Environment ready")).toBeTruthy();
    expect(screen.queryByText(/cannot be confirmed right now/)).toBeNull();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("pages Session environments and keeps the Agent-wide counts from the first page", async () => {
    const firstPage = overview({
      capacity: { accountUsed: 1, accountLimit: 3 },
      counts: { allocated: 2, queued: 0, running: 2, attention: 0 },
      sessions: [sessionSummary()],
      nextCursor: SESSION_ID,
    });
    const secondPage = overview({
      capacity: { accountUsed: 3, accountLimit: 3 },
      counts: { allocated: 9, queued: 4, running: 9, attention: 7 },
      sessions: [
        sessionSummary({
          sessionId: OTHER_SESSION_ID,
          sandboxId: OTHER_SANDBOX_ID,
          kind: "internal",
          lifecycle: "preparing",
          runnerConnected: false,
          runnerReady: false,
          taskState: "queued",
          canRelease: false,
        }),
      ],
      nextCursor: null,
    });
    const read = vi
      .spyOn(browserApi, "agentCloudOverview")
      .mockImplementation((_agentId: string, options?: { cursor?: string }) =>
        Promise.resolve(options?.cursor ? secondPage : firstPage),
      );

    await renderInRouter(<AgentCloudOverviewPanel agentId={AGENT_ID} />);

    expect(await screen.findByText("Environment ready")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));

    // The internal Session arrives with its own kind and its generic preparation state.
    expect(await screen.findByText("Internal Session")).toBeTruthy();
    expect(screen.getByText("Preparing the environment")).toBeTruthy();
    expect(screen.getByText("Task queued")).toBeTruthy();
    // The first page's Agent-wide counts stand; the appended page only contributed rows.
    const counts = document.querySelector('[data-ui="cloud-overview-counts"]') as HTMLElement;
    expect(within(counts).getByText("Processing").parentElement?.textContent).toContain("2");
    expect(within(counts).getByText("Agent environments").parentElement?.textContent).toContain("2");
    expect(within(counts).queryByText("9")).toBeNull();
    expect(within(counts).getByText("1 of 3")).toBeTruthy();
    // The second read paged by cursor; an internal Session has no Task link.
    expect(read).toHaveBeenLastCalledWith(AGENT_ID, { cursor: SESSION_ID, limit: 20 });
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });
});

describe("Cloud Session release actions", () => {
  it("saves and releases once for a double click, and keeps the result through a failed refresh", async () => {
    // Same-millisecond reads and writes cannot suppress the authoritative result.
    vi.spyOn(Date, "now").mockReturnValue(42);
    vi.spyOn(browserApi, "agentCloudOverview").mockImplementation(() =>
      Promise.resolve(overview({ sessions: [sessionSummary()] })),
    );
    let releaseStop!: (value: AccountSandboxRunnerStatusResponse) => void;
    const stop = vi
      .spyOn(browserApi, "stopCloudSandbox")
      .mockImplementation(() => new Promise((resolve) => (releaseStop = resolve)));

    const { rerender } = await renderInRouter(<AgentCloudOverviewPanel agentId={AGENT_ID} />);
    const button = await screen.findByRole("button", { name: "Save and release" });
    act(() => {
      fireEvent.click(button);
      fireEvent.click(button);
    });
    await waitFor(() => expect(stop).toHaveBeenCalledTimes(1));
    // Save and discard alike are fenced to the environment generation the reader was looking at.
    expect(stop).toHaveBeenCalledWith(SANDBOX_ID, { environmentGeneration: 3 });

    // The Server answered the release; the re-read it triggered fails and stays failed.
    vi.spyOn(browserApi, "agentCloudOverview").mockRejectedValue(new Error("network down"));
    releaseStop(stopStatus());

    // The authoritative answer survives the failed re-read, and the stale remainder says so.
    expect(await screen.findByText(/Environment released\. The saved workspace is restored/)).toBeTruthy();
    expect(await screen.findByText(/Update failed\. Showing last available data/)).toBeTruthy();
    expect(screen.getByText("No environment allocated")).toBeTruthy();
    expect(screen.queryByText("Environment ready")).toBeNull();
    expect(screen.queryByRole("button", { name: "Save and release" })).toBeNull();
    rerender(<AgentCloudOverviewPanel agentId={AGENT_ID} />);
    expect(screen.getByText(/Environment released\. The saved workspace is restored/)).toBeTruthy();
  });

  it("rejects a stale read that finishes after the release response", async () => {
    let finishOldRead!: (data: AgentCloudOverview) => void;
    let finishStop!: (data: AccountSandboxRunnerStatusResponse) => void;
    const read = vi
      .spyOn(browserApi, "agentCloudOverview")
      .mockResolvedValueOnce(overview({ sessions: [sessionSummary()] }))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishOldRead = resolve;
          }),
      )
      .mockRejectedValue(new Error("refresh unavailable"));
    const stop = vi.spyOn(browserApi, "stopCloudSandbox").mockImplementation(
      () =>
        new Promise((resolve) => {
          finishStop = resolve;
        }),
    );
    function RefreshControl() {
      const cache = useQueryClient();
      return (
        <button
          type="button"
          onClick={() => void cache.invalidateQueries({ queryKey: queryKeys.agents.cloudOverview(AGENT_ID) })}
        >
          External refresh
        </button>
      );
    }
    await renderInRouter(
      <>
        <RefreshControl />
        <AgentCloudOverviewPanel agentId={AGENT_ID} />
      </>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Save and release" }));
    await waitFor(() => expect(stop).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "External refresh" }));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    await act(async () => {
      finishStop(stopStatus());
    });
    expect(await screen.findByText(/Update failed/)).toBeTruthy();
    await act(async () => {
      finishOldRead(overview({ sessions: [sessionSummary()] }));
    });
    expect(screen.getByText("No environment allocated")).toBeTruthy();
    expect(screen.queryByText("Environment ready")).toBeNull();
    expect(screen.queryByRole("button", { name: "Save and release" })).toBeNull();
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("treats a server error as uncertain and blocks actions after a failed state read", async () => {
    const read = vi
      .spyOn(browserApi, "agentCloudOverview")
      .mockResolvedValueOnce(overview({ sessions: [sessionSummary()] }))
      .mockRejectedValue(new Error("refresh unavailable"));
    const stop = vi
      .spyOn(browserApi, "stopCloudSandbox")
      .mockRejectedValue(new ApiError(503, "Release may have applied", "SERVICE_UNAVAILABLE"));
    await renderInRouter(<AgentCloudOverviewPanel agentId={AGENT_ID} />);
    fireEvent.click(await screen.findByRole("button", { name: "Save and release" }));
    expect(await screen.findByText(/release result could not be confirmed/)).toBeTruthy();
    expect(await screen.findByText(/Update failed/)).toBeTruthy();
    // The control stays put but disabled while the authoritative read is failed: it never acts on
    // an unconfirmed state, and it never vanishes from under the cursor either.
    const retry = screen.getByRole("button", { name: "Save and release" });
    expect(retry.hasAttribute("disabled")).toBe(true);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("labels the repeated stop as a retry of the save and release after a failed save", async () => {
    vi.spyOn(browserApi, "agentCloudOverview").mockResolvedValue(
      overview({
        sessions: [
          sessionSummary({
            lifecycle: "releasing",
            runnerConnected: false,
            runnerReady: false,
            lastErrorCode: "workspace_save_failed",
            lastErrorAt: "2026-09-20T00:05:00.000Z",
            canDiscard: true,
          }),
        ],
      }),
    );
    const stop = vi.spyOn(browserApi, "stopCloudSandbox").mockResolvedValue(stopStatus());

    await renderInRouter(<AgentCloudOverviewPanel agentId={AGENT_ID} />);

    // Task state and environment state stay two facts; the failed save is the environment's.
    expect(await screen.findByText("The workspace could not be saved")).toBeTruthy();
    expect(screen.getByText("No active Task")).toBeTruthy();
    // The retry releases — it is not advertised as "save and keep running" — and discard is the
    // explicit escape beside it, not a silent part of it.
    expect(screen.getByRole("button", { name: "Discard and release…" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry save and release" }));
    await waitFor(() => expect(stop).toHaveBeenCalledWith(SANDBOX_ID, { environmentGeneration: 3 }));
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("sends the captured environment generation for a discard, and refuses a stale one", async () => {
    vi.spyOn(browserApi, "agentCloudOverview").mockResolvedValue(overview({ sessions: [] }));
    const stop = vi.spyOn(browserApi, "stopCloudSandbox").mockResolvedValue(stopStatus());
    const saveFailed = sessionSummary({
      lifecycle: "releasing",
      lastErrorCode: "workspace_save_failed",
      canDiscard: true,
    });

    const { rerender } = await renderInRouter(<CloudSessionEnvironmentCard agentId={AGENT_ID} session={saveFailed} />);
    fireEvent.click(await screen.findByRole("button", { name: "Discard and release…" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Discard unsaved changes and release?" });
    expect(within(dialog).getByText(/Changes made since the last successful save are lost/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Discard changes and release" }));
    await waitFor(() =>
      expect(stop).toHaveBeenCalledWith(SANDBOX_ID, { discardUnsavedChanges: true, environmentGeneration: 3 }),
    );
    expect(await screen.findByText(/Environment released\. Unsaved changes were discarded/)).toBeTruthy();

    // A dialog opened against one generation cannot send it once the environment has moved on.
    stop.mockClear();
    rerender(<CloudSessionEnvironmentCard key="new-action" agentId={AGENT_ID} session={saveFailed} />);
    fireEvent.click(await screen.findByRole("button", { name: "Discard and release…" }));
    rerender(
      <CloudSessionEnvironmentCard
        agentId={AGENT_ID}
        key="new-action"
        session={sessionSummary({ ...saveFailed, environmentGeneration: 4, canDiscard: false })}
      />,
    );
    const staleDialog = await screen.findByRole("alertdialog");
    expect(within(staleDialog).getByText(/changed while this dialog was open/)).toBeTruthy();
    expect(within(staleDialog).queryByRole("button", { name: "Discard changes and release" })).toBeNull();
    fireEvent.click(within(staleDialog).getByRole("button", { name: "Keep the environment" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(stop).not.toHaveBeenCalled();

    // A different Session with a coincidentally matching generation is still a different
    // environment: the open dialog refuses to aim at it.
    rerender(<CloudSessionEnvironmentCard agentId={AGENT_ID} session={saveFailed} />);
    fireEvent.click(await screen.findByRole("button", { name: "Discard and release…" }));
    rerender(
      <CloudSessionEnvironmentCard
        agentId={AGENT_ID}
        session={sessionSummary({
          ...saveFailed,
          sessionId: OTHER_SESSION_ID,
          sandboxId: OTHER_SANDBOX_ID,
        })}
      />,
    );
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(stop).not.toHaveBeenCalled();
  });

  it("answers a stale-generation refusal by re-reading instead of reporting a release", async () => {
    vi.spyOn(browserApi, "agentCloudOverview").mockResolvedValue(overview({ sessions: [] }));
    const stop = vi
      .spyOn(browserApi, "stopCloudSandbox")
      .mockRejectedValue(
        new ApiError(
          409,
          "The discard request refers to a different environment generation",
          "SANDBOX_RUNNER_CONFLICT",
        ),
      );

    await renderInRouter(
      <CloudSessionEnvironmentCard
        agentId={AGENT_ID}
        session={sessionSummary({ lifecycle: "releasing", lastErrorCode: "workspace_save_failed", canDiscard: true })}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Discard and release…" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard changes and release" }));

    expect(await screen.findByText(/changed before the request completed/)).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(screen.queryByText(/Environment released/)).toBeNull();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("re-reads the state after a request timeout rather than resubmitting the release", async () => {
    const read = vi
      .spyOn(browserApi, "agentCloudOverview")
      .mockResolvedValueOnce(overview({ sessions: [sessionSummary()] }))
      .mockResolvedValue(
        overview({
          sessions: [
            sessionSummary({ lifecycle: "unallocated", runnerConnected: false, runnerReady: false, canRelease: false }),
          ],
        }),
      );
    const stop = vi
      .spyOn(browserApi, "stopCloudSandbox")
      .mockRejectedValue(new CancelledRequestError(new Error("The operation timed out.")));

    await renderInRouter(<AgentCloudOverviewPanel agentId={AGENT_ID} />);
    fireEvent.click(await screen.findByRole("button", { name: "Save and release" }));

    expect(await screen.findByText(/release result could not be confirmed/)).toBeTruthy();
    // One request, then a status re-read — never a blind second release.
    expect(stop).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    // The re-read's truth renders beside the notice, which stays until the reader acts on it.
    expect(await screen.findByText("No environment allocated")).toBeTruthy();
    expect(screen.getByText(/release result could not be confirmed/)).toBeTruthy();
  });

  it("keeps a deterministic failure in the dialog and lets the reader close it", async () => {
    vi.spyOn(browserApi, "agentCloudOverview").mockResolvedValue(overview({ sessions: [] }));
    const stop = vi
      .spyOn(browserApi, "stopCloudSandbox")
      .mockRejectedValue(new ApiError(400, "The discard request is invalid", "VALIDATION_ERROR"));

    await renderInRouter(
      <CloudSessionEnvironmentCard
        agentId={AGENT_ID}
        session={sessionSummary({ lifecycle: "releasing", lastErrorCode: "workspace_save_failed", canDiscard: true })}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Discard and release…" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Discard changes and release" }));

    expect((await within(dialog).findByRole("alert")).textContent).toContain("The discard request is invalid");
    expect(stop).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/Environment released/)).toBeNull();
  });

  it("keeps the discard dialog steady while a background re-read is in flight and changes nothing", async () => {
    const saveFailed = sessionSummary({
      lifecycle: "releasing",
      lastErrorCode: "workspace_save_failed",
      canDiscard: true,
    });
    let finishRefresh!: (value: AgentCloudOverview) => void;
    const read = vi
      .spyOn(browserApi, "agentCloudOverview")
      .mockResolvedValueOnce(overview({ sessions: [saveFailed] }))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishRefresh = resolve;
          }),
      )
      .mockResolvedValue(
        overview({
          sessions: [
            sessionSummary({ lifecycle: "unallocated", runnerConnected: false, runnerReady: false, canRelease: false }),
          ],
        }),
      );
    const stop = vi.spyOn(browserApi, "stopCloudSandbox").mockResolvedValue(stopStatus());
    let cache!: QueryClient;
    function CaptureCache() {
      cache = useQueryClient();
      return null;
    }
    await renderInRouter(
      <>
        <CaptureCache />
        <AgentCloudOverviewPanel agentId={AGENT_ID} />
      </>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Discard and release…" }));
    const dialog = await screen.findByRole("alertdialog");
    const confirm = () => within(dialog).getByRole("button", { name: "Discard changes and release" });

    // A routine re-read starts while the dialog is open. Nothing about the environment changed,
    // so the dialog does not accuse itself of staleness: the confirm is only held, never removed.
    await act(async () => {
      void cache.invalidateQueries({ queryKey: queryKeys.agents.cloudOverview(AGENT_ID) });
    });
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(confirm().hasAttribute("disabled")).toBe(true));
    expect(within(dialog).queryByText(/changed while this dialog was open/)).toBeNull();

    // The re-read settles with the same environment, and the dialog is exactly as usable as before.
    await act(async () => {
      finishRefresh(overview({ sessions: [saveFailed] }));
    });
    await waitFor(() => expect(confirm().hasAttribute("disabled")).toBe(false));
    expect(within(dialog).queryByText(/changed while this dialog was open/)).toBeNull();
    fireEvent.click(confirm());
    await waitFor(() =>
      expect(stop).toHaveBeenCalledWith(SANDBOX_ID, { discardUnsavedChanges: true, environmentGeneration: 3 }),
    );
    expect(await screen.findByText(/Environment released\. Unsaved changes were discarded/)).toBeTruthy();
  });

  it("keeps the failed save and its retry controls from the authoritative answer when the re-read fails", async () => {
    const saveFailed = sessionSummary({
      lifecycle: "releasing",
      runnerConnected: false,
      runnerReady: false,
      lastErrorCode: "workspace_save_failed",
      lastErrorAt: "2026-09-20T00:05:00.000Z",
      canDiscard: true,
    });
    vi.spyOn(browserApi, "agentCloudOverview").mockResolvedValue(overview({ sessions: [saveFailed] }));
    let finishStop!: (value: AccountSandboxRunnerStatusResponse) => void;
    const stop = vi
      .spyOn(browserApi, "stopCloudSandbox")
      .mockImplementation(() => new Promise((resolve) => (finishStop = resolve)));

    await renderInRouter(<AgentCloudOverviewPanel agentId={AGENT_ID} />);
    fireEvent.click(await screen.findByRole("button", { name: "Retry save and release" }));
    await waitFor(() => expect(stop).toHaveBeenCalledWith(SANDBOX_ID, { environmentGeneration: 3 }));

    // The Server's answer: the save failed again and the resource is still bound. The re-read the
    // release triggered then fails, so this answer is all the row has.
    vi.mocked(browserApi.agentCloudOverview).mockRejectedValue(new Error("network down"));
    await act(async () => {
      finishStop(
        stopStatus({
          lifecycle: "releasing",
          currentResourceName: "projects/p/locations/l/instances/i-3",
          currentResourceUid: "uid-3",
          lastErrorCode: "workspace_save_failed",
          lastErrorAt: "2026-09-20T00:06:00.000Z",
        }),
      );
    });

    // The exact failure survives — it is not watered down to a generic "needs attention" — and no
    // successful-release banner is claimed for a save that failed.
    expect(await screen.findByText("The workspace could not be saved")).toBeTruthy();
    expect(screen.queryByText("The environment needs attention")).toBeNull();
    expect(screen.queryByText(/Environment released\./)).toBeNull();
    expect(screen.getByText("The request returned. Check the current environment state.")).toBeTruthy();
    expect(await screen.findByText(/Update failed/)).toBeTruthy();
    // The retry and the explicit discard the Server's predicates allow stay mounted — disabled
    // only while the authoritative read is failed.
    expect(screen.getByRole("button", { name: "Retry save and release" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Discard and release…" }).hasAttribute("disabled")).toBe(true);
  });

  it("retires a release notice once the environment generation it answered for is gone", async () => {
    const read = vi
      .spyOn(browserApi, "agentCloudOverview")
      .mockResolvedValueOnce(overview({ sessions: [sessionSummary()] }))
      .mockResolvedValue(overview({ sessions: [sessionSummary({ environmentGeneration: 4 })] }));
    const stop = vi
      .spyOn(browserApi, "stopCloudSandbox")
      .mockRejectedValue(
        new ApiError(
          409,
          "The release request refers to a different environment generation",
          "SANDBOX_RUNNER_CONFLICT",
        ),
      );

    await renderInRouter(<AgentCloudOverviewPanel agentId={AGENT_ID} />);
    fireEvent.click(await screen.findByRole("button", { name: "Save and release" }));

    // The refusal belongs to generation 3; the re-read it triggered shows the environment moved
    // to generation 4, and the refusal goes with the generation it described.
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText(/changed before the request completed/)).toBeNull());
    expect(screen.getByText("Environment ready")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save and release" }).hasAttribute("disabled")).toBe(false);
    expect(stop).toHaveBeenCalledWith(SANDBOX_ID, { environmentGeneration: 3 });
  });

  it("re-reads every Agent's Cloud overview after a release, because capacity is Account-wide", async () => {
    const stop = vi.spyOn(browserApi, "stopCloudSandbox").mockResolvedValue(stopStatus());
    const read = vi
      .spyOn(browserApi, "agentCloudOverview")
      .mockImplementation((agentId: string) =>
        Promise.resolve(
          agentId === AGENT_ID
            ? overview({ sessions: [sessionSummary()] })
            : overview({ agentId: OTHER_AGENT_ID, capacity: { accountUsed: 1, accountLimit: 3 } }),
        ),
      );

    await renderInRouter(
      <>
        <AgentCloudOverviewPanel agentId={AGENT_ID} />
        <AgentCloudOverviewPanel agentId={OTHER_AGENT_ID} />
      </>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Save and release" }));
    await waitFor(() => expect(stop).toHaveBeenCalledTimes(1));

    // The sibling board is not left showing capacity this release freed until its own poll comes.
    const readsFor = (agentId: string) => read.mock.calls.filter(([id]) => id === agentId).length;
    await waitFor(() => expect(readsFor(OTHER_AGENT_ID)).toBe(2));
    expect(readsFor(AGENT_ID)).toBe(2);
  });
});

describe("Agent identity switches", () => {
  it("never shows one Agent's environments, results, or actions under another", async () => {
    let releaseStop!: (value: AccountSandboxRunnerStatusResponse) => void;
    const stop = vi
      .spyOn(browserApi, "stopCloudSandbox")
      .mockImplementation(() => new Promise((resolve) => (releaseStop = resolve)));
    const read = vi.spyOn(browserApi, "agentCloudOverview").mockImplementation((agentId: string) =>
      Promise.resolve(
        agentId === AGENT_ID
          ? overview({ sessions: [sessionSummary()] })
          : overview({
              agentId: OTHER_AGENT_ID,
              capacity: { accountUsed: 0, accountLimit: 3 },
              counts: { allocated: 0, queued: 0, running: 0, attention: 0 },
            }),
      ),
    );

    const { rerender } = await renderInRouter(<AgentCloudOverviewPanel agentId={AGENT_ID} />);
    fireEvent.click(await screen.findByRole("button", { name: "Save and release" }));
    await waitFor(() => expect(stop).toHaveBeenCalledTimes(1));

    // The Agent changes while the first Agent's release is still in flight.
    rerender(<AgentCloudOverviewPanel agentId={OTHER_AGENT_ID} />);
    expect(await screen.findByText(/No Session has a Cloud environment yet/)).toBeTruthy();
    expect(screen.queryByText("Environment ready")).toBeNull();
    expect(screen.queryByRole("button", { name: "Save and release" })).toBeNull();
    expect(read).toHaveBeenLastCalledWith(OTHER_AGENT_ID, { limit: 20 });

    // The late answer belongs to the first Agent's row, which is gone: nothing is applied here.
    releaseStop(stopStatus());
    await waitFor(() => expect(read).toHaveBeenCalledWith(AGENT_ID, { limit: 20 }));
    expect(screen.queryByText(/Environment released/)).toBeNull();
    expect(screen.getByText(/No Session has a Cloud environment yet/)).toBeTruthy();
  });
});

describe("AgentComputerSettings Cloud and Local compatibility", () => {
  it("shows the always-online Cloud identity and overview, with no bind or repair flow", async () => {
    const read = vi
      .spyOn(browserApi, "agentCloudOverview")
      .mockResolvedValue(overview({ sessions: [sessionSummary()] }));

    await renderInRouter(<AgentComputerSettings agent={agentView("cloud", "unconfirmed")} onAgentChanged={vi.fn()} />);

    // The Cloud Computer is logically online even while evidence is unconfirmed; readiness of the
    // execution layer is the environments' story below, not the identity's.
    expect(await screen.findByText("OpenTag Cloud")).toBeTruthy();
    expect(screen.getByText("Online")).toBeTruthy();
    expect(screen.getByText("Hosted by OpenTag")).toBeTruthy();
    expect(await screen.findByRole("region", { name: "Cloud environments" })).toBeTruthy();
    expect(await screen.findByText("Environment ready")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /install command/ })).toBeNull();
    expect(screen.queryByText("No Computer connected")).toBeNull();
    expect(read).toHaveBeenCalledWith(AGENT_ID, { limit: 20 });
  });

  it("does not offer Local repair while the bound Computer kind is unknown", async () => {
    const agent = agentView("cloud", "unconfirmed");
    delete agent.computerKind;
    const retry = vi.fn();
    const connect = vi.spyOn(browserApi, "issueComputerConnectCode");
    // An active Computers reader, so the retry's re-read of the failed inventory is observable.
    function ComputersObserver() {
      useComputersQuery();
      return null;
    }
    const computers = vi.spyOn(browserApi, "computers").mockResolvedValue({ computers: [] });
    await renderInRouter(
      <>
        <ComputersObserver />
        <AgentComputerSettings agent={agent} onAgentChanged={retry} />
      </>,
    );
    expect(screen.queryByRole("button", { name: /install command/ })).toBeNull();
    await waitFor(() => expect(computers).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    // "Unconfirmed" is the Computers read having failed, so retrying re-reads it — not only the Agent.
    await waitFor(() => expect(computers).toHaveBeenCalledTimes(2));
    expect(retry).toHaveBeenCalledTimes(1);
    expect(connect).not.toHaveBeenCalled();
  });

  it("keeps the Local repair flow exactly as it was, with no Cloud reads", async () => {
    const read = vi.spyOn(browserApi, "agentCloudOverview").mockResolvedValue(overview());
    vi.spyOn(browserApi, "issueComputerConnectCode").mockResolvedValue({
      bootstrapCommand: "opentag computer connect -- code",
      connectCodeId: "connect-code",
      expiresIn: 900,
      issuedAt: "2026-08-20T00:00:00.000Z",
    });
    vi.spyOn(browserApi, "computerConnectCodeStatus").mockResolvedValue({
      computerId: null,
      connectCodeId: "connect-code",
      redeemedAt: null,
      state: "pending",
    });

    await renderInRouter(
      <AgentComputerSettings agent={agentView("local", "action_required")} onAgentChanged={vi.fn()} />,
    );

    expect(await screen.findByRole("button", { name: "Generate an install command" })).toBeTruthy();
    expect(screen.getByText("Offline")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Cloud environments" })).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });
});

describe("Task page Cloud environment", () => {
  const task: TaskSummary = {
    id: SESSION_ID,
    agent: { id: AGENT_ID, name: "reviewer", displayName: "Reviewer", runtimeProvider: "pi" },
    source: { provider: "slack", conversationKind: "channel", channelId: "C123", threadKey: null },
    sessionKind: "channel",
    title: "Summarize the incident channel",
    status: "completed",
    createdAt: "2026-09-20T00:00:00.000Z",
    endedAt: "2026-09-20T00:30:00.000Z",
    lastActivityAt: "2026-09-20T00:30:00.000Z",
  };

  function taskDetail(): TaskDetail {
    return { task, turns: [], internalSessions: [], collaborationMessages: [], nextCursor: null };
  }

  function agentDetail(): AgentDetail {
    return {
      id: AGENT_ID,
      name: "reviewer",
      displayName: "Reviewer",
      runtimeProvider: "pi",
      receiveMode: "mention_only",
      status: "active",
      createdBy: { userId: "9a8b7c6d-5e4f-4a3b-8c1d-0e9f8a7b6c5d", displayName: "Ada" },
      computer: { computerId: COMPUTER_ID, displayName: "OpenTag Cloud", platform: "linux" },
      createdAt: "2026-08-20T00:00:00.000Z",
      updatedAt: "2026-08-20T00:00:00.000Z",
      activity: { state: "idle" },
    };
  }

  function computerSummary(kind: "cloud" | "local"): AccountComputerSummary {
    return {
      computerId: COMPUTER_ID,
      kind,
      displayName: kind === "cloud" ? "OpenTag Cloud" : "Ada's Mac",
      platform: kind === "cloud" ? "linux" : "darwin",
      connectionStatus: "online",
      providerReadiness: [{ provider: "pi", status: "ready", observedAt: "2026-09-20T00:00:00.000Z" }],
      connectedAt: "2026-08-20T00:00:00.000Z",
      lastSeenAt: "2026-09-20T00:00:00.000Z",
      observedAt: "2026-09-20T00:00:00.000Z",
      createdAt: "2026-08-19T00:00:00.000Z",
      agentIds: [AGENT_ID],
    };
  }

  it("shows the Session's environment beside the Task's own state, without merging them", async () => {
    vi.spyOn(browserApi, "task").mockResolvedValue(taskDetail());
    vi.spyOn(browserApi, "agent").mockResolvedValue(agentDetail());
    vi.spyOn(browserApi, "computers").mockResolvedValue({ computers: [computerSummary("cloud")] });
    const read = vi.spyOn(browserApi, "agentCloudOverview").mockResolvedValue(
      overview({
        sessions: [
          sessionSummary({
            lifecycle: "releasing",
            runnerConnected: false,
            runnerReady: false,
            lastErrorCode: "workspace_save_failed",
            lastErrorAt: "2026-09-20T00:31:00.000Z",
            canDiscard: true,
          }),
        ],
      }),
    );

    await renderInRouter(<TaskDetailPage agentId={AGENT_ID} taskId={SESSION_ID} />, {
      path: `/agents/${AGENT_ID}/tasks/${SESSION_ID}`,
    });

    // The Task is finished; the environment's save still failed. Both are shown, as two facts.
    const environment = await screen.findByRole("region", { name: "Cloud environment" });
    expect(await within(environment).findByText("The workspace could not be saved")).toBeTruthy();
    expect(within(environment).getByText("No active Task")).toBeTruthy();
    expect(within(screen.getByLabelText("Task details")).getByText("Completed")).toBeTruthy();
    expect(read).toHaveBeenCalledWith(AGENT_ID, { sessionId: SESSION_ID, limit: 20 });
    expect(within(environment).getByRole("button", { name: "Retry save and release" })).toBeTruthy();
  });

  it("renders no Cloud section for a Local Agent's Task and asks for none", async () => {
    vi.spyOn(browserApi, "task").mockResolvedValue(taskDetail());
    vi.spyOn(browserApi, "agent").mockResolvedValue(agentDetail());
    vi.spyOn(browserApi, "computers").mockResolvedValue({ computers: [computerSummary("local")] });
    const read = vi.spyOn(browserApi, "agentCloudOverview").mockResolvedValue(overview());

    await renderInRouter(<TaskDetailPage agentId={AGENT_ID} taskId={SESSION_ID} />, {
      path: `/agents/${AGENT_ID}/tasks/${SESSION_ID}`,
    });

    expect(await screen.findByLabelText("Task details")).toBeTruthy();
    await waitFor(() => expect(browserApi.computers).toHaveBeenCalled());
    expect(screen.queryByRole("region", { name: "Cloud environment" })).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });
});
