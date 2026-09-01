import type { MeResponse } from "@opentag/shared/browser";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as locale from "../../i18n/locale.js";
import { AccountSettings } from "./account-page.js";

const user: MeResponse["user"] = {
  id: "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e",
  email: "tester@company.example",
  displayName: "Tester",
};

describe("AccountSettings language selector", () => {
  afterEach(() => vi.restoreAllMocks());

  it("renders every locale with its self-named label and selects the current locale", async () => {
    render(<AccountSettings refreshMe={vi.fn().mockResolvedValue({ user, setupCompletedAt: null })} user={user} />);

    const selector = screen.getByRole("combobox", { name: "Language" });
    expect(selector.textContent).toContain(locale.LOCALE_LABELS[locale.getLocale()]);
    expect(selector.className.split(/\s+/)).toContain("w-full");
    expect(selector.className.split(/\s+/)).not.toContain("w-max");
    expect(selector.getAttribute("aria-labelledby")).toBe("account-language-label");
    expect(selector.getAttribute("aria-label")).toBeNull();
    expect(selector.closest('[data-ui="field"]')?.querySelector("label")?.classList.contains("sr-only")).toBe(true);

    fireEvent.click(selector);
    const options = await screen.findAllByRole("option");
    expect(options.map((option) => option.textContent?.trim())).toEqual(
      locale.locales.map((availableLocale) => locale.LOCALE_LABELS[availableLocale]),
    );
    const currentOption = options.find(
      (option) => option.textContent?.trim() === locale.LOCALE_LABELS[locale.getLocale()],
    );
    expect(currentOption?.getAttribute("aria-selected")).toBe("true");
  });

  it("passes a normalized locale to Paraglide when the selection changes", async () => {
    const setLocale = vi.spyOn(locale, "setLocale");
    render(<AccountSettings refreshMe={vi.fn().mockResolvedValue({ user, setupCompletedAt: null })} user={user} />);

    const selector = screen.getByRole("combobox", { name: "Language" });
    fireEvent.click(selector);
    const option = await screen.findByRole("option", { name: locale.LOCALE_LABELS.zh });
    fireEvent.pointerMove(option, { pointerType: "mouse" });
    fireEvent.pointerDown(option, { pointerType: "mouse" });
    fireEvent.pointerUp(option, { pointerType: "mouse" });
    fireEvent.click(option);

    await waitFor(() => expect(setLocale).toHaveBeenCalledWith("zh"));
  });
});
