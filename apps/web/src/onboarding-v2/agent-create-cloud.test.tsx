/**
 * The creation surface's Cloud destination: the availability answer gates the choice, Cloud is the
 * default when the platform offers it, and a Cloud submission ensures the Account's logical Cloud
 * Computer before the existing createAgent call carries the binding. Local is never chosen for the
 * reader, and a failed availability read fails closed rather than inventing an answer.
 */

import type { CloudAvailability } from "@opentag/shared/browser";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { browserApi } from "../api.js";
import { deferred } from "./agent-setup-test-fixtures.js";
import { AgentSetupSurface } from "./page.js";

const CLOUD_COMPUTER_ID = "8c2b1d4e-5a6f-4b7c-8d9e-0f1a2b3c4d5e";
const CREATED_AGENT_ID = "3f1d3a2c-1f2e-4a1b-9c3d-5e6f70819a2b";

function availability(overrides: Partial<CloudAvailability> = {}): CloudAvailability {
  return {
    enabled: true,
    available: true,
    reason: null,
    observedAt: "2026-09-01T10:00:00.000Z",
    ...overrides,
  };
}

function renderCreation(onAgentAvailable?: (agentId: string) => void) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <AgentSetupSurface onAgentAvailable={onAgentAvailable} />
    </QueryClientProvider>,
  );
}

function cloudCard(): HTMLElement {
  return screen.getByRole("button", { name: /Cloud computer/ });
}

