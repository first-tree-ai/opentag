/**
 * Probes for the review of `6b6920a` — the head that added resume.
 *
 * Resume is the right shape, and the Slack and refresh cases it was built for now work. These are
 * the cases it does not cover: a Computer that is no longer there, a read that never lands, and a
 * control the resumed flow leaves on screen without a job.
 */

import type { AgentListItem, WorkspaceComputerSummary } from "@opentag/shared/browser";
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { browserApi } from "../api.js";
import { OnboardingV2Page } from "./page.js";

const NOW = "2026-08-29T00:00:00.000Z";
const COMPUTER_ID = "85fe9af3-d1c6-472b-b78c-8a7ccf512750";
const AGENT_ID = "1a63a21e-f6c7-4474-91ea-4dabf0566a24";
const WORKSPACE_ID = "d3fda800-7ce2-4338-aae8-3d2120401ed6";
const USER_ID = "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e";

function existingAgent(): AgentListItem {
  return {
    id: AGENT_ID,
    workspaceId: WORKSPACE_ID,
    name: "opentag",
    displayName: "opentag",
    createdBy: { userId: USER_ID, displayName: "Ada" },
    computer: { computerId: COMPUTER_ID, displayName: "Ada's Mac", platform: "darwin" },
    runtimeProvider: "codex",
    receiveMode: "mention_only",
    status: "active",
    activity: { state: "idle" },
    usage: { windowDays: 30, tasks: 0, failed: 0, tokens: 0 },
    createdAt: NOW,
    updatedAt: NOW,
  };
}

/** The machine the Agent was created on, since gone: closed laptop, stopped daemon, reinstall. */
function departedComputer(): WorkspaceComputerSummary {
  return {
    computerId: COMPUTER_ID,
    displayName: "Ada's Mac",
    platform: "darwin",
    connectionStatus: "offline",
    connectedAt: null,
    lastSeenAt: NOW,
    observedAt: NOW,
    enrolledAt: NOW,
    agentIds: [AGENT_ID],
  };
}

async function settle() {
  await act(async () => {
    for (let index = 0; index < 12; index += 1) await Promise.resolve();
  });
}

async function tick(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** An Account that already has an Agent, whose Computer is no longer reachable. */
function resumeOntoDepartedComputer() {
  vi.spyOn(browserApi, "agents").mockResolvedValue({ agents: [existingAgent()] });
  vi.spyOn(browserApi, "imBinding").mockResolvedValue(undefined);
  vi.spyOn(browserApi, "computers").mockResolvedValue({ computers: [departedComputer()] });
  vi.spyOn(browserApi, "issueComputerConnectCode").mockResolvedValue({
    bootstrapCommand: "sh -c 'curl -fsSL https://example.test/install.sh | sh' -- connect ABC",
    expiresIn: 900,
    issuedAt: NOW,
  });
}

describe("resume at 6b6920a", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(new Date(NOW));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("does not say the Computer is connected when the Server says it is offline", async () => {
    // Resume asserts the connection from the Agent's stored Computer reference, which is a foreign
    // key rather than a fact about the machine. Nothing checks `connectionStatus`.
    resumeOntoDepartedComputer();

    render(<OnboardingV2Page />);
    await settle();
    await tick(5_000);

    expect(screen.queryByText("Your computer is connected.")).toBeNull();
  });

  it("offers a way to reconnect a Computer that is no longer there", async () => {
    // The command block renders only while the connection is not `connected`, and resume sets
    // `connected` unconditionally — so the reader is held on a check that can never settle, with
    // Continue disabled and nothing on the page that could bring the machine back.
    resumeOntoDepartedComputer();

    render(<OnboardingV2Page />);
    await settle();
    await tick(5_000);

    expect(screen.getByRole("button", { name: "Continue" })).toHaveProperty("disabled", true);
    expect(document.querySelector("code")).not.toBeNull();
  });

  it("shows something while it reads what the Account already has", async () => {
    // `resuming` renders nothing at all. A read that is slow flashes an empty page; a read that
    // never lands leaves one, on the only route the setup gate allows.
    vi.spyOn(browserApi, "agents").mockReturnValue(new Promise(() => undefined));
    vi.spyOn(browserApi, "imBinding").mockResolvedValue(undefined);
    vi.spyOn(browserApi, "computers").mockResolvedValue({ computers: [] });

    const { container } = render(<OnboardingV2Page />);
    await settle();
    await tick(30_000);

    expect(container.innerHTML).not.toBe("");
  });

  /*
   * Superseded. This asked "if Go back is still here, does pressing it move?" and returned early
   * when it was not, which made it pass without asserting anything once the control was withheld.
   * Its replacement — `hides Go back on a resumed step rather than showing one that cannot act` —
   * asserts the absence directly, and that the footer keeps its slot.
   */
});
