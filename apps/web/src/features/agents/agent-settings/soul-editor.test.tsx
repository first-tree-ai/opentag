import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readSoul, replaceSoul } from "../../../__tests__/soul-editor.js";
import { overwriteGetLocale } from "../../../paraglide/runtime.js";
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
        Save changes
      </div>
    </main>
  );
}

it("allows selection and scrolling in reading mode without changing content or opening formatting", () => {
  const onValueChange = vi.fn();
  render(
    <SoulEditor
      disabled={false}
      readOnly
      footerRef={{ current: null }}
      id="soul"
      value="Read **carefully**."
      onValueChange={onValueChange}
    />,
  );
  const editor = screen.getByRole("textbox", { name: "Soul" });
  editor.focus();
  fireEvent.keyDown(editor, { key: "F10", altKey: true });
  fireEvent.paste(editor, { clipboardData: { getData: () => "Overwrite" } });
  fireEvent.keyDown(editor, { key: "b", ctrlKey: true });
  expect(editor.getAttribute("tabindex")).toBe("0");
  expect(editor.getAttribute("contenteditable")).toBe("false");
  expect(editor.textContent).toBe("Read carefully.");
  expect(onValueChange).not.toHaveBeenCalled();
  expect(screen.queryByRole("toolbar")).toBeNull();
});

it("does not reopen a previously requested formatting menu when editing starts again", async () => {
  const props = {
    disabled: false,
    footerRef: { current: null },
    id: "soul",
    value: "Keep this rule.",
    onValueChange: vi.fn(),
  };
  const view = render(<SoulEditor {...props} />);
  const editor = screen.getByRole("textbox", { name: "Soul" });
  editor.focus();
  fireEvent.keyDown(editor, { key: "F10", altKey: true });
  await screen.findByRole("toolbar");
  view.rerender(<SoulEditor {...props} readOnly />);
  await waitFor(() => expect(screen.queryByRole("toolbar")).toBeNull());
  view.rerender(<SoulEditor {...props} readOnly={false} />);
  editor.focus();
  await waitFor(() => expect(screen.queryByRole("toolbar")).toBeNull());
  expect(props.onValueChange).not.toHaveBeenCalled();
});

describe("Soul editor height", () => {
  let styles: HTMLStyleElement;
  const originalHeight = Object.getOwnPropertyDescriptor(window, "innerHeight");
  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 900 });
    styles = document.createElement("style");
    styles.textContent =
      ".soul-editor {font-size:14px;line-height:22.75px;padding:20px;border:1px solid} main {padding:32px}";
    document.head.append(styles);
    globalThis.ResizeObserver = LayoutObserver;
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      const element = this as HTMLElement;
      const top = element.classList.contains("soul-editor") ? 120 : 0;
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
    vi.useRealTimers();
    globalThis.ResizeObserver = originalObserver;
    if (originalHeight) Object.defineProperty(window, "innerHeight", originalHeight);
  });

  it("reserves actions and keeps the preview minimum height when the window shrinks", () => {
    render(<EditorWithActions value="Long working principles" />);
    for (const observer of observers) observer.flush();
    const editor = screen.getByRole("textbox", { name: "Soul" }) as HTMLElement;
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
    vi.advanceTimersToNextFrame();
    const editor = screen.getByRole("textbox", { name: "Soul" }) as HTMLElement;
    editor.style.height = "450px";
    for (const observer of observers) observer.flush();
    vi.advanceTimersToNextFrame();
    view.rerender(<EditorWithActions value="Revised working principles" />);
    expect(editor.style.height).toBe("450px");
    expect(editor.style.overflowY).toBe("auto");
  });

  it("preserves the reading position when content is remeasured", () => {
    const view = render(<EditorWithActions value="Working principles" />);
    const editor = screen.getByRole("textbox", { name: "Soul" });
    // Model the browser expanding a scrollable document during intrinsic-height measurement.
    Object.defineProperty(editor.style, "height", {
      configurable: true,
      get: () => editor.style.getPropertyValue("height"),
      set: (next: string) => {
        if (next === "auto") editor.scrollTop = 0;
        editor.style.setProperty("height", next);
      },
    });
    editor.scrollTop = 320;
    view.rerender(<EditorWithActions value="Revised working principles" />);
    expect(editor.scrollTop).toBe(320);
  });

  it("releases space reserved for stacked save controls when the layout widens", () => {
    let width = 500;
    const measure = vi.mocked(Element.prototype.getBoundingClientRect).getMockImplementation();
    if (!measure) throw new Error("Layout measurement mock missing");
    vi.mocked(Element.prototype.getBoundingClientRect).mockImplementation(function (this: Element) {
      const bounds = measure.call(this);
      const height = (this as HTMLElement).dataset.testid === "soul-footer" ? (width < 800 ? 300 : 104) : bounds.height;
      return { ...bounds, width, right: width, height, bottom: bounds.top + height };
    });
    render(<EditorWithActions value="Long working principles" />);
    for (const observer of observers) observer.flush();
    vi.advanceTimersToNextFrame();
    const editor = screen.getByRole("textbox", { name: "Soul" }) as HTMLElement;
    expect(editor.style.height).toBe("432px");
    width = 900;
    for (const observer of observers) observer.flush();
    // Observer delivery reads geometry without resizing another observed region in the same frame.
    expect(editor.style.height).toBe("432px");
    vi.advanceTimersToNextFrame();
    expect(editor.style.height).toBe("588px");
  });
});

