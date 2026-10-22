import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "../../../ui/design-system.js";
import { OverflowFilter } from "./overflow-filter.js";

const items = [
  { value: "", label: "All" },
  { value: "knowledge", label: "Knowledge" },
  { value: "communication", label: "Communication" },
  { value: "development", label: "Developer Tools" },
  { value: "design", label: "Design" },
];
const widths = new Map([
  ["All", 48],
  ["Knowledge", 120],
  ["Communication", 130],
  ["Developer Tools", 160],
  ["Design", 70],
  ["More", 90],
  ["Additional categories", 220],
]);
const originalObserver = globalThis.ResizeObserver;
const observers = new Set<() => void>();
let availableWidth = 400;

function Example({
  disabled = false,
  initial = "",
  moreLabel = "More",
}: {
  disabled?: boolean;
  initial?: string | null;
  moreLabel?: string;
}) {
  const [value, setValue] = useState(initial);
  return (
    <TooltipProvider>
      <OverflowFilter
        disabled={disabled}
        items={items}
        label="Categories"
        moreLabel={moreLabel}
        value={value}
        onValueChange={setValue}
      />
    </TooltipProvider>
  );
}

function labels() {
  return within(screen.getByRole("group", { name: "Categories" }))
    .getAllByRole("button")
    .map((button) => button.textContent);
}

function resize(width: number) {
  availableWidth = width;
  act(() => {
    for (const observe of [...observers]) observe();
  });
}

beforeEach(() => {
  availableWidth = 400;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private callback: () => void) {
        observers.add(callback);
      }
      observe() {}
      disconnect() {
        observers.delete(this.callback);
      }
    },
  );
  const getStyle = window.getComputedStyle;
  vi.spyOn(window, "getComputedStyle").mockImplementation((element) => {
    const style = getStyle(element);
    if (element.classList.contains("gap-2")) Object.defineProperty(style, "columnGap", { value: "8px" });
    return style;
  });
  const getRect = Element.prototype.getBoundingClientRect;
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    if (this.parentElement?.matches('[data-ui="overflow-filter"]')) return new DOMRect(0, 0, availableWidth, 32);
    if (this.closest('[data-ui="overflow-filter-measures"]')) {
      const width = this.tagName.toLowerCase() === "svg" ? 16 : (widths.get(this.textContent ?? "") ?? 0);
      return new DOMRect(0, 0, width, 32);
    }
    return getRect.call(this);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.stubGlobal("ResizeObserver", originalObserver);
  observers.clear();
});

describe("OverflowFilter", () => {
  it("remeasures a longer translated menu label without changing category order", async () => {
    const view = render(<Example />);
    expect(labels()).toEqual(["All", "Knowledge", "More"]);
    view.rerender(<Example moreLabel="Additional categories" />);
    // Model the intrinsic-width notification that a browser sends for the translated measurement row.
    resize(400);
    expect(labels()).toEqual(["All", "Additional categories"]);
    fireEvent.click(screen.getByRole("button", { name: "Additional categories" }));
    expect((await screen.findAllByRole("menuitemradio")).map((item) => item.textContent)).toEqual([
      "Knowledge",
      "Communication",
      "Developer Tools",
      "Design",
    ]);
  });
  it("keeps the visible prefix and menu in the supplied order", async () => {
    render(<Example />);
    expect(labels()).toEqual(["All", "Knowledge", "More"]);
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    expect((await screen.findAllByRole("menuitemradio")).map((item) => item.textContent)).toEqual([
      "Communication",
      "Developer Tools",
      "Design",
    ]);
  });

  it("shows an overflow selection without moving the visible categories", async () => {
    render(<Example />);
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "Developer Tools" }));
    await waitFor(() => expect(labels()).toEqual(["All", "Knowledge", "Developer Tools"]));
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(screen.getByRole("button", { name: "Developer Tools" }).getAttribute("data-selected")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Developer Tools" }));
    expect((await screen.findByRole("menuitemradio", { name: "Developer Tools" })).getAttribute("aria-checked")).toBe(
      "true",
    );
  });

  it("recalculates on resize and preserves selection when every category fits", async () => {
    render(<Example initial="development" />);
    expect(labels()).toEqual(["All", "Knowledge", "Developer Tools"]);
    resize(1000);
    expect(labels()).toEqual(items.map((item) => item.label));
    expect(screen.getByRole("button", { name: "Developer Tools" }).getAttribute("aria-pressed")).toBe("true");
    resize(400);
    expect(labels()).toEqual(["All", "Knowledge", "Developer Tools"]);
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    expect(labels()).toEqual(["All", "Knowledge", "More"]);
  });

  it("uses only More when the container cannot fit the first category and trigger", () => {
    availableWidth = 180;
    render(<Example initial="development" />);
    expect(labels()).toEqual(["Developer Tools"]);
  });

  it("does not imply an All selection while a separate search is active", () => {
    render(<Example initial={null} />);
    expect(screen.getByRole("button", { name: "All" }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("button", { name: "More" }).getAttribute("data-selected")).toBe("false");
  });

  it("disables direct choices and closes the menu when the owning action becomes busy", async () => {
    const view = render(<Example />);
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    await screen.findByRole("menu");
    view.rerender(<Example disabled />);
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    for (const button of within(screen.getByRole("group", { name: "Categories" })).getAllByRole("button")) {
      expect(button.hasAttribute("disabled")).toBe(true);
    }
    view.rerender(<Example />);
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    await screen.findByRole("menu");
  });
});
