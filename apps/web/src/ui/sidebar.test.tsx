import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Sidebar, SidebarProvider, SidebarTrigger } from "./design-system.js";

afterEach(() => vi.restoreAllMocks());

it("switches between desktop navigation and a dismissible mobile drawer without resetting page state", () => {
  let mobile = false;
  const matchMedia = window.matchMedia.bind(window);
  vi.spyOn(window, "matchMedia").mockImplementation((query) => ({
    ...matchMedia(query),
    matches: mobile && query === "(max-width: 767px)",
  }));

  function shell(collapsible: "none" | "icon") {
    return (
      <SidebarProvider collapsible={collapsible} defaultOpen mobileBreakpoint={768}>
        <Sidebar aria-label="Agent navigation" fullScreenOnMobile>
          <Sidebar.Close />
        </Sidebar>
        <SidebarTrigger aria-label="Open navigation" />
        <input aria-label="Draft" defaultValue="" />
      </SidebarProvider>
    );
  }

  const { container, rerender } = render(shell("none"));
  const navigation = () => container.querySelector('[data-sidebar="sidebar"]');
  const draft = screen.getByRole("textbox", { name: "Draft" });
  fireEvent.change(draft, { target: { value: "Keep this draft" } });
  expect(navigation()?.getAttribute("data-mobile")).toBeNull();

  // The provider's media subscription can update before AppShell supplies its new collapse mode.
  mobile = true;
  rerender(shell("none"));
  rerender(shell("icon"));
  expect(navigation()?.getAttribute("data-mobile")).toBe("true");
  expect(navigation()?.getAttribute("aria-hidden")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "Open navigation" }));
  expect(navigation()?.getAttribute("aria-hidden")).toBe("false");
  fireEvent.click(screen.getByRole("button", { name: "Close navigation" }));
  expect(navigation()?.getAttribute("aria-hidden")).toBe("true");

  mobile = false;
  rerender(shell("icon"));
  rerender(shell("none"));
  expect(navigation()?.getAttribute("data-mobile")).toBeNull();
  expect(navigation()?.getAttribute("data-collapsible")).toBeNull();
  expect(navigation()?.getAttribute("data-state")).toBe("expanded");
  expect(screen.getByRole("textbox", { name: "Draft" })).toBe(draft);
  expect((draft as HTMLInputElement).value).toBe("Keep this draft");
});
