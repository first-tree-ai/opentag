import { fireEvent, render, screen } from "@testing-library/react";
import { createRef, useState } from "react";
import { describe, expect, it } from "vitest";
import { Button, buttonClassName, Dialog, Field, Icon, StatusIndicator } from "./design-system.js";

describe("design system primitives", () => {
  it("maps button intent to an explicit visual variant", () => {
    render(<Button variant="secondary">Cancel</Button>);
    expect(screen.getByRole("button", { name: "Cancel" }).className).toContain("ds-button--secondary");
  });

  it("exposes the Viktor-aligned button hierarchy without a separate save color", () => {
    render(
      <>
        <Button variant="outline">Review</Button>
        <Button variant="ghost">Dismiss</Button>
        <Button variant="inline">Details</Button>
      </>,
    );
    expect(screen.getByRole("button", { name: "Review" }).className).toContain("ds-button--outline");
    expect(screen.getByRole("button", { name: "Dismiss" }).className).toContain("ds-button--ghost");
    expect(screen.getByRole("button", { name: "Details" }).className).toContain("ds-button--inline");
  });

  it("shares button styling with semantic links", () => {
    render(
      <a className={buttonClassName({ variant: "secondary" })} href="/continue">
        Continue
      </a>,
    );
    expect(screen.getByText("Continue").className).toContain("ds-button--secondary");
  });

  it("keeps field labels, help and errors associated with the control", () => {
    render(
      <Field
        error="Choose another name"
        errorId="name-error"
        hint="Lowercase letters only"
        hintId="name-hint"
        htmlFor="agent-name"
        label="Agent name"
      >
        <input aria-describedby="name-hint name-error" id="agent-name" />
      </Field>,
    );
    expect(screen.getByLabelText("Agent name")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBe("Choose another name");
  });

  it("keeps operational status independent from brand styling", () => {
    render(<StatusIndicator detail="Ready for work" label="Online" tone="success" />);
    expect(screen.getByText("Online").closest(".ds-status")?.className).toContain("ds-status--success");
    expect(screen.getByText("Ready for work")).toBeTruthy();
  });

  it("provides consistent vector icons", () => {
    const { container } = render(<Icon name="check" />);
    expect(container.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    expect(container.querySelector("path")).toBeTruthy();
  });

  it("closes dialogs on Escape and returns focus", () => {
    const triggerRef = createRef<HTMLButtonElement>();
    function Example() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button ref={triggerRef} type="button" onClick={() => setOpen(true)}>
            Open
          </button>
          {open ? (
            <Dialog returnFocusRef={triggerRef} title="Example" onClose={() => setOpen(false)}>
              <button type="button">Action</button>
            </Dialog>
          ) : null}
        </>
      );
    }
    render(<Example />);
    const trigger = screen.getByRole("button", { name: "Open" });
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
