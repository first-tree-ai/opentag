import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { expect, it } from "vitest";
import { useGitHubActionFocus } from "./github-action-focus.js";

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
