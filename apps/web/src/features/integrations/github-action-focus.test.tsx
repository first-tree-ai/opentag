import { act, fireEvent, render, screen } from "@testing-library/react";
import { useLayoutEffect, useRef, useState } from "react";
import { expect, it } from "vitest";
import { useGitHubActionFocus } from "./github-action-focus.js";

it("retains focus captured by an action before the previous commit's passive effects settle", async () => {
  let complete!: () => void;
  const pending = new Promise<void>((resolve) => {
    complete = resolve;
  });
  function CommitAction() {
    const [busy, setBusy] = useState(false);
    const [done, setDone] = useState(false);
    const retry = useRef<HTMLButtonElement>(null);
    const { resultRef, captureFocus } = useGitHubActionFocus(busy);
    useLayoutEffect(() => {
      retry.current?.focus();
      retry.current?.click();
    }, []);
    return (
      <>
        {!done ? (
          <button
            ref={retry}
            type="button"
            onClick={() => {
              captureFocus();
              setBusy(true);
              void pending.then(() => {
                setDone(true);
                setBusy(false);
              });
            }}
          >
            Retry
          </button>
        ) : null}
        <p role="status" tabIndex={-1} ref={resultRef}>
          {done ? "Loaded" : ""}
        </p>
      </>
    );
  }
  render(<CommitAction />);
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Retry" }));
  await act(async () => complete());
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole("status"));
});

it("restores focus when React batches an immediate action without a busy commit", () => {
  function ImmediateAction() {
    const [busy, setBusy] = useState(false);
    const [done, setDone] = useState(false);
    const { resultRef, captureFocus } = useGitHubActionFocus(busy);
    return (
      <>
        {!done ? (
          <button
            type="button"
            onClick={() => {
              captureFocus();
              setBusy(true);
              setDone(true);
              setBusy(false);
            }}
          >
            Retry
          </button>
        ) : null}
        <p role="status" tabIndex={-1} ref={resultRef}>
          {done ? "Loaded" : ""}
        </p>
      </>
    );
  }
  render(<ImmediateAction />);
  const retry = screen.getByRole("button", { name: "Retry" });
  retry.focus();
  fireEvent.click(retry);
  expect(document.activeElement).toBe(screen.getByRole("status"));
});
