import type { AccountSandboxRunnerStatusResponse, CloudSessionSummary } from "@opentag/shared/browser";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { renderInRouter } from "../../../__tests__/support/router.js";
import { browserApi } from "../../../api.js";
import { CloudSessionEnvironmentCard } from "./cloud-session-environment.js";

afterEach(() => vi.restoreAllMocks());

it("does not attach an old release outcome to a replacement returned by the final status read", async () => {
  const session: CloudSessionSummary = {
    sessionId: "11111111-1111-4111-8111-111111111111",
    sandboxId: "22222222-2222-4222-8222-222222222222",
    kind: "channel",
    lifecycle: "ready",
    environmentGeneration: 3,
    runnerConnected: true,
    runnerReady: true,
    taskState: "running",
    lastErrorCode: null,
    lastErrorAt: null,
    updatedAt: "2026-09-21T00:00:00Z",
    canRelease: true,
    canDiscard: false,
  };
  // Another task starts after the requested allocation is released but before stop reads status.
  const replacement: AccountSandboxRunnerStatusResponse = {
    sandboxId: session.sandboxId,
    sessionId: session.sessionId,
    lifecycle: "ready",
    environmentGeneration: 4,
    currentResourceName: "projects/fixture/locations/us-west1/instances/replacement",
    currentResourceUid: "replacement-uid",
    currentOperationName: null,
    runnerConnected: true,
    runnerReady: true,
    runnerReadiness: null,
    lastErrorCode: null,
    lastErrorAt: null,
    updatedAt: "2026-09-21T00:01:00Z",
  };
  const stop = vi.spyOn(browserApi, "stopCloudSandbox").mockResolvedValue(replacement);
  const agentId = "33333333-3333-4333-8333-333333333333";
  const { rerender } = await renderInRouter(<CloudSessionEnvironmentCard agentId={agentId} session={session} />);
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Save and release" })));
  await waitFor(() => expect(stop).toHaveBeenCalledWith(session.sandboxId, { environmentGeneration: 3 }));

  rerender(<CloudSessionEnvironmentCard agentId={agentId} session={{ ...session, environmentGeneration: 4 }} />);
  expect(screen.getByText("Environment ready")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Save and release" }).hasAttribute("disabled")).toBe(false);
  expect(screen.queryByText("The request returned. Check the current environment state.")).toBeNull();
  expect(screen.queryByText(/Environment released/)).toBeNull();
  expect(stop).toHaveBeenCalledOnce();
});
