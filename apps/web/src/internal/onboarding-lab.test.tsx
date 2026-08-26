import type { UserProfile } from "@opentag/shared/browser";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { browserApi } from "../api.js";
import { App } from "../app.js";
import { OnboardingLabPage } from "./onboarding-lab-page.js";
import { ONBOARDING_SCENARIOS } from "./onboarding-lab-scenarios.js";

const workspaceId = "d3fda800-7ce2-4338-aae8-3d2120401ed6";
const userId = "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e";
const user: UserProfile = { id: userId, email: "onboarding-test@company.example", displayName: "Onboarding Test" };

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function renderLab(overrides: Partial<Parameters<typeof OnboardingLabPage>[0]> = {}): {
  onResetSucceeded: ReturnType<typeof vi.fn>;
  onScenarioChange: ReturnType<typeof vi.fn>;
} {
  const onResetSucceeded = vi.fn();
  const onScenarioChange = vi.fn();
  render(
    <OnboardingLabPage
      scenarioId={null}
      user={user}
      onResetSucceeded={onResetSucceeded}
      onScenarioChange={onScenarioChange}
      {...overrides}
    />,
  );
  return { onResetSucceeded, onScenarioChange };
}

async function confirmReset() {
  fireEvent.click(screen.getByRole("button", { name: "Reset shared account and start onboarding" }));
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "Reset and start onboarding" }));
}

