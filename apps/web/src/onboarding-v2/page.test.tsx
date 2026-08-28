import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OnboardingV2Page } from "./page.js";

// The realistic timings the mock uses, so a test advances by a meaningful amount rather than a
// magic number.
const ISSUE_MS = 500;
const CONNECT_MS = 8_000;
const DWELL_MS = 1_400;
const PROBE_MS = 2_500;
const CREATE_MS = 900;
const SCAN_MS = 6_000;

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** Walks to the connect step, where the install command is on screen. */
async function reachConnectStep() {
  fireEvent.click(screen.getByRole("button", { name: /Local computer/ }));
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  fireEvent.click(screen.getByRole("button", { name: /Codex/ }));
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  await advance(ISSUE_MS);
}

/**
 * Advances through the Computer arriving, the dwell that lets the arrival be read, and the probe.
 * These are separate advances because each timer is only created once React has committed the
 * render before it.
 */
async function reachCheckStep() {
  await advance(CONNECT_MS);
  await advance(DWELL_MS);
  await advance(PROBE_MS);
}

function openLab() {
  fireEvent.click(screen.getByRole("button", { name: "Mock controls" }));
}

function chooseScenario(id: string) {
  openLab();
  fireEvent.change(screen.getByLabelText("Readiness outcome"), { target: { value: id } });
  fireEvent.click(screen.getByRole("button", { name: "Mock controls" }));
}

