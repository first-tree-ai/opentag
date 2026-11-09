import { describe, expect, it } from "vitest";
import { INTERNAL_SESSION_TITLE_MAX_LENGTH, internalSessionTitle } from "../task-rows.js";

describe("internalSessionTitle", () => {
  it("collapses ASCII and Unicode whitespace alike before the cap", () => {
    for (const space of [" ", "\t", "\n", " ", " ", " ", "　", " ", "﻿"]) {
      const firstMessage = `${space.repeat(300)}Rotate${space}${space}the key${space}`;
      expect(internalSessionTitle({ title: null, firstMessage })).toBe("Rotate the key");
    }
  });

  it("caps a message-derived title by code points without splitting a surrogate pair", () => {
    const title = internalSessionTitle({ title: null, firstMessage: "😀".repeat(200) });
    expect(Array.from(title ?? "")).toHaveLength(INTERNAL_SESSION_TITLE_MAX_LENGTH);
    expect(title).toBe("😀".repeat(INTERNAL_SESSION_TITLE_MAX_LENGTH));
  });

  it("prefers a stored title and treats whitespace alone as absent", () => {
    expect(internalSessionTitle({ title: " Stored　title ", firstMessage: "Asked" })).toBe("Stored title");
    expect(internalSessionTitle({ title: " 　", firstMessage: " Asked " })).toBe("Asked");
    expect(internalSessionTitle({ title: null, firstMessage: " 　 " })).toBeNull();
    expect(internalSessionTitle({ title: null, firstMessage: null })).toBeNull();
  });
});
