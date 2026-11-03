import type { ImFeedbackList as FeedbackList } from "@opentag/shared/browser";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderInRouter } from "../__tests__/support/router.js";
import { browserApi } from "../api.js";
import { ImFeedbackList } from "./im-feedback-list.js";

afterEach(() => vi.restoreAllMocks());
describe("Agent recovery notices", () => {
  it("reads only on expansion, shows unknown delivery, and paginates through the owner API", async () => {
    const id = "11111111-1111-4111-8111-111111111111",
      agentId = "22222222-2222-4222-8222-222222222222";
    const list = vi
      .spyOn(browserApi, "imFeedbackList")
      .mockResolvedValueOnce({
        items: [
          {
            id,
            agentId,
            sessionId: "33333333-3333-4333-8333-333333333333",
            state: "failed",
            errorCode: "provider_failed",
            deliveryState: "send_unknown",
            createdAt: "2026-11-03T00:00:00Z",
          },
        ],
        nextCursor: id,
      } satisfies FeedbackList)
      .mockResolvedValue({ items: [], nextCursor: null });
    await renderInRouter(<ImFeedbackList agentId={agentId} />);
    expect(list).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Recovery and error notices" }));
    const link = await screen.findByRole("link", { name: "Error code: provider_failed" });
    expect(link.getAttribute("href")).toContain(`/im-feedback/${id}`);
    expect(screen.getByText(/The error-card delivery result is unknown/)).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() => expect(list).toHaveBeenCalledWith(agentId, id));
    expect(list).toHaveBeenCalledTimes(2);
  });
});
