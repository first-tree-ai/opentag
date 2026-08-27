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
      resetAvailable
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
          resetAvailable
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

  it("stays inert when every control in every preview is clicked", async () => {
    const requests = vi.mocked(fetch);
    for (const scenario of ONBOARDING_SCENARIOS) {
      const view = render(
        <OnboardingLabPage
          resetAvailable
          scenarioId={scenario.id}
          user={user}
          onResetSucceeded={vi.fn()}
          onScenarioChange={vi.fn()}
        />,
      );
      // Clicking a control can reveal another, so keep going until the preview stops changing.
      const clicked = new Set<Element>();
      for (let pass = 0; pass < 4; pass += 1) {
        const preview = screen.getByLabelText(`Onboarding preview: ${scenario.title}`);
        const controls = [
          ...within(preview).queryAllByRole("button"),
          ...within(preview).queryAllByRole("link"),
        ].filter((control) => !clicked.has(control) && !control.hasAttribute("disabled"));
        if (controls.length === 0) break;
        for (const control of controls) {
          clicked.add(control);
          fireEvent.click(control);
        }
      }
      expect(clicked.size).toBeGreaterThan(0);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(requests, `scenario ${scenario.id} issued a request`).not.toHaveBeenCalled();
      view.unmount();
    }
  });

  it("communicates each state without contacting the Server", () => {
    const requests = vi.mocked(fetch);

    render(
      <OnboardingLabPage
        resetAvailable
        scenarioId="computer-offline"
        user={user}
        onResetSucceeded={vi.fn()}
        onScenarioChange={vi.fn()}
      />,
    ).unmount();
    render(
      <OnboardingLabPage
        resetAvailable
        scenarioId="setup-complete"
        user={user}
        onResetSucceeded={vi.fn()}
        onScenarioChange={vi.fn()}
      />,
    ).unmount();
    render(
      <OnboardingLabPage
        resetAvailable
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
  let resetRequests = 0;

  function installApi(
    options: {
      configured?: boolean;
      resetAvailable?: boolean;
      workspaces?: "none";
      setupCompletedAt?: string | null;
      afterResetSetupCompletedAt?: string | null;
      meDelayMs?: number;
      meFailsAfterReset?: boolean;
    } = {},
  ) {
    meRequests = 0;
    resetRequests = 0;
    const completed = options.setupCompletedAt === undefined ? null : options.setupCompletedAt;
    const afterReset = options.afterResetSetupCompletedAt === undefined ? null : options.afterResetSetupCompletedAt;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const path = String(input);
      if (path === "/api/v1/me") {
        meRequests += 1;
        if (resetRequests > 0 && options.meFailsAfterReset) {
          return json(
            { error: { code: "SERVICE_UNAVAILABLE", category: "transient", message: "Account state unavailable" } },
            503,
          );
        }
        if (options.meDelayMs) await new Promise((resolve) => setTimeout(resolve, options.meDelayMs));
        if (options.workspaces === "none") return json({ user, workspaces: [] });
        return json({
          user,
          workspaces: [
            {
              id: workspaceId,
              name: "lab",
              displayName: "Lab",
              setupCompletedAt: resetRequests > 0 ? afterReset : completed,
              grantedAt: "2026-08-20T00:00:00.000Z",
            },
          ],
        });
      }
      if (path === "/api/v1/internal/onboarding-lab") {
        if (init?.method === "POST") {
          resetRequests += 1;
          return new Response(null, { status: 204 });
        }
        if (options.configured === false) return new Response(null, { status: 404 });
        return json({ reset: options.resetAvailable !== false });
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

  it("renders Not Found where the deployment configures no Lab", async () => {
    installApi({ configured: false });

    render(<App />);

    expect(await screen.findByRole("heading", { level: 1, name: "Page not found" })).toBeTruthy();
  });

  it("shows Preview but no reset control to an Account that does not own the reset", async () => {
    installApi({ resetAvailable: false });

    render(<App />);

    expect(await screen.findByRole("heading", { level: 1, name: "Onboarding Lab" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2, name: "Scenario Preview" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Reset shared account and start onboarding" })).toBeNull();
    expect(resetRequests).toBe(0);
  });

  it("shows Preview to an authenticated Account that holds no active resource grant", async () => {
    // The Server admits this Account and answers the Lab read, so the Web must not refuse it first.
    installApi({ resetAvailable: false, workspaces: "none" });

    render(<App />);

    expect(await screen.findByRole("heading", { level: 1, name: "Onboarding Lab" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /Brand new account/ }).length).toBeGreaterThan(0);
    expect(screen.queryByRole("heading", { name: "OpenTag is not ready for this account" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reset shared account and start onboarding" })).toBeNull();
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

  it("waits for the refreshed Account before entering ordinary onboarding", async () => {
    installApi({ setupCompletedAt: "2026-08-20T00:00:00.000Z", meDelayMs: 30 });
    window.history.replaceState({}, "", "/internal/onboarding-lab?scenario=setup-complete");
    render(<App />);
    await screen.findByRole("heading", { level: 1, name: "Onboarding Lab" });
    const before = meRequests;

    await confirmReset();

    // The Account still reports completed setup until the refresh lands, so leaving early would let
    // the setup gate bounce the tester to /agents instead of into onboarding.
    expect(window.location.pathname).toBe("/internal/onboarding-lab");
    await waitFor(() => expect(window.location.pathname).toBe("/onboarding"));
    expect(window.location.search).toBe("");
    expect(meRequests).toBeGreaterThan(before);
    expect(await screen.findByRole("heading", { level: 1, name: "Set up OpenTag" })).toBeTruthy();
  });

  it("stays on the Lab when the refreshed Account still reports completed setup", async () => {
    installApi({
      setupCompletedAt: "2026-08-20T00:00:00.000Z",
      afterResetSetupCompletedAt: "2026-08-20T00:00:00.000Z",
    });
    render(<App />);
    await screen.findByRole("heading", { level: 1, name: "Onboarding Lab" });

    await confirmReset();

    const failure = await screen.findByRole("alert");
    expect(within(failure).getByText(/still reports completed setup/)).toBeTruthy();
    expect(window.location.pathname).toBe("/internal/onboarding-lab");
  });

  it("stays on the Lab when the authoritative refresh fails", async () => {
    installApi({ setupCompletedAt: "2026-08-20T00:00:00.000Z", meFailsAfterReset: true });
    render(<App />);
    await screen.findByRole("heading", { level: 1, name: "Onboarding Lab" });

    await confirmReset();

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(window.location.pathname).toBe("/internal/onboarding-lab");
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });
});