describe("Onboarding Lab page", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("warns that the staging Account is shared before any reset", () => {
    renderLab();

    expect(screen.getByText(/Shared staging test account/)).toBeTruthy();
    expect(screen.getByText(/can interrupt another tester/)).toBeTruthy();
  });

  it("renders every fixed scenario through the production onboarding presentation", () => {
    for (const scenario of ONBOARDING_SCENARIOS) {
      const view = render(
        <OnboardingLabPage
          scenarioId={scenario.id}
          user={user}
          onResetSucceeded={vi.fn()}
          onScenarioChange={vi.fn()}
        />,
      );
      expect(screen.getByLabelText(`Onboarding preview: ${scenario.title}`)).toBeTruthy();
      expect(screen.getByRole("heading", { level: 1, name: "Set up OpenTag" })).toBeTruthy();
      view.unmount();
    }
  });

  it("communicates each state without contacting the Server", () => {
    const requests = vi.mocked(fetch);

    render(
      <OnboardingLabPage
        scenarioId="computer-offline"
        user={user}
        onResetSucceeded={vi.fn()}
        onScenarioChange={vi.fn()}
      />,
    ).unmount();
    render(
      <OnboardingLabPage
        scenarioId="setup-complete"
        user={user}
        onResetSucceeded={vi.fn()}
        onScenarioChange={vi.fn()}
      />,
    ).unmount();
    render(
      <OnboardingLabPage
        scenarioId="loading-failure"
        user={user}
        onResetSucceeded={vi.fn()}
        onScenarioChange={vi.fn()}
      />,
    );

    expect(screen.getByText("We couldn’t load setup")).toBeTruthy();
    expect(requests).not.toHaveBeenCalled();
  });

  it("keeps only the selected fixture in the URL", () => {
    const { onScenarioChange } = renderLab();

    fireEvent.click(screen.getByRole("button", { name: /Computer offline/ }));

    expect(onScenarioChange).toHaveBeenCalledExactlyOnceWith("computer-offline");
  });

  it("requires one confirmation before it resets the shared Account", async () => {
    const reset = vi.spyOn(browserApi, "resetOnboardingLab").mockResolvedValue();
    renderLab();

    fireEvent.click(screen.getByRole("button", { name: "Reset shared account and start onboarding" }));
    const dialog = await screen.findByRole("dialog");

    expect(within(dialog).getByText(/Another tester using it right now will be interrupted/)).toBeTruthy();
    expect(reset).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(reset).not.toHaveBeenCalled();
  });

  it("hands over only after the Server reports a verified reset", async () => {
    const reset = vi.spyOn(browserApi, "resetOnboardingLab").mockResolvedValue();
    const { onResetSucceeded } = renderLab();

    await confirmReset();

    await waitFor(() => expect(onResetSucceeded).toHaveBeenCalledTimes(1));
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it("stays on the Lab with a retry when the reset fails", async () => {
    const reset = vi
      .spyOn(browserApi, "resetOnboardingLab")
      .mockRejectedValueOnce(new Error("The Account still has active OpenTag resources"))
      .mockResolvedValueOnce();
    const { onResetSucceeded } = renderLab();

    await confirmReset();

    const failure = await screen.findByRole("alert");
    expect(within(failure).getByText("The Account still has active OpenTag resources")).toBeTruthy();
    expect(onResetSucceeded).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { level: 1, name: "Onboarding Lab" })).toBeTruthy();

    fireEvent.click(within(failure).getByRole("button", { name: "Retry" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Reset and start onboarding" }));

    await waitFor(() => expect(onResetSucceeded).toHaveBeenCalledTimes(1));
    expect(reset).toHaveBeenCalledTimes(2);
  });
});

describe("Onboarding Lab route", () => {
  let meRequests = 0;

  function installApi(options: { available?: boolean; setupCompletedAt?: string | null } = {}) {
    meRequests = 0;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const path = String(input);
      if (path === "/api/v1/me") {
        meRequests += 1;
        return json({
          user,
          workspaces: [
            {
              id: workspaceId,
              name: "lab",
              displayName: "Lab",
              setupCompletedAt: options.setupCompletedAt ?? null,
              grantedAt: "2026-08-20T00:00:00.000Z",
            },
          ],
        });
      }
      if (path === "/api/v1/internal/onboarding-lab") {
        if (init?.method === "POST") return new Response(null, { status: 204 });
        return new Response(null, { status: options.available === false ? 404 : 204 });
      }
      if (path.endsWith("/computers")) return json({ computers: [] });
      if (path.endsWith("/agents")) return json({ agents: [] });
      return new Response(null, { status: 204 });
    });
  }

  beforeEach(() => {
    window.history.replaceState({}, "", "/internal/onboarding-lab");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("stays reachable while setup is incomplete", async () => {
    installApi();

    render(<App />);

    expect(await screen.findByRole("heading", { level: 1, name: "Onboarding Lab" })).toBeTruthy();
    expect(window.location.pathname).toBe("/internal/onboarding-lab");
  });

  it("renders Not Found for an Account that may not use the Lab", async () => {
    installApi({ available: false });

    render(<App />);

    expect(await screen.findByRole("heading", { level: 1, name: "Page not found" })).toBeTruthy();
  });

  it("renders the scenario named in the URL", async () => {
    installApi();
    window.history.replaceState({}, "", "/internal/onboarding-lab?scenario=computer-offline");

    render(<App />);

    const preview = await screen.findByLabelText("Onboarding preview: Computer offline");
    expect(within(preview).getByRole("heading", { level: 2, name: "Prepare your Agent" })).toBeTruthy();
    expect(within(preview).getAllByText("Computer offline").length).toBeGreaterThan(0);
    expect(within(preview).getAllByText("Reconnect").length).toBeGreaterThan(0);
  });

  it("refreshes authoritative state and enters ordinary onboarding after a reset", async () => {
    installApi({ setupCompletedAt: "2026-08-20T00:00:00.000Z" });
    window.history.replaceState({}, "", "/internal/onboarding-lab?scenario=setup-complete");
    render(<App />);
    await screen.findByRole("heading", { level: 1, name: "Onboarding Lab" });
    const before = meRequests;

    await confirmReset();

    await waitFor(() => expect(window.location.pathname).toBe("/onboarding"));
    expect(window.location.search).toBe("");
    await waitFor(() => expect(meRequests).toBeGreaterThan(before));
  });
});
