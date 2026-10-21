import { fireEvent, within } from "@testing-library/react";

export function readSoul(editor: HTMLElement): string {
  const form = editor.closest("form");
  if (!form) throw new Error("Soul form missing");
  return String(new FormData(form).get("instructions") ?? "");
}

// Exercise the editor's public keyboard and clipboard interfaces rather than its internal state.
export function replaceSoul(editor: HTMLElement, value: string) {
  if (editor.getAttribute("aria-readonly") === "true") {
    const form = editor.closest("form");
    if (!form) throw new Error("Soul form missing");
    fireEvent.click(within(form).getByRole("button", { name: /^(Edit|编辑)$/ }));
  }
  editor.focus();
  fireEvent.keyDown(editor, { key: "a", ctrlKey: true });
  if (value) {
    fireEvent.paste(editor, { clipboardData: { getData: (format: string) => (format === "text/plain" ? value : "") } });
  } else {
    fireEvent.keyDown(editor, { key: "Backspace", code: "Backspace" });
  }
}
