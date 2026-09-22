import type { AgentCloudOverview, CloudSessionSummary } from "@opentag/shared/browser";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { act, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { renderInRouter } from "../../../__tests__/support/router.js";
import { ApiError, browserApi } from "../../../api.js";
import { queryKeys } from "../../../query/keys.js";
import { CloudProgressNotice } from "./cloud-progress-notice.js";

const AGENT = "11111111-1111-4111-8111-111111111111";
const OTHER_AGENT = "22222222-2222-4222-8222-222222222222";
const SESSION = "33333333-3333-4333-8333-333333333333";
const SAVE_FAILURE = "Some execution progress could not be saved. Your latest changes may be unavailable next time.";

function overview(errors: (string | null)[] = [], nextCursor: string | null = null): AgentCloudOverview {
  return {
    agentId: AGENT,
    observedAt: "2026-09-22T00:00:00.000Z",
    capacity: { accountUsed: 1, accountLimit: 3 },
    counts: { allocated: 1, queued: 1, running: 0, attention: errors.filter(Boolean).length },
    sessions: errors.map(
      (lastErrorCode): CloudSessionSummary => ({
        sessionId: SESSION,
        sandboxId: "44444444-4444-4444-8444-444444444444",
        kind: "channel",
        lifecycle: "preparing",
        environmentGeneration: 2,
        runnerConnected: false,
        runnerReady: false,
        taskState: "queued",
        lastErrorCode,
        lastErrorAt: lastErrorCode ? "2026-09-22T00:00:00.000Z" : null,
        updatedAt: "2026-09-22T00:00:00.000Z",
        canRelease: true,
        canDiscard: true,
      }),
    ),
    nextCursor,
  };
}

afterEach(() => vi.restoreAllMocks());

it("shows no resource or preparation UI for healthy or queued work", async () => {
  const read = vi.spyOn(browserApi, "agentCloudOverview").mockResolvedValue(overview([null]));
  const { container } = await renderInRouter(<CloudProgressNotice agentId={AGENT} />);
  await waitFor(() => expect(read).toHaveBeenCalledOnce());
  expect(container.textContent).toBe("");
  expect(screen.queryByRole("button")).toBeNull();
});

it("finds save failures on later pages and gives no resource actions or identifiers", async () => {
  const first = overview([null], SESSION);
  first.counts.attention = 1;
  const read = vi
    .spyOn(browserApi, "agentCloudOverview")
    .mockResolvedValueOnce(first)
    .mockResolvedValue(overview(["workspace_save_failed"]));
  await renderInRouter(<CloudProgressNotice agentId={AGENT} />);
  expect(await screen.findByText(SAVE_FAILURE)).toBeTruthy();
  expect(read).toHaveBeenNthCalledWith(1, AGENT, { limit: 100 });
  expect(read).toHaveBeenNthCalledWith(2, AGENT, { limit: 100, cursor: SESSION });
  expect(screen.queryByRole("button")).toBeNull();
  expect(document.body.textContent).not.toMatch(/workspace_save_failed|Runner|Sandbox|33333333|Save and release/);
});

it("does not invent progress loss from an infrastructure diagnostic", async () => {
  vi.spyOn(browserApi, "agentCloudOverview").mockResolvedValue(overview(["cloud_create_failed"]));
  const { container } = await renderInRouter(<CloudProgressNotice agentId={AGENT} />);
  expect(container.textContent).toBe("");
});

it("does not turn an initial diagnostic read failure into a progress-loss claim or leak its message", async () => {
  const read = vi.spyOn(browserApi, "agentCloudOverview").mockRejectedValue(new Error("private diagnostic detail"));
  const { container } = await renderInRouter(<CloudProgressNotice agentId={AGENT} />);
  await waitFor(() => expect(read).toHaveBeenCalledOnce());
  expect(container.textContent).toBe("");
});

it("keeps a confirmed failure on transient refresh, retires it on success, and respects revoked access", async () => {
  const read = vi.spyOn(browserApi, "agentCloudOverview").mockResolvedValue(overview(["workspace_save_failed"]));
  let client!: QueryClient;
  function Probe() {
    client = useQueryClient();
    return <CloudProgressNotice agentId={AGENT} />;
  }
  await renderInRouter(<Probe />);
  await screen.findByText(SAVE_FAILURE);
  async function refresh() {
    await act(async () => {
      await client.invalidateQueries({ queryKey: queryKeys.agents.progressNotice(AGENT) });
    });
  }
  read.mockRejectedValue(new Error("temporary failure"));
  await refresh();
  expect(screen.getByText(SAVE_FAILURE)).toBeTruthy();
  read.mockResolvedValue(overview());
  await refresh();
  await waitFor(() => expect(screen.queryByText(SAVE_FAILURE)).toBeNull());
  read.mockResolvedValue(overview(["workspace_save_failed"]));
  await refresh();
  await screen.findByText(SAVE_FAILURE);
  read.mockRejectedValue(new ApiError(403, "Forbidden private detail"));
  await refresh();
  await waitFor(() => expect(screen.queryByText(SAVE_FAILURE)).toBeNull());
  read.mockRejectedValue(new Error("temporary failure"));
  await refresh();
  expect(screen.queryByText(SAVE_FAILURE)).toBeNull();
  expect(document.body.textContent).not.toContain("private detail");
});

it("does not carry another Agent's warning across navigation", async () => {
  vi.spyOn(browserApi, "agentCloudOverview").mockImplementation(async (agentId) =>
    agentId === AGENT ? overview(["workspace_save_failed"]) : { ...overview(), agentId },
  );
  const { rerender } = await renderInRouter(<CloudProgressNotice agentId={AGENT} />);
  await screen.findByText(SAVE_FAILURE);
  rerender(<CloudProgressNotice agentId={OTHER_AGENT} />);
  await waitFor(() => expect(screen.queryByText(SAVE_FAILURE)).toBeNull());
});