function Document({
  source,
  onChange,
  disabled = false,
}: {
  source: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const [value, setValue] = useState(source);
  const footer = useRef<HTMLDivElement>(null);
  return (
    <form>
      <SoulEditor
        disabled={disabled}
        footerRef={footer}
        id="soul"
        value={value}
        onValueChange={(next) => {
          setValue(next);
          onChange(next);
        }}
      />
    </form>
  );
}

describe("Soul document editing", () => {
  afterEach(() => overwriteGetLocale(() => "en"));

  it.each([
    ["```text\nbefore\n```", "pre code", "one\n**two**"],
    ["<rules>before</rules>", "pre[data-soul-source]", "one\n**two**"],
    ["Keep `before` literal.", "code", "one **two**"],
    ["Use <rule> inline.", "span[data-soul-source=inline]", "one **two**"],
    ["![diagram](https://example.com/image.png)", "span[data-soul-source=image]", "one **two**"],
  ])("pastes literal text without parsing Markdown inside %s", async (source, selector, pasted) => {
    render(<Document source={source} onChange={vi.fn()} />);
    const editor = screen.getByRole("textbox", { name: "Soul" });
    const literal = editor.querySelector(selector);
    if (!literal) throw new Error("Literal document fixture missing");
    editor.focus();
    const range = document.createRange();
    if (!literal.firstChild) throw new Error("Literal text fixture missing");
    range.setStart(literal.firstChild, 2);
    range.collapse(true);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    fireEvent(document, new Event("selectionchange"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    fireEvent.paste(editor, {
      clipboardData: { getData: (format: string) => (format === "text/plain" ? pasted : "") },
    });
    expect(editor.querySelectorAll(selector)).toHaveLength(1);
    expect(editor.querySelector(selector)?.textContent).toContain("**two**");
    expect(editor.querySelector("strong")).toBeNull();
  });

  it("prevents formatting an in-flight saved document", async () => {
    const onChange = vi.fn();
    const view = render(<Document source="Keep this rule." onChange={onChange} />);
    const editor = screen.getByRole("textbox", { name: "Soul" });
    editor.focus();
    fireEvent.keyDown(editor, { key: "F10", altKey: true });
    await screen.findByRole("button", { name: "Heading" });
    view.rerender(<Document source="Keep this rule." onChange={onChange} disabled />);
    await waitFor(() => {
      const current = screen.queryByRole("button", { name: "Heading", hidden: true });
      expect(!current || current.hasAttribute("disabled") || current.getAttribute("aria-disabled") === "true").toBe(
        true,
      );
    });
    const current = screen.queryByRole("button", { name: "Heading", hidden: true });
    if (current) fireEvent.click(current);
    expect(readSoul(editor)).toBe("Keep this rule.");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("renders Markdown without changing the original source on focus or locale changes", () => {
    const source = "## Role\n\nBe **careful**.\n\n- Verify sources\n- Explain limits\n";
    const onChange = vi.fn();
    const view = render(<Document source={source} onChange={onChange} />);
    const editor = screen.getByRole("textbox", { name: "Soul" });
    expect(editor.querySelector("h2")?.textContent).toBe("Role");
    expect(editor.querySelector("strong")?.textContent).toBe("careful");
    expect(editor.querySelectorAll("li")).toHaveLength(2);
    editor.focus();
    overwriteGetLocale(() => "zh");
    view.rerender(<Document source={source} onChange={onChange} />);
    expect(readSoul(editor)).toBe(source);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("uses standard formatting shortcuts and restores the exact original source on undo", () => {
    const source = "An original rule.\n";
    const onChange = vi.fn();
    render(<Document source={source} onChange={onChange} />);
    const editor = screen.getByRole("textbox", { name: "Soul" });
    editor.focus();
    fireEvent.keyDown(editor, { key: "a", ctrlKey: true });
    fireEvent.keyDown(editor, { key: "b", ctrlKey: true });
    expect(editor.querySelector("strong")?.textContent).toBe("An original rule.");
    expect(readSoul(editor)).toContain("**An original rule.**");
    fireEvent.keyDown(editor, { key: "z", ctrlKey: true });
    expect(readSoul(editor)).toBe(source);
  });

  it("accepts Markdown clipboard content and clears to a genuinely empty string", () => {
    render(<Document source="Existing rule." onChange={vi.fn()} />);
    const editor = screen.getByRole("textbox", { name: "Soul" });
    replaceSoul(editor, "## New role\n\n- Be concise\n- Verify claims");
    expect(editor.querySelector("h2")?.textContent).toBe("New role");
    expect(editor.querySelectorAll("li")).toHaveLength(2);
    expect(readSoul(editor)).not.toContain("Existing rule.");
    replaceSoul(editor, "");
    expect(readSoul(editor)).toBe("");
    expect(document.activeElement).toBe(editor);
  });

  it("opens the standard toolbar from the keyboard and returns focus with Escape", async () => {
    const onChange = vi.fn();
    const view = render(<Document source="Be precise." onChange={onChange} />);
    const editor = screen.getByRole("textbox", { name: "Soul" });
    editor.focus();
    fireEvent.keyDown(editor, { key: "F10", altKey: true });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Heading" })));
    const heading = screen.getByRole("button", { name: "Heading" });
    fireEvent.keyDown(heading, { key: "ArrowRight" });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Bold" })));
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Escape" });
    await waitFor(() => expect(document.activeElement).toBe(editor));
    await waitFor(() => expect(screen.queryByRole("toolbar")).toBeNull());
    overwriteGetLocale(() => "zh");
    view.rerender(<Document source="Be precise." onChange={onChange} />);
    fireEvent.keyDown(editor, { key: "F10", altKey: true });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "标题" })));
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowRight" });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "加粗" })));
  });
});
