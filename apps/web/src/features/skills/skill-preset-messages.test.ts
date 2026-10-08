import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SKILL_PRESET_CATEGORY_IDS } from "@opentag/shared/browser";
import { describe, expect, it } from "vitest";

/**
 * The preset catalog's chrome is ordinary interface copy from the message catalog, unlike the MCP
 * catalog's data-driven cards. That makes two drift risks testable here: the two locales falling out
 * of parity, and a new `SKILL_PRESET_CATEGORY_IDS` entry shipping without a label.
 */

type Messages = Record<string, unknown>;

function read(locale: "en" | "zh"): Messages {
  // Vitest runs with the Web project root as the working directory, same as the paraglide compile.
  const path = resolve(process.cwd(), "messages/skills", `${locale}.json`);
  return JSON.parse(readFileSync(path, "utf8")) as Messages;
}

describe("preset catalog copy", () => {
  it("keeps the two locales in parity", () => {
    const en = read("en");
    const zh = read("zh");
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort());
    for (const [key, value] of Object.entries(en)) {
      if (typeof value !== "string") continue;
      expect(value.trim().length, `${key} (en)`).toBeGreaterThan(0);
      expect(String(zh[key]).trim().length, `${key} (zh)`).toBeGreaterThan(0);
    }
  });

  it("gives every shared preset category a label in both locales", () => {
    const en = read("en");
    const zh = read("zh");
    for (const id of SKILL_PRESET_CATEGORY_IDS) {
      const key = `skills_preset_category_${id.replace(/-/g, "_")}`;
      expect(typeof en[key], `${key} (en)`).toBe("string");
      expect(typeof zh[key], `${key} (zh)`).toBe("string");
    }
  });
});
