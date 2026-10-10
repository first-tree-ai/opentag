import { fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SoulEditor } from "./soul-editor.js";

const observers = new Set<LayoutObserver>();
const originalObserver = globalThis.ResizeObserver;
class LayoutObserver {
  readonly elements = new Set<Element>();
  constructor(readonly callback: ResizeObserverCallback) {
    observers.add(this);
  }
  observe(element: Element) {
    this.elements.add(element);
  }
  unobserve(element: Element) {
    this.elements.delete(element);
  }
  disconnect() {
    observers.delete(this);
  }
  flush() {
    this.callback(
      [...this.elements].map((target) => ({ target }) as ResizeObserverEntry),
      this,
    );
  }
}

function EditorWithActions({ value }: { value: string }) {
  const footer = useRef<HTMLDivElement>(null);
  return (
    <main>
      <SoulEditor disabled={false} footerRef={footer} id="soul" value={value} onValueChange={() => undefined} />
      <div data-testid="soul-footer" ref={footer}>
        Apply changes
      </div>
    </main>
  );
}

describe("Soul editor height", () => {
  let styles: HTMLStyleElement;
  const originalHeight = Object.getOwnPropertyDescriptor(window, "innerHeight");
  beforeEach(() => {
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 900 });
    styles = document.createElement("style");
    styles.textContent =
      "textarea {font-size:14px;line-height:22.75px;padding:20px;border:1px solid} main {padding:32px}";
    document.head.append(styles);
    globalThis.ResizeObserver = LayoutObserver;
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      const element = this as HTMLElement;
      const top = element.tagName === "TEXTAREA" ? 120 : 0;
      const height =
        element.tagName === "MAIN"
          ? window.innerHeight
          : element.dataset.testid === "soul-footer"
            ? 104
            : Number.parseFloat(element.style.height) || 0;
      return { x: 0, y: top, top, left: 0, right: 900, bottom: top + height, width: 900, height, toJSON: () => ({}) };
    });
    vi.spyOn(Element.prototype, "scrollHeight", "get").mockReturnValue(1000);
  });
  afterEach(() => {
    styles.remove();
    observers.clear();
    vi.restoreAllMocks();
    globalThis.ResizeObserver = originalObserver;
    if (originalHeight) Object.defineProperty(window, "innerHeight", originalHeight);
  });

  it("caps automatic growth at 24 rows and reserves actions when the window shrinks", () => {
    render(<EditorWithActions value="Long working principles" />);
    for (const observer of observers) observer.flush();
    const editor = screen.getByRole("textbox", { name: "Soul" }) as HTMLTextAreaElement;
    expect(editor.style.height).toBe("588px");
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 768 });
    fireEvent(window, new Event("resize"));
    expect(editor.style.height).toBe("496px");
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 640 });
    fireEvent(window, new Event("resize"));
    expect(editor.style.height).toBe("368px");
    expect(editor.style.overflowY).toBe("auto");
  });

  it("preserves a manually adjusted height on subsequent edits", () => {
    const view = render(<EditorWithActions value="Working principles" />);
    for (const observer of observers) observer.flush();
    const editor = screen.getByRole("textbox", { name: "Soul" }) as HTMLTextAreaElement;
    editor.style.height = "450px";
    for (const observer of observers) observer.flush();
    view.rerender(<EditorWithActions value="Revised working principles" />);
    expect(editor.style.height).toBe("450px");
    expect(editor.style.overflowY).toBe("auto");
  });
});
