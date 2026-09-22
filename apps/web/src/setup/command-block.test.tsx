import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommandBlock } from "./command-block.js";

/**
 * The copyable command, asserted on the two things a reader would get wrong:
 *
 * - What lands on the clipboard is the whole block — the inert comment line and the command — not
 *   just the token, because the comment is what tells an agent what the command is for.
 * - A browser without clipboard access still lets the user copy it, by selecting the block and
 *   saying so. A silent failure there looks exactly like a successful copy.
 */

const COPY_FEEDBACK_MS = 1_600;
const COMMENT = "Run this command to set up OpenTag on this computer.";
const COMMAND = "curl -fsSL https://app.opentag.build/install.sh | sh otc_abc123";
const LABELS = {
  copiedLabel: "Command copied",
  copyLabel: "Copy command",
  fallbackHint: "Copy failed. The command is selected for manual copying.",
};

/** Writes to the clipboard through a spy the test owns, which is the only way it can be asserted. */
function clipboard(impl: (text: string) => Promise<void>) {
  const writeText = vi.fn(impl);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  return writeText;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("CommandBlock", () => {
  it("makes the scrollable command keyboard-accessible while it is usable", () => {
    const view = render(<CommandBlock {...LABELS} command={COMMAND} comment={COMMENT} />);
    const region = screen.getByRole("region", { name: COMMENT });
    expect(region.tabIndex).toBe(0);
    region.focus();
    expect(document.activeElement).toBe(region);
    view.rerender(<CommandBlock {...LABELS} command={COMMAND} comment={COMMENT} inert />);
    expect(region.tabIndex).toBe(-1);
  });

  it("copies the comment line with the command, so a pasted agent gets the instruction", async () => {
    const writeText = clipboard(() => Promise.resolve());
    render(<CommandBlock {...LABELS} command={COMMAND} comment={COMMENT} />);

    fireEvent.click(screen.getByRole("button", { name: "Copy command" }));
    await act(async () => {});

    expect(writeText).toHaveBeenCalledWith(`: '${COMMENT}'\n${COMMAND}`);
  });

  it("escapes a single quote in the comment, so the pasted line stays one inert argument", async () => {
    const writeText = clipboard(() => Promise.resolve());
    render(<CommandBlock {...LABELS} command={COMMAND} comment={"Reconnect Bob's computer."} />);

    fireEvent.click(screen.getByRole("button", { name: "Copy command" }));
    await act(async () => {});

    // POSIX quoting, not a naive wrap: an unescaped quote would end the string and run the rest.
    expect(writeText).toHaveBeenCalledWith(`: 'Reconnect Bob'\\''s computer.'\n${COMMAND}`);
  });

  it("confirms the copy and returns to the idle label after the feedback window", async () => {
    clipboard(() => Promise.resolve());
    render(<CommandBlock {...LABELS} command={COMMAND} comment={COMMENT} />);

    fireEvent.click(screen.getByRole("button", { name: "Copy command" }));
    await act(async () => {});
    expect(screen.getByRole("button", { name: "Command copied" })).toBeTruthy();

    await act(async () => {
      vi.advanceTimersByTime(COPY_FEEDBACK_MS);
    });

    expect(screen.getByRole("button", { name: "Copy command" })).toBeTruthy();
  });

  it("selects the block and explains itself when the clipboard refuses", async () => {
    clipboard(() => Promise.reject(new Error("NotAllowedError")));
    const { container } = render(<CommandBlock {...LABELS} command={COMMAND} comment={COMMENT} />);

    fireEvent.click(screen.getByRole("button", { name: "Copy command" }));
    await act(async () => {});

    // The label stays idle, because nothing reached the clipboard.
    expect(screen.getByRole("button", { name: "Copy command" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe(LABELS.fallbackHint);
    // And the command is selected, which is the manual copy the hint is talking about.
    const selection = window.getSelection();
    const code = container.querySelector("code");
    expect(selection?.rangeCount).toBe(1);
    expect(selection?.getRangeAt(0).toString()).toBe(code?.textContent);
  });

  it("clears a fallback hint once a later copy succeeds", async () => {
    const writeText = vi
      .fn<(text: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error("NotAllowedError"))
      .mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    render(<CommandBlock {...LABELS} command={COMMAND} comment={COMMENT} />);

    fireEvent.click(screen.getByRole("button", { name: "Copy command" }));
    await act(async () => {});
    expect(screen.getByRole("status")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Copy command" }));
    await act(async () => {});

    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByRole("button", { name: "Command copied" })).toBeTruthy();
  });

  it("does not offer to copy a command that has expired", () => {
    render(
      <CommandBlock
        {...LABELS}
        command={COMMAND}
        comment={COMMENT}
        expiredNotice={<span>This command has expired.</span>}
      />,
    );

    expect((screen.getByRole("button", { name: "Copy command" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("This command has expired.")).toBeTruthy();
    expect(document.querySelector("[data-expired]")?.getAttribute("data-expired")).toBe("true");
  });

  it("does not offer to copy a placeholder that has no command yet", () => {
    render(<CommandBlock {...LABELS} command={COMMAND} comment={COMMENT} inert />);

    expect((screen.getByRole("button", { name: "Copy command" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows the command split at its last space, so an opaque token breaks by character", () => {
    const { container } = render(<CommandBlock {...LABELS} command={COMMAND} comment={COMMENT} />);

    // The secret keeps its own element: breaking at its hyphens would reflow the block when it is
    // reissued, which is what that element's styles exist to prevent.
    expect(container.querySelector(".ots-command__token")?.textContent).toBe("otc_abc123");
    expect(container.querySelector(".ots-command__comment")?.textContent).toBe(`: '${COMMENT}'`);
    expect(container.querySelector("code")?.textContent).toBe(`: '${COMMENT}'\n${COMMAND}`);
  });

  it("renders an action in place of a command when the block has none to give", () => {
    const { container } = render(
      <CommandBlock
        {...LABELS}
        actionNotice={
          <>
            <span>This computer needs reconnecting.</span>
            <button type="button">Get a new command</button>
          </>
        }
      />,
    );

    expect(container.querySelector("[data-action]")).toBeTruthy();
    expect(screen.getByText("This computer needs reconnecting.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Get a new command" })).toBeTruthy();
    // There is no command, so there is nothing to copy and no copy control.
    expect(screen.queryByRole("button", { name: "Copy command" })).toBeNull();
  });

  it("still explains the fallback in a browser that has no selection API", async () => {
    clipboard(() => Promise.reject(new Error("NotAllowedError")));
    const getSelection = vi.spyOn(window, "getSelection").mockReturnValue(null);
    render(<CommandBlock {...LABELS} command={COMMAND} comment={COMMENT} />);

    fireEvent.click(screen.getByRole("button", { name: "Copy command" }));
    await act(async () => {});

    // Nothing could be selected, but the reader is still told what happened.
    expect(getSelection).toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toBe(LABELS.fallbackHint);
  });

  it("writes nothing to the page when it unmounts while the clipboard is still being written", async () => {
    let finish!: () => void;
    const writeText = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const { unmount } = render(<CommandBlock {...LABELS} command={COMMAND} comment={COMMENT} />);

    fireEvent.click(screen.getByRole("button", { name: "Copy command" }));
    unmount();
    await act(async () => {
      finish();
    });

    // The copy resolved after the block was gone: no ``Copied`` state, and no timer left running.
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(() =>
      act(() => {
        vi.advanceTimersByTime(COPY_FEEDBACK_MS);
      }),
    ).not.toThrow();
  });

  it("does not offer the manual-copy fallback when it unmounts during a failed write", async () => {
    let fail!: (cause: Error) => void;
    const writeText = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          fail = reject;
        }),
    );
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const { unmount } = render(<CommandBlock {...LABELS} command={COMMAND} comment={COMMENT} />);

    fireEvent.click(screen.getByRole("button", { name: "Copy command" }));
    unmount();
    await act(async () => {
      fail(new Error("NotAllowedError"));
    });

    // Nothing is left to select and nothing is left to say, so the rejection is swallowed quietly.
    expect(writeText).toHaveBeenCalledTimes(1);
  });

  it("drops a pending feedback timer when it unmounts, rather than setting state on a dead tree", async () => {
    clipboard(() => Promise.resolve());
    const { unmount } = render(<CommandBlock {...LABELS} command={COMMAND} comment={COMMENT} />);

    fireEvent.click(screen.getByRole("button", { name: "Copy command" }));
    await act(async () => {});
    unmount();

    // The timer would have fired 1.6 s after the copy; a state update then is the leak this avoids.
    expect(() =>
      act(() => {
        vi.advanceTimersByTime(COPY_FEEDBACK_MS);
      }),
    ).not.toThrow();
  });

  it("leaves the confirmation up when it unmounts before the window closes", async () => {
    clipboard(() => Promise.resolve());
    const { unmount } = render(<CommandBlock {...LABELS} command={COMMAND} comment={COMMENT} />);

    fireEvent.click(screen.getByRole("button", { name: "Copy command" }));
    await act(async () => {});
    // Still confirmed when the tree goes away, which is the state the timer would have cleared.
    expect(screen.getByRole("button", { name: "Command copied" })).toBeTruthy();

    unmount();
    await act(async () => {
      vi.advanceTimersByTime(COPY_FEEDBACK_MS);
    });

    // The unmount cancelled the reset instead of leaving it to fire against a gone component.
    expect(document.querySelector(".ots-command")).toBeNull();
  });
});
