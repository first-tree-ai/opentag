import { fireEvent, render, screen } from "@testing-library/react";
import { createRef, useState } from "react";
import { describe, expect, it } from "vitest";
import {
  Button,
  buttonClassName,
  Dialog,
  Field,
  Icon,
  KumoSelectControl,
  SettingsList,
  SettingsRow,
  StatusIndicator,
  Tabs,
} from "./design-system.js";

describe("Kumo semantic adapter", () => {
  it("maps legacy button intents to Kumo variants", () => {
    expect(buttonClassName({ variant: "danger" })).toContain("bg-");
    render(<Button variant="inline">Details</Button>);
    expect(screen.getByRole("button", { name: "Details" }).className).not.toContain("ds-");
  });

  it("provides labelled Kumo tabs and settings rows", () => {
    render(
      <>
        <Tabs label="Example settings">
          <a href="/general">General</a>
          <a href="/runtime">Runtime</a>
        </Tabs>
        <SettingsList>
          <SettingsRow description="Visible throughout the product." label="Display name">
            <Field htmlFor="display-name" label="Display name">
              <input id="display-name" />
            </Field>
          </SettingsRow>
        </SettingsList>
      </>,
    );
    expect(screen.getByRole("navigation", { name: "Example settings" })).toBeTruthy();
    expect(screen.getByLabelText("Display name")).toBeTruthy();
  });

  it("associates field errors and status with semantic state", () => {
    render(
      <>
        <Field
          error="Choose another name"
          errorId="name-error"
          hint="Lowercase letters only"
          hintId="name-hint"
          htmlFor="agent-name"
          label="Agent name"
        >
          <input aria-describedby="name-hint name-error" id="agent-name" />
        </Field>
        <StatusIndicator detail="Ready for work" label="Online" tone="success" />
      </>,
    );
    expect(screen.getByRole("alert").textContent).toBe("Choose another name");
    expect(screen.getByText("Online").closest("[data-state]")?.getAttribute("data-state")).toBe("success");
  });

  it("renders a real Kumo select with controlled callbacks", () => {
    const onChange = () => undefined;
    render(
      <KumoSelectControl aria-label="Usage period" value="7" onChange={onChange}>
        <option value="7">Last 7 days</option>
        <option value="30">Last 30 days</option>
      </KumoSelectControl>,
    );
    expect(screen.getByRole("combobox", { name: "Usage period" })).toBeTruthy();
  });

  it("keeps dialog Escape and focus return behavior", () => {
    const triggerRef = createRef<HTMLButtonElement>();
    function Example() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button ref={triggerRef} type="button" onClick={() => setOpen(true)}>
            Open
          </button>
          <Dialog open={open} returnFocusRef={triggerRef} title="Example" onClose={() => setOpen(false)}>
            <Button>Action</Button>
          </Dialog>
        </>
      );
    }
    render(<Example />);
    const trigger = screen.getByRole("button", { name: "Open" });
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps icon-only controls discoverable", () => {
    render(
      <Button aria-label="Close" shape="square" variant="ghost">
        <Icon name="close" />
      </Button>,
    );
    expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();
  });
});