describe("OnboardingV2Page", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    Reflect.deleteProperty(navigator, "clipboard");
  });

  it("offers the local computer and marks the cloud one as coming soon", () => {
    render(<OnboardingV2Page />);
    expect((screen.getByRole("button", { name: /Local computer/ }) as HTMLButtonElement).disabled).toBe(false);
    const cloud = screen.getByRole("button", { name: /Cloud computer/ }) as HTMLButtonElement;
    expect(cloud.disabled).toBe(true);
    expect(cloud.textContent).toContain("Coming soon");
  });

  it("requires a confirmed choice rather than advancing on selection", () => {
    render(<OnboardingV2Page />);
    expect((screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /Local computer/ }));
    expect(screen.getByRole("heading", { name: "Where should your agent run?" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByRole("heading", { name: "Create your agent" })).toBeTruthy();
  });

  it("offers exactly the two supported runtimes", () => {
    render(<OnboardingV2Page />);
    fireEvent.click(screen.getByRole("button", { name: /Local computer/ }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByRole("button", { name: /Codex/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Claude Code/ })).toBeTruthy();
    expect(screen.getByText("More runtimes coming soon.")).toBeTruthy();
  });

  it("explains an invalid name instead of advancing", () => {
    render(<OnboardingV2Page />);
    fireEvent.click(screen.getByRole("button", { name: /Local computer/ }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(screen.getByRole("button", { name: /Codex/ }));
    fireEvent.change(screen.getByLabelText("Agent name"), { target: { value: "Open Tag" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByRole("alert").textContent).toContain("lowercase letters");
    expect(screen.getByRole("heading", { name: "Create your agent" })).toBeTruthy();
  });

  it("keeps the command's preamble with the command rather than in the page header", async () => {
    render(<OnboardingV2Page />);
    await reachConnectStep();
    expect(screen.getByText(/Your AI worker runs on your own computer/)).toBeTruthy();
    expect(screen.getByText("Your code and data never leave your machine.")).toBeTruthy();
    expect(screen.getByText("Run this in your terminal, or paste it to your agent.")).toBeTruthy();
    expect(screen.getByText("# Install the OpenTag CLI and connect this computer to OpenTag.")).toBeTruthy();
  });

  it("issues the same install command shape the Server builds", async () => {
    render(<OnboardingV2Page />);
    await reachConnectStep();
    // `npm i -g <package> && <bin> computer connect --server <url> -- <32-char base64url code>`
    const command = screen.getByText(/opentag computer connect/).textContent ?? "";
    expect(command).toMatch(
      /npm i -g open-tag && opentag computer connect --server https:\/\/\S+ -- [A-Za-z0-9_-]{32}$/,
    );
  });

  it("copies the comment together with the command", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    render(<OnboardingV2Page />);
    await reachConnectStep();

    fireEvent.click(screen.getAllByRole("button", { name: /Copy/ })[0] as HTMLElement);
    await act(async () => undefined);
    const payload = writeText.mock.calls[0]?.[0] as string;
    expect(payload.startsWith("# Install the OpenTag CLI")).toBe(true);
    expect(payload).toContain("npm i -g open-tag");
  });

  it("counts the command's validity down and offers a fresh one once it expires", async () => {
    render(<OnboardingV2Page />);
    await reachConnectStep();
    expect(screen.getByText("Expires in 15:00")).toBeTruthy();

    openLab();
    fireEvent.click(screen.getByRole("button", { name: "Expire code" }));
    expect(screen.getByText("This command has expired.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Get a new command" }));
    await advance(ISSUE_MS);
    expect(screen.getByText("Expires in 15:00")).toBeTruthy();
  });

  it("shows the arrival before advancing to the check on its own", async () => {
    render(<OnboardingV2Page />);
    await reachConnectStep();

    await advance(CONNECT_MS);
    expect(screen.getByText("Your computer is connected.")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Your computer" })).toBeTruthy();

    await advance(DWELL_MS);
    expect(screen.getByRole("heading", { name: "Computer check" })).toBeTruthy();
  });

  it("reports a clean environment and offers to create the Agent", async () => {
    render(<OnboardingV2Page />);
    await reachConnectStep();
    await reachCheckStep();

    expect(screen.getByRole("heading", { name: "Environment check" })).toBeTruthy();
    expect(screen.getByText("Codex CLI is installed")).toBeTruthy();
    expect(screen.getByText("Feishu CLI is installed")).toBeTruthy();
    expect(screen.getByText("Everything your agent needs is ready.")).toBeTruthy();
  });

  it("hands a failing check to the terminal rather than offering a retry button", async () => {
    render(<OnboardingV2Page />);
    chooseScenario("runtime-install");
    await reachConnectStep();
    await reachCheckStep();

    expect(screen.getByText("One thing needs fixing before your agent can run.")).toBeTruthy();
    expect(screen.getByText("Run this in your terminal or paste it to your agent.")).toBeTruthy();
    expect(screen.getByText("opentag doctor --fix")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /check again/i })).toBeNull();
    // Sign-in cannot be answered while the CLI is missing, and the page says so.
    expect(screen.getByText("We'll know once the CLI is installed.")).toBeTruthy();
  });

  it("keeps one heading and a detail line on every check, in every state", async () => {
    render(<OnboardingV2Page />);
    chooseScenario("runtime-install");
    await reachConnectStep();
    await advance(CONNECT_MS);
    await advance(DWELL_MS);

    // Mid-probe: the heading is already final and every row already has its detail line.
    expect(screen.getByRole("heading", { name: "Environment check" })).toBeTruthy();
    const rowsWhileChecking = document.querySelectorAll(".otv2-check");
    expect(rowsWhileChecking).toHaveLength(3);
    for (const row of rowsWhileChecking) {
      expect(row.querySelectorAll("span > span")).toHaveLength(1);
    }

    await advance(PROBE_MS);
    expect(screen.getByRole("heading", { name: "Environment check" })).toBeTruthy();
    expect(document.querySelectorAll(".otv2-check")).toHaveLength(3);
    for (const row of document.querySelectorAll(".otv2-check")) {
      expect((row.textContent ?? "").trim().length).toBeGreaterThan(0);
    }
  });

  it("counts multiple failures in its summary", async () => {
    render(<OnboardingV2Page />);
    chooseScenario("both-failing");
    await reachConnectStep();
    await reachCheckStep();
    expect(screen.getByText("2 things need fixing before your agent can run.")).toBeTruthy();
  });

  it("turns green on its own after the terminal repair, with no page action", async () => {
    render(<OnboardingV2Page />);
    chooseScenario("messaging-install");
    await reachConnectStep();
    await reachCheckStep();
    expect(screen.getByText("We need lark-cli to send Feishu messages.")).toBeTruthy();

    openLab();
    fireEvent.click(screen.getByRole("button", { name: "Ran doctor --fix" }));
    await advance(4_000);
    expect(screen.getByRole("button", { name: "Continue" })).toBeTruthy();
  });

  it("creates the Agent only after a runnable route is proven, then asks for Feishu", async () => {
    render(<OnboardingV2Page />);
    await reachConnectStep();
    await reachCheckStep();

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await advance(CREATE_MS);
    expect(screen.getByRole("heading", { name: "Connect your messaging app" })).toBeTruthy();

    await advance(ISSUE_MS);
    await advance(SCAN_MS);
    expect(screen.getByRole("heading", { name: "opentag is ready." })).toBeTruthy();
  });

  describe("going back", () => {
    it("returns from the agent step to the destination, keeping the draft", async () => {
      render(<OnboardingV2Page />);
      fireEvent.click(screen.getByRole("button", { name: /Local computer/ }));
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
      fireEvent.change(screen.getByLabelText("Agent name"), { target: { value: "helper" } });

      fireEvent.click(screen.getByRole("button", { name: "Go back" }));
      expect(screen.getByRole("heading", { name: "Where should your agent run?" })).toBeTruthy();

      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
      expect((screen.getByLabelText("Agent name") as HTMLInputElement).value).toBe("helper");
    });

    it("returns from the connect step to the agent step", async () => {
      render(<OnboardingV2Page />);
      await reachConnectStep();
      fireEvent.click(screen.getByRole("button", { name: "Go back" }));
      expect(screen.getByRole("heading", { name: "Create your agent" })).toBeTruthy();
    });

    it("reissues a command when returning from the check step", async () => {
      render(<OnboardingV2Page />);
      await reachConnectStep();
      await reachCheckStep();

      fireEvent.click(screen.getByRole("button", { name: "Go back" }));
      await advance(ISSUE_MS);
      expect(screen.getByRole("heading", { name: "Your computer" })).toBeTruthy();
      expect(screen.getByText("Waiting for your computer…")).toBeTruthy();
      expect(screen.getByText("Expires in 15:00")).toBeTruthy();
    });

    it("has no way back once the Agent has been created", async () => {
      render(<OnboardingV2Page />);
      await reachConnectStep();
      await reachCheckStep();
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
      await advance(CREATE_MS);
      expect(screen.queryByRole("button", { name: "Go back" })).toBeNull();
    });
  });

  it("never connects a Computer with an expired code", async () => {
    render(<OnboardingV2Page />);
    await reachConnectStep();

    openLab();
    fireEvent.click(screen.getByRole("button", { name: "Expire code" }));
    fireEvent.click(screen.getByRole("button", { name: "Mock controls" }));

    // The arrival timer from the original issue is still pending; it must not resurrect the code.
    await advance(CONNECT_MS);
    expect(screen.getByText("This command has expired.")).toBeTruthy();
    expect(screen.queryByText("Your computer is connected.")).toBeNull();
  });

  it("cancels a creation still in flight when the flow is restarted", async () => {
    render(<OnboardingV2Page />);
    await reachConnectStep();
    await reachCheckStep();

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(screen.getByRole("button", { name: "Start over" }));
    await advance(CREATE_MS);

    // Second run: the stale creation must not carry the flow past its confirmation.
    await reachConnectStep();
    await reachCheckStep();
    expect(screen.getByRole("button", { name: "Continue" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Connect your messaging app" })).toBeNull();
  });

  it("returns to the first step when the flow is restarted", async () => {
    render(<OnboardingV2Page />);
    await reachConnectStep();
    fireEvent.click(screen.getByRole("button", { name: "Start over" }));
    expect(screen.getByRole("heading", { name: "Where should your agent run?" })).toBeTruthy();
  });
});
