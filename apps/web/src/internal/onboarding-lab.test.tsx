import type { UserProfile } from "@opentag/shared/browser";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { browserApi } from "../api.js";
import { App } from "../app.js";
import { OnboardingLabPage } from "./onboarding-lab-page.js";
import { ONBOARDING_SCENARIOS } from "./onboarding-lab-scenarios.js";

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

/**
 * The onboarding surface the Lab renders as its page. The Lab adds no frame of its own, so this is
 * the same element production renders, and the floating switcher is the only thing outside it.
 */
function onboardingSurface(): HTMLElement {
  const shell = document.querySelector<HTMLElement>('[data-ui="onboarding-shell"]');
  if (!shell) throw new Error("The Lab did not render the onboarding surface");
  return shell;
}

/** Opens the floating switcher, which is where every control the Lab adds lives. */
function openSwitcher(): HTMLElement {
  const toggle = screen.getByRole("button", { name: /Onboarding Lab/ });
  if (toggle.getAttribute("aria-expanded") !== "true") fireEvent.click(toggle);
  return toggle;
}

async function confirmReset() {
  openSwitcher();
  fireEvent.click(screen.getByRole("button", { name: "Reset my account and start onboarding" }));
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "Reset and start onboarding" }));
}

describe("Onboarding Lab page", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("says whose Account the reset destroys, and that it is nobody else's", () => {
    renderLab();
    openSwitcher();

    expect(screen.getByText(/This resets your own Account/)).toBeTruthy();
    expect(screen.getByText(new RegExp(user.email))).toBeTruthy();
    expect(screen.getByText(/reaches nothing of anyone else's/)).toBeTruthy();
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
      expect(within(onboardingSurface()).getByRole("heading", { level: 1, name: "Set up OpenTag" })).toBeTruthy();
      view.unmount();
    }
  });

  it("stays inert when every control in every preview is clicked", async () => {
    const requests = vi.mocked(fetch);
    for (const scenario of ONBOARDING_SCENARIOS) {
      const view = render(
        <OnboardingLabPage
          scenarioId={scenario.id}
          user={user}
          onResetSucceeded={vi.fn()}
          onScenarioChange={vi.fn()}
        />,
      );
      // Clicking a control can reveal another, so keep going until the preview stops changing.
      const clicked = new Set<Element>();
      for (let pass = 0; pass < 4; pass += 1) {
        const preview = onboardingSurface();
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

  it("puts the controls it reveals next in the tab order", () => {
    renderLab();
    const toggle = openSwitcher();
    const panel = document.getElementById("onboarding-lab-switcher-panel");
    if (!panel) throw new Error("The switcher panel did not open");

    // A forward Tab from the toggle has to land inside the panel it just opened. Rendering the panel
    // ahead of its toggle would send it into the onboarding page instead.
    expect(toggle.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(toggle.getAttribute("aria-controls")).toBe("onboarding-lab-switcher-panel");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");

    fireEvent.keyDown(document, { key: "Escape" });
    expect(document.getElementById("onboarding-lab-switcher-panel")).toBeNull();
    expect(document.activeElement).toBe(toggle);
  });

  it("keeps only the selected fixture in the URL", () => {
    const { onScenarioChange } = renderLab();
    openSwitcher();

    fireEvent.click(screen.getByRole("button", { name: /Computer offline/ }));

    expect(onScenarioChange).toHaveBeenCalledExactlyOnceWith("computer-offline");
  });

  it("requires one confirmation before it resets this Account", async () => {
    const reset = vi.spyOn(browserApi, "resetOnboardingLab").mockResolvedValue();
    renderLab();
    openSwitcher();

    fireEvent.click(screen.getByRole("button", { name: "Reset my account and start onboarding" }));
    const dialog = await screen.findByRole("dialog");

    expect(within(dialog).getByText(/Nobody else's Account is touched/)).toBeTruthy();
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
    expect(screen.getByRole("button", { name: /Onboarding Lab/ })).toBeTruthy();

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
      offered?: boolean;
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
        if (options.workspaces === "none") return json({ user, setupCompletedAt: null });
        return json({
          user,
          setupCompletedAt: resetRequests > 0 ? afterReset : completed,
        });
      }
      if (path === "/api/v1/internal/onboarding-lab") {
        if (init?.method === "POST") {
          resetRequests += 1;
          return new Response(null, { status: 204 });
        }
        if (options.offered === false) return new Response(null, { status: 404 });
        return new Response(null, { status: 204 });
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

    // The Lab renders the onboarding page itself; only the floating switcher names the Lab.
    expect(await screen.findByRole("button", { name: /Onboarding Lab/ })).toBeTruthy();
    expect(within(onboardingSurface()).getByRole("heading", { level: 1, name: "Set up OpenTag" })).toBeTruthy();
    expect(window.location.pathname).toBe("/internal/onboarding-lab");
  });

  it("renders the onboarding page without the application navigation", async () => {
    installApi();

    render(<App />);

    await screen.findByRole("button", { name: /Onboarding Lab/ });
    expect(document.querySelector(".shell")).toBeNull();
    expect(screen.queryByRole("navigation", { name: "Primary navigation" })).toBeNull();
  });

  it("renders Not Found where the deployment offers no Lab at all", async () => {
    installApi({ offered: false });

    render(<App />);

    expect(await screen.findByRole("heading", { level: 1, name: "Page not found" })).toBeTruthy();
  });

  it("offers both halves to any Account the Lab answers, and requests nothing until asked", async () => {
    installApi();

    render(<App />);

    await screen.findByRole("button", { name: /Onboarding Lab/ });
    openSwitcher();
    expect(screen.getByRole("heading", { level: 2, name: "Onboarding Lab" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reset my account and start onboarding" })).toBeTruthy();
    expect(resetRequests).toBe(0);
  });

  it("shows the Lab to an authenticated Account that holds no active resource grant", async () => {
    // The Server admits this Account and answers the Lab read, so the Web must not refuse it first.
    installApi({ workspaces: "none" });

    render(<App />);

    await screen.findByRole("button", { name: /Onboarding Lab/ });
    openSwitcher();
    expect(screen.getAllByRole("button", { name: /Brand new account/ }).length).toBeGreaterThan(0);
    expect(screen.queryByRole("heading", { name: "OpenTag is not ready for this account" })).toBeNull();
  });

  it("renders the scenario named in the URL", async () => {
    installApi();
    window.history.replaceState({}, "", "/internal/onboarding-lab?scenario=computer-offline");

    render(<App />);

    await screen.findByRole("button", { name: /Onboarding Lab/ });
    const preview = onboardingSurface();
    expect(within(preview).getByRole("heading", { level: 2, name: "Prepare your Agent" })).toBeTruthy();
    expect(within(preview).getAllByText("Computer offline").length).toBeGreaterThan(0);
    expect(within(preview).getAllByText("Reconnect").length).toBeGreaterThan(0);
  });

  it("waits for the refreshed Account before entering ordinary onboarding", async () => {
    installApi({ setupCompletedAt: "2026-08-20T00:00:00.000Z", meDelayMs: 30 });
    window.history.replaceState({}, "", "/internal/onboarding-lab?scenario=setup-complete");
    render(<App />);
    await screen.findByRole("button", { name: /Onboarding Lab/ });
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
    await screen.findByRole("button", { name: /Onboarding Lab/ });

    await confirmReset();

    const failure = await screen.findByRole("alert");
    expect(within(failure).getByText(/still reports completed setup/)).toBeTruthy();
    expect(window.location.pathname).toBe("/internal/onboarding-lab");
  });

  it("stays on the Lab when the authoritative refresh fails", async () => {
    installApi({ setupCompletedAt: "2026-08-20T00:00:00.000Z", meFailsAfterReset: true });
    render(<App />);
    await screen.findByRole("button", { name: /Onboarding Lab/ });

    await confirmReset();

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(window.location.pathname).toBe("/internal/onboarding-lab");
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });
});
