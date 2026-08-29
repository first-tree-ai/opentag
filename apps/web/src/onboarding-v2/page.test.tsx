import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OnboardingV2Page } from "./page.js";

// The mock defaults to manual: the Computer arriving, the check returning and the QR being
// scanned all wait to be advanced by hand. Only these two are still on a clock.
const ISSUE_MS = 300;
const DWELL_MS = 1_400;
const CREATE_MS = 900;

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** Presses the control that stands in for the outside world doing the next thing. */
async function advanceMock(label: string) {
  fireEvent.click(screen.getByRole("button", { name: label }));
  await act(async () => undefined);
}

/** Walks to the connect step, where the install command is on screen. */
async function reachConnectStep() {
  fireEvent.click(screen.getByRole("button", { name: /Local computer/ }));
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  fireEvent.click(screen.getByRole("button", { name: /Codex/ }));
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  await advance(ISSUE_MS);
}

/** Brings the Computer in and lets the arrival be read, landing on the check step. */
async function reachCheckStep() {
  await advanceMock("Connect computer");
  await advance(DWELL_MS);
}

/** Returns the check's result, so the step moves from probing to resolved. */
async function settleCheck() {
  await advanceMock("Return check result");
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
    const error = document.querySelector(".otv2-field-error") as HTMLElement;
    expect(error.textContent).toContain("lowercase letters");
    expect(error.dataset.empty).toBeUndefined();
    expect(screen.getByRole("heading", { name: "Create your agent" })).toBeTruthy();
  });

  it("reads heading, explanation, then control in both sections of the agent step", () => {
    render(<OnboardingV2Page />);
    fireEvent.click(screen.getByRole("button", { name: /Local computer/ }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    for (const section of document.querySelectorAll(".otv2-fieldset")) {
      const parts = [...section.children].map((child) => child.className || child.tagName.toLowerCase());
      const heading = parts.findIndex((part) => part === "otv2-fieldset__label" || part === "legend");
      const hint = parts.indexOf("otv2-fieldset__hint");
      const control = parts.findIndex((part) => part.includes("ds-control") || part.includes("otv2-choices"));
      expect(heading).toBeGreaterThanOrEqual(0);
      expect(hint).toBeGreaterThan(heading);
      expect(control).toBeGreaterThan(hint);
    }
  });

  it("holds the name error's line before there is an error to show", () => {
    render(<OnboardingV2Page />);
    fireEvent.click(screen.getByRole("button", { name: /Local computer/ }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    const error = document.querySelector(".otv2-field-error") as HTMLElement;
    expect(error).toBeTruthy();
    expect(error.dataset.empty).toBe("true");
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

    await advanceMock("Connect computer");
    expect(screen.getByText("Your computer is connected.")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Connect your computer" })).toBeTruthy();

    await advance(DWELL_MS);
    expect(screen.getByRole("heading", { name: "Computer check" })).toBeTruthy();
  });

  it("reports a clean environment and offers to create the Agent", async () => {
    render(<OnboardingV2Page />);
    await reachConnectStep();
    await reachCheckStep();
    await settleCheck();

    expect(screen.getByText("Codex CLI is installed")).toBeTruthy();
    expect(screen.getByText("Feishu CLI is installed")).toBeTruthy();
    expect(screen.getByText("Everything your agent needs is ready.")).toBeTruthy();
  });

  it("hands a failing check to the terminal rather than offering a retry button", async () => {
    render(<OnboardingV2Page />);
    chooseScenario("runtime-install");
    await reachConnectStep();
    await reachCheckStep();
    await settleCheck();

    expect(screen.getByText("One thing needs fixing before your agent can run.")).toBeTruthy();
    // A light pointer back to the terminal, not a command block: the repair is already running there.
    expect(screen.getByText("opentag doctor --fix").tagName).toBe("CODE");
    expect(screen.getByText(/Continue in your terminal or agent for instructions/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /check again/i })).toBeNull();
    expect(screen.queryAllByRole("button", { name: /Copy/ })).toHaveLength(0);
  });

  it("keeps one heading and a detail line on every check, in every state", async () => {
    render(<OnboardingV2Page />);
    chooseScenario("runtime-install");
    await reachConnectStep();
    await reachCheckStep();

    // Mid-probe: every row already has its detail line.
    const rowsWhileChecking = document.querySelectorAll(".otv2-check");
    expect(rowsWhileChecking).toHaveLength(3);
    for (const row of rowsWhileChecking) {
      expect(row.querySelectorAll("span > span")).toHaveLength(1);
    }

    await settleCheck();
    expect(document.querySelectorAll(".otv2-check")).toHaveLength(3);
    for (const row of document.querySelectorAll(".otv2-check")) {
      expect((row.textContent ?? "").trim().length).toBeGreaterThan(0);
    }
  });

  it("keeps the connect step's countdown and status slots through the arrival", async () => {
    render(<OnboardingV2Page />);
    await reachConnectStep();
    expect(document.querySelector(".otv2-command__footer")).toBeTruthy();
    expect(document.querySelector(".otv2-slot--status")).toBeTruthy();

    // The countdown goes away on arrival; its slot, and the status slot, must not.
    await advanceMock("Connect computer");
    expect(screen.queryByText(/Expires in/)).toBeNull();
    expect(document.querySelector(".otv2-command__footer")).toBeTruthy();
    expect(document.querySelector(".otv2-slot--status")).toBeTruthy();
  });

  it("keeps the check step's outcome slot before and after the result lands", async () => {
    render(<OnboardingV2Page />);
    await reachConnectStep();
    await reachCheckStep();

    // Still probing: the slot already holds its waiting line, in the same shape step 3 uses.
    const slot = () => document.querySelector(".otv2-slot--outcome");
    expect(slot()?.textContent).toContain("Waiting for the computer check…");
    expect(slot()?.querySelector(".otv2-pulse")).toBeTruthy();

    await settleCheck();
    expect(slot()).toBeTruthy();
    expect(slot()?.textContent).toContain("Everything your agent needs is ready.");
  });

  it("keeps Continue on every step, disabled until the step can be left", async () => {
    render(<OnboardingV2Page />);
    const next = () => screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement;

    expect(next().disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /Local computer/ }));
    expect(next().disabled).toBe(false);
    fireEvent.click(next());

    expect(next().disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /Codex/ }));
    expect(next().disabled).toBe(false);
    fireEvent.click(next());

    await advance(ISSUE_MS);
    expect(next().disabled).toBe(true);
    await advanceMock("Connect computer");
    expect(next().disabled).toBe(false);
  });

  it("counts multiple failures in its summary", async () => {
    render(<OnboardingV2Page />);
    chooseScenario("both-failing");
    await reachConnectStep();
    await reachCheckStep();
    await settleCheck();
    expect(screen.getByText("2 things need fixing before your agent can run.")).toBeTruthy();
  });

  it("turns green on its own after the terminal repair, with no page action", async () => {
    render(<OnboardingV2Page />);
    chooseScenario("messaging-install");
    await reachConnectStep();
    await reachCheckStep();
    await settleCheck();
    expect(screen.getByText("We need lark-cli to send Feishu messages.")).toBeTruthy();

    openLab();
    fireEvent.click(screen.getByRole("button", { name: "Ran doctor --fix" }));
    fireEvent.click(screen.getByRole("button", { name: "Mock controls" }));
    await settleCheck();
    expect((screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("creates the Agent only after a runnable route is proven, then asks for Feishu", async () => {
    render(<OnboardingV2Page />);
    await reachConnectStep();
    await reachCheckStep();
    await settleCheck();

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await advance(CREATE_MS);
    expect(screen.getByRole("heading", { name: "Connect your messaging app" })).toBeTruthy();

    await advance(ISSUE_MS);
    await advanceMock("Scan QR code");
    expect(screen.getByRole("heading", { name: "opentag is ready." })).toBeTruthy();
  });

  describe("the mock's advance control", () => {
    it("names the one thing the outside world would do next", async () => {
      render(<OnboardingV2Page />);
      await reachConnectStep();
      expect(screen.getByRole("button", { name: "Connect computer" })).toBeTruthy();

      await reachCheckStep();
      expect(screen.getByRole("button", { name: "Return check result" })).toBeTruthy();

      await settleCheck();
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
      await advance(CREATE_MS);
      await advance(ISSUE_MS);
      expect(screen.getByRole("button", { name: "Scan QR code" })).toBeTruthy();
    });

    it("has nothing to offer when nothing is waiting", () => {
      render(<OnboardingV2Page />);
      const control = screen.getByRole("button", { name: "Nothing waiting" }) as HTMLButtonElement;
      expect(control.disabled).toBe(true);
    });

    it("cannot bring a Computer in on an expired code", async () => {
      render(<OnboardingV2Page />);
      await reachConnectStep();
      openLab();
      fireEvent.click(screen.getByRole("button", { name: "Expire code" }));
      fireEvent.click(screen.getByRole("button", { name: "Mock controls" }));

      expect(screen.getByText("This command has expired.")).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Connect computer" })).toBeNull();
      expect((screen.getByRole("button", { name: "Nothing waiting" }) as HTMLButtonElement).disabled).toBe(true);
    });
  });

  describe("going back", () => {
    it("returns from the agent step to the destination, keeping the draft", () => {
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
      expect(screen.getByRole("heading", { name: "Connect your computer" })).toBeTruthy();
      expect(screen.getByText("Waiting for your computer…")).toBeTruthy();
      expect(screen.getByText("Expires in 15:00")).toBeTruthy();
    });

    it("has no way back once the Agent has been created", async () => {
      render(<OnboardingV2Page />);
      await reachConnectStep();
      await reachCheckStep();
      await settleCheck();
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
      await advance(CREATE_MS);
      expect(screen.queryByRole("button", { name: "Go back" })).toBeNull();
    });
  });

  it("cancels a creation still in flight when the flow is restarted", async () => {
    render(<OnboardingV2Page />);
    await reachConnectStep();
    await reachCheckStep();
    await settleCheck();

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(screen.getByRole("button", { name: "Start over" }));
    await advance(CREATE_MS);

    // Second run: the stale creation must not carry the flow past its confirmation.
    await reachConnectStep();
    await reachCheckStep();
    await settleCheck();
    expect((screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByRole("heading", { name: "Connect your messaging app" })).toBeNull();
  });

  it("returns to the first step when the flow is restarted", async () => {
    render(<OnboardingV2Page />);
    await reachConnectStep();
    fireEvent.click(screen.getByRole("button", { name: "Start over" }));
    expect(screen.getByRole("heading", { name: "Where should your agent run?" })).toBeTruthy();
  });
});
