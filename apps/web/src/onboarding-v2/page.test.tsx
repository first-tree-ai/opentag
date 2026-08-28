import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OnboardingV2Page } from "./page.js";

// The realistic timings the mock uses, so a test advances by a meaningful amount rather than a
// magic number: issue, then the Computer arriving, then the readiness probe resolving.
const ISSUE_MS = 500;
const CONNECT_MS = 8_000;
const PROBE_MS = 2_500;
const CREATE_MS = 900;
const SCAN_MS = 6_000;

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/**
 * Advances past the Computer arriving and then past the readiness probe, in two steps. The probe
 * timer only exists once React has committed the "connected" render, so collapsing these into one
 * advance would start the probe at the end of the window instead of inside it.
 */
async function connectAndProbe() {
  await advance(CONNECT_MS);
  await advance(PROBE_MS);
}

/** Walks the flow up to the point where the connect command is on screen. */
async function reachSetupStep() {
  fireEvent.click(screen.getByRole("button", { name: /Local computer/ }));
  fireEvent.click(screen.getByRole("button", { name: /Codex/ }));
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  await advance(ISSUE_MS);
}

function openLab() {
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

  it("offers exactly the two supported runtimes", async () => {
    render(<OnboardingV2Page />);
    fireEvent.click(screen.getByRole("button", { name: /Local computer/ }));
    expect(screen.getByRole("button", { name: /Codex/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Claude Code/ })).toBeTruthy();
    expect(screen.getByText("More runtimes coming soon.")).toBeTruthy();
  });

  it("holds Continue until a runtime is chosen", () => {
    render(<OnboardingV2Page />);
    fireEvent.click(screen.getByRole("button", { name: /Local computer/ }));
    expect((screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /Codex/ }));
    expect((screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("explains an invalid name instead of advancing", async () => {
    render(<OnboardingV2Page />);
    fireEvent.click(screen.getByRole("button", { name: /Local computer/ }));
    fireEvent.click(screen.getByRole("button", { name: /Codex/ }));
    fireEvent.change(screen.getByLabelText("Agent name"), { target: { value: "Open Tag" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByRole("alert").textContent).toContain("lowercase letters");
    expect(screen.getByRole("heading", { name: "Create your agent" })).toBeTruthy();
  });

  it("shows the connect command with its agent-directed comment", async () => {
    render(<OnboardingV2Page />);
    await reachSetupStep();
    expect(screen.getByText("# Install the OpenTag CLI and connect this computer to OpenTag.")).toBeTruthy();
    expect(screen.getByText(/opentag computer connect/)).toBeTruthy();
    expect(screen.getByText("Waiting for your computer…")).toBeTruthy();
  });

  it("copies the comment together with the command", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    render(<OnboardingV2Page />);
    await reachSetupStep();

    fireEvent.click(screen.getAllByRole("button", { name: /Copy/ })[0] as HTMLElement);
    await act(async () => undefined);
    expect(writeText).toHaveBeenCalled();
    const payload = writeText.mock.calls[0]?.[0] as string;
    expect(payload.startsWith("# Install the OpenTag CLI")).toBe(true);
    expect(payload).toContain("npm i -g open-tag");
  });

  it("counts the command's validity down and offers a fresh one once it expires", async () => {
    render(<OnboardingV2Page />);
    await reachSetupStep();
    expect(screen.getByText("Expires in 15:00")).toBeTruthy();

    openLab();
    fireEvent.click(screen.getByRole("button", { name: "Expire code" }));
    expect(screen.getByText("This command has expired.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Get a new command" }));
    await advance(ISSUE_MS);
    expect(screen.getByText("Expires in 15:00")).toBeTruthy();
  });

  it("checks the runtime on the same page once the Computer connects", async () => {
    render(<OnboardingV2Page />);
    await reachSetupStep();
    await advance(CONNECT_MS);

    expect(screen.getByText("MacBook Pro is connected.")).toBeTruthy();
    // Still the setup page: the check is a section, not a navigation.
    expect(screen.getByRole("heading", { name: "Set up your agent to run" })).toBeTruthy();
    expect(screen.getByText("Checking your agent runtime")).toBeTruthy();

    await advance(PROBE_MS);
    expect(screen.getByText("Codex CLI is installed")).toBeTruthy();
    expect(screen.getByText("Feishu CLI is installed")).toBeTruthy();
    expect(screen.getByText("Everything your agent needs is ready.")).toBeTruthy();
  });

  it("hands a failing check to the terminal rather than offering a retry button", async () => {
    render(<OnboardingV2Page />);
    openLab();
    fireEvent.change(screen.getByLabelText("Readiness outcome"), { target: { value: "runtime-install" } });
    fireEvent.click(screen.getByRole("button", { name: "Mock controls" }));

    await reachSetupStep();
    await connectAndProbe();

    expect(screen.getByText("opentag doctor --fix")).toBeTruthy();
    expect(screen.getByText("This page updates on its own once it's fixed.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /check again/i })).toBeNull();
    // Sign-in cannot be answered while the CLI is missing, and the page says so.
    expect(screen.getByText("We'll know once the CLI is installed.")).toBeTruthy();
  });

  it("turns green on its own after the terminal repair, with no page action", async () => {
    render(<OnboardingV2Page />);
    openLab();
    fireEvent.change(screen.getByLabelText("Readiness outcome"), { target: { value: "messaging-install" } });

    await reachSetupStep();
    await connectAndProbe();
    expect(screen.getByText(/lark-cli, which isn't installed yet/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Ran doctor --fix" }));
    await advance(4_000);
    expect(screen.getByRole("button", { name: "Create my agent" })).toBeTruthy();
  });

  it("creates the Agent only after a runnable route is proven, then asks for Feishu", async () => {
    render(<OnboardingV2Page />);
    await reachSetupStep();
    await connectAndProbe();

    fireEvent.click(screen.getByRole("button", { name: "Create my agent" }));
    await advance(CREATE_MS);

    expect(screen.getByRole("heading", { name: "Connect your messaging app" })).toBeTruthy();
    await advance(ISSUE_MS);
    await advance(SCAN_MS);
    expect(screen.getByRole("heading", { name: "@opentag is ready." })).toBeTruthy();
  });

  it("never connects a Computer with an expired code", async () => {
    render(<OnboardingV2Page />);
    await reachSetupStep();

    openLab();
    fireEvent.click(screen.getByRole("button", { name: "Expire code" }));
    fireEvent.click(screen.getByRole("button", { name: "Mock controls" }));

    // The arrival timer from the original issue is still pending; it must not resurrect the code.
    await advance(CONNECT_MS);
    expect(screen.getByText("This command has expired.")).toBeTruthy();
    expect(screen.queryByText("MacBook Pro is connected.")).toBeNull();
    expect(screen.getByText("Waiting for your computer…")).toBeTruthy();
  });

  it("cancels a creation still in flight when the flow is restarted", async () => {
    render(<OnboardingV2Page />);
    await reachSetupStep();
    await connectAndProbe();

    fireEvent.click(screen.getByRole("button", { name: "Create my agent" }));
    fireEvent.click(screen.getByRole("button", { name: "Start over" }));
    await advance(CREATE_MS);

    // Second run: the stale creation must not carry the flow past its confirmation.
    await reachSetupStep();
    await connectAndProbe();
    expect(screen.getByRole("button", { name: "Create my agent" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Connect your messaging app" })).toBeNull();
  });

  it("states the OpenTag boundary without promising provider-side privacy", async () => {
    render(<OnboardingV2Page />);
    await reachSetupStep();
    expect(screen.getByText(/stay on your computer/)).toBeTruthy();
    expect(screen.getByText(/sends prompts and context to its own provider/)).toBeTruthy();
  });

  it("marks the repair command as design-only while the CLI cannot run it", async () => {
    render(<OnboardingV2Page />);
    openLab();
    fireEvent.change(screen.getByLabelText("Readiness outcome"), { target: { value: "runtime-install" } });
    fireEvent.click(screen.getByRole("button", { name: "Mock controls" }));

    await reachSetupStep();
    await connectAndProbe();
    expect(screen.getByText(/does not run these checks yet/)).toBeTruthy();
  });

  it("returns to the first step when the flow is restarted", async () => {
    render(<OnboardingV2Page />);
    await reachSetupStep();
    fireEvent.click(screen.getByRole("button", { name: "Start over" }));
    expect(screen.getByRole("heading", { name: "Where should your agent run?" })).toBeTruthy();
  });
});
