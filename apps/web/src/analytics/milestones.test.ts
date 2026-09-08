import { afterEach, describe, expect, it, vi } from "vitest";
import { reportMilestoneOnce, resetReportedMilestones } from "./milestones.js";

afterEach(() => {
  resetReportedMilestones();
  window.localStorage.clear();
});

describe("milestone reporting", () => {
  it("reports a step once and never again for this reader", () => {
    const emit = vi.fn();

    reportMilestoneOnce("first-conversation:agent-a", emit);
    reportMilestoneOnce("first-conversation:agent-a", emit);

    expect(emit).toHaveBeenCalledTimes(1);
  });

  it("keeps refusing after a reload, because a funnel step is not repeatable", () => {
    const emit = vi.fn();

    reportMilestoneOnce("first-conversation:agent-a", emit);
    // A new document, the same browser: the in-memory floor is gone but the record is not.
    resetReportedMilestones();
    reportMilestoneOnce("first-conversation:agent-a", emit);

    expect(emit).toHaveBeenCalledTimes(1);
  });

  it("tells distinct milestones apart", () => {
    const emit = vi.fn();

    reportMilestoneOnce("first-conversation:agent-a", emit);
    reportMilestoneOnce("first-conversation:agent-b", emit);

    expect(emit).toHaveBeenCalledTimes(2);
  });

  it("still reports once per document when storage is refused", () => {
    const emit = vi.fn();
    const refusing = {
      get localStorage(): Storage {
        throw new Error("storage is disabled");
      },
    } as unknown as Window;

    reportMilestoneOnce("first-conversation:agent-a", emit, refusing);
    reportMilestoneOnce("first-conversation:agent-a", emit, refusing);

    expect(emit).toHaveBeenCalledTimes(1);
  });

  it("survives a stored value that is not a list", () => {
    window.localStorage.setItem("opentag:analytics:reported", "{ not json");
    const emit = vi.fn();

    reportMilestoneOnce("first-conversation:agent-a", emit);

    expect(emit).toHaveBeenCalledTimes(1);
  });
});