describe("Agent creation with a Cloud destination", () => {
  beforeEach(() => {
    vi.spyOn(browserApi, "ensureCloudComputer").mockResolvedValue({
      computerId: CLOUD_COMPUTER_ID,
      kind: "cloud",
      displayName: "Cloud",
      platform: "linux",
      connectionStatus: "online",
      createdAt: "2026-09-01T10:00:00.000Z",
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("pre-selects Cloud once the service answers available, then ensures the Computer at submit", async () => {
    const calls: string[] = [];
    vi.spyOn(browserApi, "cloudAvailability").mockResolvedValue(availability());
    vi.spyOn(browserApi, "ensureCloudComputer").mockImplementation(async () => {
      calls.push("ensure");
      return {
        computerId: CLOUD_COMPUTER_ID,
        kind: "cloud",
        displayName: "Cloud",
        platform: "linux",
        connectionStatus: "online",
        createdAt: "2026-09-01T10:00:00.000Z",
      };
    });
    const createAgent = vi.spyOn(browserApi, "createAgent").mockImplementation(async () => {
      calls.push("create");
      return { id: CREATED_AGENT_ID } as never;
    });
    const onAgentAvailable = vi.fn();
    renderCreation(onAgentAvailable);

    // The default arrives with the answer; nothing is selected before it.
    await waitFor(() => expect(cloudCard().getAttribute("aria-pressed")).toBe("true"));
    expect(screen.getByRole("button", { name: "Continue" }).hasAttribute("disabled")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    // The runtime is fixed: there is no picker to answer for a Cloud Agent.
    expect(screen.queryByRole("button", { name: /Codex/ })).toBeNull();
    expect(screen.getByText("Cloud agents always run Pi.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Create Agent" }));
    await waitFor(() => expect(onAgentAvailable).toHaveBeenCalledWith(CREATED_AGENT_ID));
    expect(calls).toEqual(["ensure", "create"]);
    expect(createAgent).toHaveBeenCalledWith({
      displayName: "opentag",
      name: "opentag",
      runtimeProvider: "pi",
      computerId: CLOUD_COMPUTER_ID,
    });
  });

  it.each([
    { enabled: false, reason: "disabled" as const },
    { enabled: true, reason: "execution_unavailable" as const },
    { enabled: true, reason: "model_unavailable" as const },
  ])("keeps Cloud gray and disabled for $reason without a separate visibility switch", async (state) => {
    vi.spyOn(browserApi, "cloudAvailability").mockResolvedValue(availability({ ...state, available: false }));
    renderCreation();

    await waitFor(() => expect(cloudCard().hasAttribute("disabled")).toBe(true));
    expect(cloudCard().getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByText("Temporarily unavailable")).toBeTruthy();
    expect(
      screen.getByText(
        "Cloud is temporarily unavailable on this deployment. You can still run the agent on your own computer.",
      ),
    ).toBeTruthy();
    fireEvent.click(cloudCard());
    expect(cloudCard().getAttribute("aria-pressed")).toBe("false");
    expect(browserApi.ensureCloudComputer).not.toHaveBeenCalled();
    // Nothing was selected for the reader: Continue stays disabled until they choose Local.
    expect(screen.getByRole("button", { name: "Continue" }).hasAttribute("disabled")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: /Local computer/ }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    // The Local runtime choice is untouched by the Cloud answer.
    expect(screen.getByRole("button", { name: /Codex/ })).toBeTruthy();
  });

  it("fails closed when the availability read fails, reports the failed check, and retries on request", async () => {
    const read = vi.spyOn(browserApi, "cloudAvailability").mockRejectedValue(new Error("network down"));
    renderCreation();

    // The read never answered: Cloud stays disabled and nothing is selected for the reader.
    await waitFor(() => expect(cloudCard().hasAttribute("disabled")).toBe(true));
    expect(cloudCard().getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("button", { name: "Continue" }).hasAttribute("disabled")).toBe(true);
    // The copy reports the check that failed — not a deployment fact the Server never stated.
    expect(screen.getByText("Could not check")).toBeTruthy();
    expect(
      screen.getByText("Cloud availability could not be checked. Try again, or run the agent on your own computer."),
    ).toBeTruthy();
    expect(screen.queryByText("Temporarily unavailable")).toBeNull();
    expect(screen.queryByText(/temporarily unavailable on this deployment/)).toBeNull();
    // Local is untouched by the failed Cloud read.
    expect(screen.getByRole("button", { name: /Local computer/ }).hasAttribute("disabled")).toBe(false);

    // The retry re-reads; an available answer unlocks and pre-selects Cloud exactly as a first
    // successful read would.
    read.mockResolvedValue(availability());
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(cloudCard().hasAttribute("disabled")).toBe(false));
    await waitFor(() => expect(cloudCard().getAttribute("aria-pressed")).toBe("true"));
    expect(screen.queryByText("Could not check")).toBeNull();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("says the availability check is running while it is, without the unavailable verdict", async () => {
    const read = deferred<CloudAvailability>();
    vi.spyOn(browserApi, "cloudAvailability").mockReturnValue(read.promise);
    renderCreation();

    // The unanswered read describes the destination and says it is checking; the unavailable
    // claim belongs to an answered "no", so it never flashes on a normal load.
    expect(await screen.findByText("Checking…")).toBeTruthy();
    expect(screen.getByText("We run the agent for you, with tokens included.")).toBeTruthy();
    expect(screen.queryByText(/temporarily unavailable on this deployment/)).toBeNull();
    expect(screen.queryByText("Temporarily unavailable")).toBeNull();
    expect(cloudCard().hasAttribute("disabled")).toBe(true);

    read.resolve(availability());
    await waitFor(() => expect(cloudCard().hasAttribute("disabled")).toBe(false));
  });

  it("never overrides a destination the reader picked before the availability answer arrived", async () => {
    const read = deferred<CloudAvailability>();
    vi.spyOn(browserApi, "cloudAvailability").mockReturnValue(read.promise);
    renderCreation();

    fireEvent.click(screen.getByRole("button", { name: /Local computer/ }));
    read.resolve(availability());
    await waitFor(() => expect(cloudCard().hasAttribute("disabled")).toBe(false));

    expect(screen.getByRole("button", { name: /Local computer/ }).getAttribute("aria-pressed")).toBe("true");
    expect(cloudCard().getAttribute("aria-pressed")).toBe("false");
  });

  it("reports an ensure failure without creating an Agent", async () => {
    vi.spyOn(browserApi, "cloudAvailability").mockResolvedValue(availability());
    vi.spyOn(browserApi, "ensureCloudComputer").mockRejectedValue(new Error("overloaded"));
    const createAgent = vi.spyOn(browserApi, "createAgent");
    renderCreation(vi.fn());

    await waitFor(() => expect(cloudCard().getAttribute("aria-pressed")).toBe("true"));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(screen.getByRole("button", { name: "Create Agent" }));

    await screen.findByText("Cloud is temporarily unavailable, so the agent was not created. Please try again.");
    expect(createAgent).not.toHaveBeenCalled();
  });

  it("keeps the Local flow intact, including its runtime choice", async () => {
    vi.spyOn(browserApi, "cloudAvailability").mockResolvedValue(availability());
    const ensure = vi.mocked(browserApi.ensureCloudComputer);
    const createAgent = vi.spyOn(browserApi, "createAgent").mockResolvedValue({ id: CREATED_AGENT_ID } as never);
    const onAgentAvailable = vi.fn();
    renderCreation(onAgentAvailable);

    await waitFor(() => expect(cloudCard().hasAttribute("disabled")).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: /Local computer/ }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(screen.getByRole("button", { name: /Claude Code/ }));
    fireEvent.click(screen.getByRole("button", { name: "Create Agent" }));

    await waitFor(() => expect(onAgentAvailable).toHaveBeenCalledWith(CREATED_AGENT_ID));
    // No Cloud ensure runs for a Local creation, and no Computer is bound by the page.
    expect(ensure).not.toHaveBeenCalled();
    expect(createAgent).toHaveBeenCalledWith({
      displayName: "opentag",
      name: "opentag",
      runtimeProvider: "claude-code",
    });
  });
});
