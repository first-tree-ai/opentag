import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SKILL_PRESET_CATEGORY_IDS } from "@opentag/shared/browser";
import { describe, expect, it } from "vitest";

/**
 * The preset catalog's chrome is ordinary interface copy from the message catalog, unlike the MCP
 * catalog's data-driven cards. That makes two drift risks testable here: the two locales falling out
 * of parity, and a new `SKILL_PRESET_CATEGORY_IDS` entry shipping without a label.
 */

type Messages = Record<string, unknown>;

// Resolved from this file, not the working directory: the workspace unit-test job runs with apps/web
// as the cwd while the coverage run measures every project from the repository root.
const messagesRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../messages/skills");

function read(locale: "en" | "zh"): Messages {
  return JSON.parse(readFileSync(resolve(messagesRoot, `${locale}.json`), "utf8")) as Messages;
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
