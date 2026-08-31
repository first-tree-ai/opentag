import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHECK_COPY, CommandBlock } from "../setup/index.js";
import { COPY } from "./copy.js";
import { SCENARIOS } from "./mock-backend.js";
import { OnboardingV2MockPage } from "./page.js";

// The mock defaults to manual: the Computer arriving, the check returning and the QR being
// scanned all wait to be advanced by hand. Only these two are still on a clock.
const ISSUE_MS = 300;
const CREATE_MS = 900;
/** Allocating the cloud Computer the Agent is created on. */
const ALLOCATE_MS = 700;

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

/** Brings the Computer in. Its check reports on the same step, so nothing else has to happen. */
async function reachCheckStep() {
  await advanceMock("Connect computer");
}

/** Returns the check's result, so the step moves from probing to resolved. */
async function settleCheck() {
  await advanceMock("Return check result");
}

function openLab() {
  fireEvent.click(screen.getByRole("button", { name: "Mock controls" }));
}

/** Drives the readiness picker the way a reviewer does: open the listbox, choose the outcome. */
function chooseScenario(id: string) {
  const scenario = SCENARIOS.find((candidate) => candidate.id === id);
  if (!scenario) throw new Error(`no such scenario: ${id}`);
  openLab();
  fireEvent.click(screen.getByLabelText("Readiness outcome"));
  // The listbox commits on a pointer sequence, not a bare click, so the choice has to be made the
  // way a pointing device makes it.
  const option = screen.getByRole("option", { name: scenario.title });
  fireEvent.pointerDown(option);
  fireEvent.pointerUp(option);
  fireEvent.click(option);
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

  it("uses plural repair copy when multiple checks fail", () => {
    expect(CHECK_COPY["runtime-cli"].detail.failed("Codex")).toBe("We can't find the Codex command on this computer.");
    expect(COPY.check.failedIntro(2)).toBe("2 things need fixing before your agent can run.");
  });

  it("marks the cloud computer as coming soon, because the Server cannot allocate one yet", () => {
    render(<OnboardingV2MockPage />);
    expect((screen.getByRole("button", { name: /Local computer/ }) as HTMLButtonElement).disabled).toBe(false);

    const cloud = screen.getByRole("button", { name: /Cloud computer/ }) as HTMLButtonElement;
    expect(cloud.disabled).toBe(true);
    expect(cloud.textContent).toContain("Coming soon");
  });

  it("shows no progress rail until the branch is known", () => {
    render(<OnboardingV2MockPage />);
    // How many steps follow depends on this step's answer, so there is no honest length to show.
    expect(screen.queryByRole("navigation", { name: "Setup progress" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Local computer/ }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByRole("navigation", { name: "Setup progress" })).toBeTruthy();
  });

  it("requires a confirmed choice rather than advancing on selection", () => {
    render(<OnboardingV2MockPage />);
    expect((screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /Local computer/ }));
    expect(screen.getByRole("heading", { name: "Where should your agent run?" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByRole("heading", { name: "Create your agent" })).toBeTruthy();
  });

  it("offers exactly the two supported runtimes", () => {
    render(<OnboardingV2MockPage />);
    fireEvent.click(screen.getByRole("button", { name: /Local computer/ }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByRole("button", { name: /Codex/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Claude Code/ })).toBeTruthy();
    expect(screen.getByText("More runtimes coming soon.")).toBeTruthy();
  });

  it("gives the Kumo agent name input an explicit accessible label", () => {
    render(<OnboardingV2MockPage />);
    fireEvent.click(screen.getByRole("button", { name: /Local computer/ }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    const input = screen.getByRole("textbox", { name: "Agent name" });
    const labelId = input.getAttribute("aria-labelledby");
    expect(labelId).toBeTruthy();
    expect(document.getElementById(labelId ?? "")?.textContent).toBe("Agent name");
  });

  it("explains an invalid name instead of advancing", () => {
    render(<OnboardingV2MockPage />);
    fireEvent.click(screen.getByRole("button", { name: /Local computer/ }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(screen.getByRole("button", { name: /Codex/ }));
    fireEvent.change(screen.getByLabelText("Agent name"), { target: { value: "Open Tag" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    const error = document.querySelector('[data-ui="onboarding-v2-field-error"]') as HTMLElement;
    expect(error.textContent).toContain("lowercase letters");
    expect(error.dataset.empty).toBeUndefined();
    expect(screen.getByRole("heading", { name: "Create your agent" })).toBeTruthy();
  });

  it("reads heading, explanation, then control in both sections of the agent step", () => {
    render(<OnboardingV2MockPage />);
    fireEvent.click(screen.getByRole("button", { name: /Local computer/ }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    for (const section of document.querySelectorAll('[data-ui="onboarding-v2-field"], fieldset')) {
      const parts = [...section.children].map(
        (child) => (child as HTMLElement).dataset.ui ?? child.tagName.toLowerCase(),
      );
      const heading = parts.findIndex((part) => part === "onboarding-v2-field-label" || part === "legend");
      const hint = parts.indexOf("onboarding-v2-field-hint");
      const control = parts.findIndex(
        (part) => part === "onboarding-v2-field-control" || part === "onboarding-v2-choices",
      );
      expect(heading).toBeGreaterThanOrEqual(0);
      expect(hint).toBeGreaterThan(heading);
      expect(control).toBeGreaterThan(hint);
    }
  });

  it("holds the name error's line before there is an error to show", () => {
    render(<OnboardingV2MockPage />);
    fireEvent.click(screen.getByRole("button", { name: /Local computer/ }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    const error = document.querySelector('[data-ui="onboarding-v2-field-error"]') as HTMLElement;
    expect(error).toBeTruthy();
    expect(error.dataset.empty).toBe("true");
  });

  it("keeps the command's preamble with the command rather than in the page header", async () => {
    render(<OnboardingV2MockPage />);
    await reachConnectStep();
    expect(screen.getByText(/Your AI worker runs on your own computer/)).toBeTruthy();
    expect(screen.getByText("Your code and data never leave your machine.")).toBeTruthy();
    expect(screen.getByText("Run this in your terminal, or paste it to your agent.")).toBeTruthy();
    expect(screen.getByText("# Install the OpenTag CLI and connect this computer to OpenTag.")).toBeTruthy();
  });

  it("installs through the portable installer, which needs nothing already on the machine", async () => {
    render(<OnboardingV2MockPage />);
    await reachConnectStep();
    const command = screen.getByText(/opentag computer connect/).textContent ?? "";
    // No `npm`: that would require a working Node before OpenTag could be installed at all.
    expect(command).not.toContain("npm");
    expect(command).toContain("curl -fsSL https://download.opentag.build/releases/prod/install.sh | sh");
    // The shim is not on this shell's PATH yet, so the connect call has to name its directory.
    expect(command).toMatch(
      /PATH="\$HOME\/\.local\/bin\S* opentag computer connect --server \S+ -- [A-Za-z0-9_-]{32}$/,
    );
  });

  it("copies the comment together with the command", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    render(<OnboardingV2MockPage />);
    await reachConnectStep();

    fireEvent.click(screen.getAllByRole("button", { name: /Copy/ })[0] as HTMLElement);
    await act(async () => undefined);
    const payload = writeText.mock.calls[0]?.[0] as string;
    expect(payload.startsWith("# Install the OpenTag CLI")).toBe(true);
    expect(payload).toContain("install.sh | sh");
    await advance(1_600);
    expect(screen.getAllByRole("button", { name: /Copy/ })[0]).toBeTruthy();
  });

  it("falls back to selecting the command when clipboard access fails", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("clipboard unavailable"));
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    render(
      <CommandBlock
        command="opentag computer connect --code abc"
        comment="# Connect this computer"
        copyLabel="Copy command"
        copiedLabel="Copied"
        fallbackHint="Select the command and copy it manually."
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Copy command" }));
    await act(async () => undefined);
    expect(screen.getByRole("status").textContent).toBe("Select the command and copy it manually.");
    expect(writeText).toHaveBeenCalledWith("# Connect this computer\nopentag computer connect --code abc");
  });

  it("counts the command's validity down and offers a fresh one once it expires", async () => {
    render(<OnboardingV2MockPage />);
    await reachConnectStep();
    expect(screen.getByText("Expires in 15:00")).toBeTruthy();

    openLab();
    fireEvent.click(screen.getByRole("button", { name: "Expire code" }));
    expect(screen.getByText("This command has expired.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Get a new command" }));
    await advance(ISSUE_MS);
    expect(screen.getByText("Expires in 15:00")).toBeTruthy();
  });

  it("reports a clean environment and offers to create the Agent", async () => {
    render(<OnboardingV2MockPage />);
    await reachConnectStep();
    await reachCheckStep();
    await settleCheck();

    expect(screen.getByText("Codex CLI is installed")).toBeTruthy();
    // The messaging CLI is not checked here: no provider has been chosen yet.
    expect(screen.queryByText("lark-cli is installed")).toBeNull();
    expect(screen.getByText("Everything your agent needs is ready.")).toBeTruthy();
  });

  it("hands a failing check to the terminal rather than offering a retry button", async () => {
    render(<OnboardingV2MockPage />);
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
    render(<OnboardingV2MockPage />);
    chooseScenario("runtime-install");
    await reachConnectStep();
    await reachCheckStep();

    // Mid-probe: every row already has its detail line.
    const rowsWhileChecking = document.querySelectorAll(".ots-check");
    expect(rowsWhileChecking).toHaveLength(2);
    for (const row of rowsWhileChecking) {
      // One title and one detail line, always both, so a resolving row never changes height.
      const copy = row.querySelector("span:last-child");
      expect(copy?.children).toHaveLength(2);
    }

    await settleCheck();
    expect(document.querySelectorAll(".ots-check")).toHaveLength(2);
    for (const row of document.querySelectorAll(".ots-check")) {
      expect((row.textContent ?? "").trim().length).toBeGreaterThan(0);
    }
  });

  it("keeps the countdown's row while the command is still on screen", async () => {
    render(<OnboardingV2MockPage />);
    await reachConnectStep();
    expect(document.querySelector('[data-ui="onboarding-v2-command-lead"]')).toBeTruthy();
    expect(document.querySelector('[data-ui="onboarding-v2-expiry"]')).toBeTruthy();
    expect(document.querySelector('[data-ui="onboarding-v2-connect-status"]')).toBeTruthy();

    // Expiring empties the countdown but must not collapse the row it sits on.
    openLab();
    fireEvent.click(screen.getByRole("button", { name: "Expire code" }));
    expect(screen.queryByText(/Expires in/)).toBeNull();
    expect(document.querySelector('[data-ui="onboarding-v2-expiry"]')).toBeTruthy();
  });

  it("keeps the check step's outcome slot before and after the result lands", async () => {
    render(<OnboardingV2MockPage />);
    await reachConnectStep();
    await reachCheckStep();

    // Still probing: the slot already holds its waiting line, in the same shape step 3 uses.
    const slot = () => document.querySelector('[data-ui="onboarding-v2-check-outcome"]');
    expect(slot()?.textContent ?? "").toContain("Waiting for the computer check…");
    expect(slot()?.querySelector(".ots-pulse")).toBeTruthy();

    await settleCheck();
    expect(slot()).toBeTruthy();
    expect(slot()?.textContent).toContain("Everything your agent needs is ready.");
  });

  it("keeps Continue on every step, disabled until the step can be left", async () => {
    render(<OnboardingV2MockPage />);
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
    // The Computer is here but its check has not reported, so there is still nothing to leave for.
    expect(next().disabled).toBe(true);
    await settleCheck();
    expect(next().disabled).toBe(false);
  });

  it("counts the runtime failures in its summary", async () => {
    render(<OnboardingV2MockPage />);
    chooseScenario("both-failing");
    await reachConnectStep();
    await reachCheckStep();
    await settleCheck();
    // Only the runtime rows can fail here now; the messaging CLI is checked at handoff.
    expect(screen.getByText("One thing needs fixing before your agent can run.")).toBeTruthy();
  });

  it("turns green on its own after the terminal repair, with no page action", async () => {
    render(<OnboardingV2MockPage />);
    chooseScenario("runtime-install");
    await reachConnectStep();
    await reachCheckStep();
    await settleCheck();
    expect(screen.getByText("We can't find the Codex command on this computer.")).toBeTruthy();

    openLab();
    fireEvent.click(screen.getByRole("button", { name: "Ran doctor --fix" }));
    fireEvent.click(screen.getByRole("button", { name: "Mock controls" }));
    await settleCheck();
    expect((screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("creates the Agent only after a runnable route is proven, then asks for Feishu", async () => {
    render(<OnboardingV2MockPage />);
    await reachConnectStep();
    await reachCheckStep();
    await settleCheck();

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await advance(CREATE_MS);
    expect(screen.getByRole("heading", { name: "Connect your messaging app" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Feishu/ }));
    await advance(ISSUE_MS);
    await advanceMock("Scan QR code");
    await advanceMock("Confirm reachable");
    expect(screen.getByRole("heading", { name: "opentag is ready." })).toBeTruthy();
  });

  describe("the mock's advance control", () => {
    it("names the one thing the outside world would do next", async () => {
      render(<OnboardingV2MockPage />);
      await reachConnectStep();
      expect(screen.getByRole("button", { name: "Connect computer" })).toBeTruthy();

      await reachCheckStep();
      expect(screen.getByRole("button", { name: "Return check result" })).toBeTruthy();

      await settleCheck();
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
      await advance(CREATE_MS);
      fireEvent.click(screen.getByRole("button", { name: /Feishu/ }));
      await advance(ISSUE_MS);
      expect(screen.getByRole("button", { name: "Scan QR code" })).toBeTruthy();
    });

    it("has nothing to offer when nothing is waiting", () => {
      render(<OnboardingV2MockPage />);
      const control = screen.getByRole("button", { name: "Nothing waiting" }) as HTMLButtonElement;
      expect(control.disabled).toBe(true);
    });

    it("cannot bring a Computer in on an expired code", async () => {
      render(<OnboardingV2MockPage />);
      await reachConnectStep();
      openLab();
      fireEvent.click(screen.getByRole("button", { name: "Expire code" }));
      fireEvent.click(screen.getByRole("button", { name: "Mock controls" }));

      expect(screen.getByText("This command has expired.")).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Connect computer" })).toBeNull();
      expect((screen.getByRole("button", { name: "Nothing waiting" }) as HTMLButtonElement).disabled).toBe(true);
    });
  });

  describe("the messaging step", () => {
    async function reachMessagingStep() {
      await reachConnectStep();
      await reachCheckStep();
      await settleCheck();
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
      await advance(CREATE_MS);
    }

    it("asks which app before showing any connection, and offers no footer", async () => {
      render(<OnboardingV2MockPage />);
      await reachMessagingStep();

      // Slack leads.
      expect(
        [...document.querySelectorAll('[data-ui="onboarding-v2-choices"] [data-ui="onboarding-v2-card-title"]')].map(
          (n) => n.textContent,
        ),
      ).toEqual(["Slack", "Feishu"]);
      // The step is finished by scanning or installing, not by pressing anything on this page.
      expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Go back" })).toBeNull();
      // Nothing is issued, and nothing is waiting, until one is picked.
      expect(screen.queryByText("Waiting for you to scan…")).toBeNull();
      expect((screen.getByRole("button", { name: "Nothing waiting" }) as HTMLButtonElement).disabled).toBe(true);
    });

    it("brings up the Feishu code in place, without leaving the step", async () => {
      render(<OnboardingV2MockPage />);
      await reachMessagingStep();

      fireEvent.click(screen.getByRole("button", { name: /Feishu/ }));
      await advance(ISSUE_MS);
      expect(screen.getByRole("heading", { name: "Connect your messaging app" })).toBeTruthy();
      expect(screen.getByText("Waiting for you to scan…")).toBeTruthy();
      expect(screen.getByRole("button", { name: /Feishu/ }).getAttribute("aria-pressed")).toBe("true");
    });

    it("installs Slack by sending the user there and bringing them back", async () => {
      render(<OnboardingV2MockPage />);
      await reachMessagingStep();

      fireEvent.click(screen.getByRole("button", { name: /Slack/ }));
      await advance(ISSUE_MS);
      // Slack issues nothing up front: the user goes and installs the App.
      expect(screen.queryByText("Waiting for you to scan…")).toBeNull();
      expect(screen.getByText(/Install OpenTag in your Slack workspace/)).toBeTruthy();

      fireEvent.click(screen.getByRole("button", { name: "Add to Slack" }));
      expect(screen.getByText("Waiting for you to finish in Slack…")).toBeTruthy();

      await advanceMock("Return from Slack");
      await advanceMock("Confirm reachable");
      expect(screen.getByRole("heading", { name: "opentag is ready." })).toBeTruthy();
    });

    it("offers the same Slack install on the cloud route", async () => {
      render(<OnboardingV2MockPage />);
      openLab();
      fireEvent.click(screen.getByRole("button", { name: "Offer the cloud computer" }));
      fireEvent.click(screen.getByRole("button", { name: "Mock controls" }));
      fireEvent.click(screen.getByRole("button", { name: /Cloud computer/ }));
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
      fireEvent.click(screen.getByRole("button", { name: /OpenTag agent/ }));
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
      await advance(ALLOCATE_MS);
      await advance(CREATE_MS);

      fireEvent.click(screen.getByRole("button", { name: /Slack/ }));
      fireEvent.click(screen.getByRole("button", { name: "Add to Slack" }));
      await advanceMock("Return from Slack");
      await advanceMock("Confirm reachable");
      expect(screen.getByRole("heading", { name: "opentag is ready." })).toBeTruthy();
    });
  });

  describe("the cloud route", () => {
    /** Cloud is Coming soon in production; the panel is what makes its pages reviewable. */
    async function chooseCloud() {
      openLab();
      fireEvent.click(screen.getByRole("button", { name: "Offer the cloud computer" }));
      fireEvent.click(screen.getByRole("button", { name: "Mock controls" }));
      fireEvent.click(screen.getByRole("button", { name: /Cloud computer/ }));
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    }

    it("has its own two steps and never asks for a Computer", async () => {
      render(<OnboardingV2MockPage />);
      await chooseCloud();
      expect(screen.getByRole("heading", { name: "Create your cloud agent" })).toBeTruthy();
      expect(
        [...document.querySelectorAll('[data-ui="onboarding-v2-rail-label"]')].map((node) => node.textContent),
      ).toEqual(["Create agent", "Messaging app"]);
      expect(screen.queryByRole("heading", { name: "Connect your computer" })).toBeNull();
    });

    it("leads with OpenTag's own agent, on a row of its own", async () => {
      render(<OnboardingV2MockPage />);
      await chooseCloud();
      const runtimes = [...document.querySelectorAll('[data-ui="onboarding-v2-card-title"]')].map((n) => n.textContent);
      expect(runtimes.slice(0, 3)).toEqual(["OpenTag agent", "Claude Code", "Codex"]);
      expect(document.querySelector("[data-lead]")).toBeTruthy();
      expect(screen.getByText("More runtimes coming soon.")).toBeTruthy();
    });

    it("lists both token options for its own agent, with one already chosen and one barred", async () => {
      render(<OnboardingV2MockPage />);
      await chooseCloud();
      fireEvent.click(screen.getByRole("button", { name: /OpenTag agent/ }));

      const included = screen.getByRole("button", { name: /OpenTag Tokens/ }) as HTMLButtonElement;
      const ownPlan = screen.getByRole("button", { name: /Your own coding plan/ }) as HTMLButtonElement;
      expect(included.getAttribute("aria-pressed")).toBe("true");
      // There is no subscription of the user's to attach to OpenTag's own agent.
      expect(ownPlan.disabled).toBe(true);
      expect((screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement).disabled).toBe(false);
    });

    it("asks who pays once a coding agent is chosen", async () => {
      render(<OnboardingV2MockPage />);
      await chooseCloud();
      fireEvent.click(screen.getByRole("button", { name: /Claude Code/ }));

      expect(screen.getByRole("button", { name: /OpenTag Tokens/ })).toBeTruthy();
      expect(screen.getByRole("button", { name: /Your own coding plan/ })).toBeTruthy();
      // Nothing is chosen yet, so there is nothing to continue to.
      expect((screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement).disabled).toBe(true);

      fireEvent.click(screen.getByRole("button", { name: /OpenTag Tokens/ }));
      expect((screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement).disabled).toBe(false);
    });

    it("holds Continue until an own plan has actually been signed into", async () => {
      render(<OnboardingV2MockPage />);
      await chooseCloud();
      fireEvent.click(screen.getByRole("button", { name: /Claude Code/ }));
      fireEvent.click(screen.getByRole("button", { name: /Your own coding plan/ }));

      const next = () => screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement;
      expect(next().disabled).toBe(true);
      expect(screen.getByRole("heading", { name: "Sign in to Claude Code" })).toBeTruthy();

      fireEvent.click(screen.getByRole("button", { name: "Sign in to Claude Code" }));
      expect(screen.getByText("Waiting for you to approve it…")).toBeTruthy();
      expect(next().disabled).toBe(true);

      await advanceMock("Approve sign-in");
      expect(screen.getByText("Signed in to Claude Code.")).toBeTruthy();
      expect(next().disabled).toBe(false);
    });

    it("forgets a token choice when the runtime changes under it", async () => {
      render(<OnboardingV2MockPage />);
      await chooseCloud();
      fireEvent.click(screen.getByRole("button", { name: /Claude Code/ }));
      fireEvent.click(screen.getByRole("button", { name: /OpenTag Tokens/ }));
      expect((screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement).disabled).toBe(false);

      fireEvent.click(screen.getByRole("button", { name: /Codex/ }));
      expect((screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement).disabled).toBe(true);
    });

    it("connects a messaging app on its own step, like a local agent", async () => {
      render(<OnboardingV2MockPage />);
      await chooseCloud();
      fireEvent.click(screen.getByRole("button", { name: /OpenTag agent/ }));
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
      await advance(ALLOCATE_MS);
      await advance(CREATE_MS);

      expect(screen.getByRole("heading", { name: "Connect your messaging app" })).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: /Feishu/ }));
      await advance(ISSUE_MS);
      await advanceMock("Scan QR code");
      await advanceMock("Confirm reachable");
      expect(screen.getByRole("heading", { name: "opentag is ready." })).toBeTruthy();
    });

    it("never names the runtime OpenTag uses for its own agent", async () => {
      render(<OnboardingV2MockPage />);
      await chooseCloud();
      fireEvent.click(screen.getByRole("button", { name: /OpenTag agent/ }));
      // The Context Tree bars the internal runtime from product exposure, so it is never named.
      expect(document.body.textContent ?? "").not.toMatch(/\bPi\b/);
    });
  });

  describe("going back", () => {
    it("returns from the agent step to the destination, keeping the draft", () => {
      render(<OnboardingV2MockPage />);
      fireEvent.click(screen.getByRole("button", { name: /Local computer/ }));
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
      fireEvent.change(screen.getByLabelText("Agent name"), { target: { value: "helper" } });

      fireEvent.click(screen.getByRole("button", { name: "Go back" }));
      expect(screen.getByRole("heading", { name: "Where should your agent run?" })).toBeTruthy();

      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
      expect((screen.getByLabelText("Agent name") as HTMLInputElement).value).toBe("helper");
    });

    it("returns from the connect step to the agent step", async () => {
      render(<OnboardingV2MockPage />);
      await reachConnectStep();
      fireEvent.click(screen.getByRole("button", { name: "Go back" }));
      expect(screen.getByRole("heading", { name: "Create your agent" })).toBeTruthy();
    });

    it("keeps the Computer when returning to the computer step", async () => {
      render(<OnboardingV2MockPage />);
      await reachConnectStep();
      await reachCheckStep();
      await settleCheck();

      // Back to the agent step and forward again: the enrollment is durable, so it is still here.
      fireEvent.click(screen.getByRole("button", { name: "Go back" }));
      expect(screen.getByRole("heading", { name: "Create your agent" })).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
      await advance(ISSUE_MS);
      expect(screen.getByText("Your computer is connected.")).toBeTruthy();
      expect(screen.queryByText("Waiting for your computer…")).toBeNull();
    });

    it("has no way back once the Agent has been created", async () => {
      render(<OnboardingV2MockPage />);
      await reachConnectStep();
      await reachCheckStep();
      await settleCheck();
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
      await advance(CREATE_MS);
      expect(screen.queryByRole("button", { name: "Go back" })).toBeNull();
    });
  });

  it("cancels a creation still in flight when the flow is restarted", async () => {
    render(<OnboardingV2MockPage />);
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
    render(<OnboardingV2MockPage />);
    await reachConnectStep();
    fireEvent.click(screen.getByRole("button", { name: "Start over" }));
    expect(screen.getByRole("heading", { name: "Where should your agent run?" })).toBeTruthy();
  });
});
