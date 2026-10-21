import { fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { installFocusModality } from "./focus-modality.js";

const attribute = "data-opentag-input-modality";
let uninstall = () => {};
afterEach(() => uninstall());

describe("shared control focus modality", () => {
  it("keeps pointer editing light until Tab navigation resumes", () => {
    uninstall = installFocusModality(document);
    expect(document.documentElement.getAttribute(attribute)).toBe("keyboard");
    fireEvent.pointerDown(document.body);
    expect(document.documentElement.getAttribute(attribute)).toBe("pointer");
    for (const key of ["a", " ", "Enter"]) fireEvent.keyDown(document.body, { key });
    expect(document.documentElement.getAttribute(attribute)).toBe("pointer");
    fireEvent.keyDown(document.body, { key: "Tab", shiftKey: true });
    expect(document.documentElement.getAttribute(attribute)).toBe("keyboard");
    fireEvent.pointerDown(document.body);
    expect(document.documentElement.getAttribute(attribute)).toBe("pointer");
  });

  it("captures pointer input in body-mounted popups even when propagation stops", () => {
    uninstall = installFocusModality(document);
    const popup = document.createElement("div");
    popup.addEventListener("pointerdown", (event) => event.stopPropagation());
    document.body.append(popup);
    try {
      fireEvent.pointerDown(popup);
      expect(document.documentElement.getAttribute(attribute)).toBe("pointer");
    } finally {
      popup.remove();
    }
  });

  it("restores the prior document state and removes both listeners on unmount", () => {
    const prior = document.documentElement.getAttribute(attribute);
    document.documentElement.setAttribute(attribute, "pointer");
    const cleanup = installFocusModality(document);
    cleanup();
    expect(document.documentElement.getAttribute(attribute)).toBe("pointer");
    fireEvent.keyDown(document.body, { key: "Tab" });
    expect(document.documentElement.getAttribute(attribute)).toBe("pointer");
    document.documentElement.setAttribute(attribute, "keyboard");
    fireEvent.pointerDown(document.body);
    expect(document.documentElement.getAttribute(attribute)).toBe("keyboard");
    if (prior === null) document.documentElement.removeAttribute(attribute);
    else document.documentElement.setAttribute(attribute, prior);
  });
});
