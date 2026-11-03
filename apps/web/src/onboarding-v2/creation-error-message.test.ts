import { afterEach, describe, expect, it } from "vitest";
import { ApiError } from "../api.js";
import { overwriteGetLocale } from "../paraglide/runtime.js";
import { creationErrorMessage } from "./page.js";

describe("creationErrorMessage", () => {
  afterEach(() => overwriteGetLocale(() => "en"));

  it.each([
    ["en", "An Agent with this name already exists. Names are not case-sensitive."],
    ["zh", "已有同名 Agent，名称不区分大小写。"],
  ] as const)("says a taken name in the reader's language (%s), not the Server's", (locale, expected) => {
    overwriteGetLocale(() => locale);
    const conflict = new ApiError(
      409,
      "An active Agent with this name already exists for this Account",
      "AGENT_NAME_CONFLICT",
    );
    expect(creationErrorMessage(conflict)).toBe(expected);
  });

  it("keeps the Server's message for other refusals", () => {
    expect(creationErrorMessage(new ApiError(403, "Forbidden", "AGENT_FORBIDDEN"))).toBe("Forbidden");
  });
});
