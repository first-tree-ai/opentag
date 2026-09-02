/**
 * The sign-in button names a method, not an identifier.
 *
 * #322 reported this as "Continue with github". There is no GitHub sign-in provider — the login
 * page's ids are `google`, `dev` and `password` — and of those, `password` renders as a form and
 * `google` renders as an image, so `dev` is the only id that ever reaches this sentence. The defect
 * was real; the string was "Continue with dev". These assert the fixed reading rather than the
 * reported one.
 */

import { describe, expect, it } from "vitest";
import { spaceScriptBoundary } from "../../i18n/format.js";
import * as m from "../../paraglide/messages.js";
import { overwriteGetLocale } from "../../paraglide/runtime.js";
import { authProviderLabel } from "./provider-label.js";

function withLocale(locale: "en" | "zh", callback: () => void): void {
  overwriteGetLocale(() => locale);
  try {
    callback();
  } finally {
    overwriteGetLocale(() => "en");
  }
}

/** Composed the way `LoginProviderLink` composes it. */
function continueWith(provider: Parameters<typeof authProviderLabel>[0]): string {
  return spaceScriptBoundary(m.auth_continue_with_provider({ provider: authProviderLabel(provider) }));
}

describe("naming a sign-in method", () => {
  /*
   * The property is that every id was given a name, not that the id's letters are absent: "Email and
   * password" contains "password" because that is the English word, which is exactly the sort of
   * coincidence a `not.toContain` check would have mistaken for a pass.
   */
  it("gives every sign-in method a name of its own", () => {
    for (const locale of ["en", "zh"] as const) {
      withLocale(locale, () => {
        for (const id of ["google", "dev", "password"] as const) {
          expect(authProviderLabel(id)).not.toBe(id);
        }
      });
    }
  });

  it("reads as a method in English", () => {
    withLocale("en", () => {
      expect(continueWith("dev")).toBe("Continue with Developer sign-in");
      expect(continueWith("google")).toBe("Continue with Google");
    });
  });

  /* The same slot takes a Chinese phrase and a Latin brand, so the sentence carries the spacing. */
  it("spaces a Latin name inside the Chinese sentence and a Chinese one not at all", () => {
    withLocale("zh", () => {
      expect(continueWith("dev")).toBe("使用开发者登录继续");
      expect(continueWith("google")).toBe("使用 Google 继续");
    });
  });

  it("refuses to label a sign-in method it has never heard of", () => {
    expect(() => authProviderLabel("passkey" as "dev")).toThrow(/Unlabelled auth provider/);
  });
});
