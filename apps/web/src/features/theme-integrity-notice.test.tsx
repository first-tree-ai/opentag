import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installApi, resetWebAppState } from "../__tests__/support/app-fixtures.js";
import { App } from "../app.js";
import { ThemeIntegrityNotice } from "./theme-integrity-notice.js";

const root = () => document.documentElement;

/** MutationObserver batches are delivered asynchronously; give one task turn before asserting. */
async function flushMutations() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

afterEach(() => vi.restoreAllMocks());

describe("ThemeIntegrityNotice", () => {
  it("stays silent on a clean document, same-value writes, and unrelated mutations", async () => {
    render(<ThemeIntegrityNotice />);
    expect(screen.queryByRole("status")).toBeNull();

    await act(async () => {
      // Unrelated attributes, classes, and same-value writes of the watched attributes.
      root().setAttribute("lang", "zh");
      root().setAttribute("class", "embedded");
      root().setAttribute("data-ui", "outside");
      root().setAttribute("data-opentag-theme", "opentag");
      root().setAttribute("data-opentag-mode", "light");
    });
    await flushMutations();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("reports drift that already happened before the mount without rewriting it", () => {
    root().setAttribute("data-theme", "light");
    render(<ThemeIntegrityNotice />);
    expect(screen.getByRole("status").textContent).toContain("Page appearance settings changed");
    // The detector only reads: the root keeps exactly the values outside code left behind.
    expect(root().getAttribute("data-theme")).toBe("light");
    expect(root().getAttribute("data-opentag-theme")).toBe("opentag");
    expect(root().getAttribute("data-opentag-mode")).toBe("light");
  });

  it("reports a missing OpenTag theme identity before the mount", () => {
    root().removeAttribute("data-opentag-theme");
    render(<ThemeIntegrityNotice />);
    expect(screen.getByRole("status").textContent).toContain("Page appearance settings changed");
  });

  it.each([
    ["data-theme", "light"],
    ["data-mode", "dark"],
    ["data-opentag-theme", "light"],
    ["data-opentag-mode", "dark"],
  ])("reports a later write to %s", async (attribute, value) => {
    render(<ThemeIntegrityNotice />);
    await act(async () => {
      root().setAttribute(attribute, value);
    });
    expect((await screen.findByRole("status")).textContent).toContain("Page appearance settings changed");
  });

  it("reports a change that was restored inside the same mutation batch", async () => {
    render(<ThemeIntegrityNotice />);
    await act(async () => {
      root().setAttribute("data-theme", "light");
      root().removeAttribute("data-theme");
    });
    expect((await screen.findByRole("status")).textContent).toContain("Page appearance settings changed");
  });

  it("reports a restored own-theme write without rewriting any root attribute itself", async () => {
    render(<ThemeIntegrityNotice />);
    await act(async () => {
      root().setAttribute("data-opentag-theme", "light");
      root().setAttribute("data-opentag-theme", "opentag");
    });
    await screen.findByRole("status");
    // The restored value is the one outside code left behind, not something the detector wrote.
    expect(root().getAttribute("data-opentag-theme")).toBe("opentag");
    expect(root().getAttribute("data-opentag-mode")).toBe("light");
    expect(root().getAttribute("data-theme")).toBeNull();
  });

  it("hides on dismissal and does not warn again on this mount", async () => {
    root().setAttribute("data-theme", "light");
    render(<ThemeIntegrityNotice />);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("status")).toBeNull();

    await act(async () => {
      root().setAttribute("data-mode", "dark");
    });
    await flushMutations();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("announces politely from a local light-theme wrapper", () => {
    root().setAttribute("data-theme", "light");
    render(<ThemeIntegrityNotice />);
    const notice = screen.getByRole("status");
    const wrapper = notice.closest('[data-ui="theme-integrity-notice"]') as HTMLElement;
    expect(wrapper).toBeTruthy();
    expect(wrapper.getAttribute("data-opentag-theme")).toBe("opentag");
    expect(wrapper.getAttribute("data-opentag-mode")).toBe("light");
  });

  it("disconnects on unmount and mounts cleanly under StrictMode", async () => {
    const disconnect = vi.spyOn(MutationObserver.prototype, "disconnect");
    const { unmount } = render(
      <StrictMode>
        <ThemeIntegrityNotice />
      </StrictMode>,
    );
    await act(async () => {
      root().setAttribute("data-theme", "light");
    });
    // Exactly one notice even though StrictMode runs the effect twice.
    expect(screen.getAllByRole("status")).toHaveLength(1);
    unmount();
    // The StrictMode remount cleanup and the final unmount both disconnect.
    expect(disconnect).toHaveBeenCalled();
    await act(async () => {
      root().setAttribute("data-mode", "dark");
    });
    await flushMutations();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("surfaces through the App above the route content and keeps dismissal across navigation", async () => {
    installApi();
    resetWebAppState();
    root().setAttribute("data-theme", "light");
    render(<App />);

    // The App renders other polite live regions (for example the route loader), so the notice is
    // located through its own wrapper.
    const noticeWrapper = await screen.findByText("Page appearance settings changed").then((title) => {
      const wrapper = title.closest('[data-ui="theme-integrity-notice"]');
      if (!wrapper) throw new Error("notice wrapper missing");
      return wrapper as HTMLElement;
    });
    const notice = within(noticeWrapper).getByRole("status");
    const main = await screen.findByRole("main");
    expect(notice.compareDocumentPosition(main) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.click(within(noticeWrapper).getByRole("button", { name: "Close" }));
    expect(document.querySelector('[data-ui="theme-integrity-notice"]')).toBeNull();

    fireEvent.click(await screen.findByRole("link", { name: "Open Reviewer" }));
    await screen.findByRole("heading", { name: "Reviewer" });
    expect(document.querySelector('[data-ui="theme-integrity-notice"]')).toBeNull();
  });
});
