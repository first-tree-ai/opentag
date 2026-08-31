import type { AgentAdminConfig } from "@opentag/shared/browser";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { newerConfig, useLatestConfig } from "./config-snapshot.js";

const config: AgentAdminConfig = {
  id: "1a63a21e-f6c7-4474-91ea-4dabf0566a24",
  createdByUserId: "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e",
  computerId: "85fe9af3-d1c6-472b-b78c-8a7ccf512750",
  name: "reviewer",
  displayName: "Reviewer",
  runtimeProvider: "codex",
  receiveMode: "mention_only",
  status: "active",
  revision: 4,
  runtimeConfig: { revision: 7, model: null, reasoningEffort: null, instructions: "", maxDurationMs: null },
  createdAt: "2026-08-20T00:00:00.000Z",
  updatedAt: "2026-08-20T00:00:00.000Z",
};

function Probe({ incoming }: { incoming: AgentAdminConfig }) {
  const latest = useLatestConfig(incoming);
  return <output>{`${latest.revision}:${latest.displayName}`}</output>;
}

describe("newerConfig", () => {
  it("keeps the reading in hand when an older one arrives", () => {
    const held = { ...config, revision: 6 };
    expect(newerConfig(held, { ...config, revision: 5 })).toBe(held);
  });

  it("takes an equal revision, because a re-read of the same revision is the same record", () => {
    const candidate = { ...config, revision: 6 };
    expect(newerConfig({ ...config, revision: 6 }, candidate)).toBe(candidate);
  });

  it("takes a newer revision, and takes anything when there is nothing in hand", () => {
    const candidate = { ...config, revision: 7 };
    expect(newerConfig({ ...config, revision: 6 }, candidate)).toBe(candidate);
    expect(newerConfig(undefined, candidate)).toBe(candidate);
  });

  it("takes a different Agent outright rather than comparing revisions across records", () => {
    // Revisions are only ordered within one Agent, so a lower revision belonging to a different
    // Agent is not an older reading of this one -- it is a different subject.
    const other = { ...config, id: "0f2c0d3a-9e6b-4a3d-9a41-2f0f8b9b4c11", revision: 1 };
    expect(newerConfig({ ...config, revision: 9 }, other)).toBe(other);
  });
});

describe("useLatestConfig", () => {
  it("does not walk back to a refresh that landed behind a save", () => {
    const view = render(<Probe incoming={{ ...config, revision: 4 }} />);
    expect(screen.getByRole("status").textContent).toBe("4:Reviewer");

    view.rerender(<Probe incoming={{ ...config, revision: 5, displayName: "Reviewer Bot" }} />);
    expect(screen.getByRole("status").textContent).toBe("5:Reviewer Bot");

    // The read that was already in flight when the save landed. Answering it late must not hand an
    // editor the revision the Server has left, or the next write is refused for no visible reason.
    view.rerender(<Probe incoming={{ ...config, revision: 4 }} />);
    expect(screen.getByRole("status").textContent).toBe("5:Reviewer Bot");

    view.rerender(<Probe incoming={{ ...config, revision: 6, displayName: "Reviewer Zeta" }} />);
    expect(screen.getByRole("status").textContent).toBe("6:Reviewer Zeta");
  });
});
