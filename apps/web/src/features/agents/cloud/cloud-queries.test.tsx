import type { AgentCloudOverview } from "@opentag/shared/browser";
import { act, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { renderInRouter } from "../../../__tests__/support/router.js";
import { browserApi } from "../../../api.js";
import { LIVE_REFETCH_INTERVAL_MS } from "../../../query/live.js";
import { useAgentCloudOverview } from "./cloud-queries.js";

const empty: AgentCloudOverview = {
  agentId: "3f1d3a2c-1f2e-4a1b-9c3d-5e6f70819a2b",
  observedAt: "2026-09-20T00:00:00.000Z",
  capacity: { accountUsed: 0, accountLimit: 3 },
  counts: { allocated: 0, queued: 0, running: 0, attention: 0 },
  sessions: [],
  nextCursor: null,
};
function Probe() {
  const query = useAgentCloudOverview(empty.agentId);
  return <output data-testid="queued">{query.data?.pages[0]?.counts.queued}</output>;
}
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
it("discovers externally queued work even after an empty idle overview", async () => {
  const read = vi
    .spyOn(browserApi, "agentCloudOverview")
    .mockResolvedValueOnce(empty)
    .mockResolvedValue({ ...empty, counts: { ...empty.counts, queued: 1 } });
  vi.useFakeTimers();
  await renderInRouter(<Probe />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(100);
  });
  expect(screen.getByTestId("queued").textContent).toBe("0");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(LIVE_REFETCH_INTERVAL_MS);
  });
  expect(screen.getByTestId("queued").textContent).toBe("1");
  expect(read).toHaveBeenCalledTimes(2);
});
