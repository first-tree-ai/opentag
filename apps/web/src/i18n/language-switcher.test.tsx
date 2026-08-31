import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { overwriteGetLocale, overwriteSetLocale } from "../paraglide/runtime.js";
import { LanguageSwitcher } from "./language-switcher.js";

describe("LanguageSwitcher", () => {
  afterEach(() => {
    overwriteGetLocale(() => "en");
    overwriteSetLocale(() => undefined);
  });

  it("renders the negotiated locale and persists an explicit selection", async () => {
    overwriteGetLocale(() => "en");
    const setLocale = vi.fn();
    overwriteSetLocale(setLocale);
    render(<LanguageSwitcher />);

    const selector = screen.getByRole("combobox", { name: "Language" });
    expect(selector.textContent).toContain("English");
    fireEvent.click(selector);
    const chinese = screen.getByRole("option", { name: "中文" });
    fireEvent.keyDown(chinese, { key: "Enter" });

    await waitFor(() => expect(setLocale).toHaveBeenCalledWith("zh"));
  });
});
