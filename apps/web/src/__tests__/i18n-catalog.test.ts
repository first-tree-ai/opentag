import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { baseLocale, locales } from "../paraglide/runtime.js";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const messagesRoot = resolve(webRoot, "messages");
const sourceRoot = resolve(webRoot, "src");
const areas = [
  "common",
  "format",
  "shell",
  "errors",
  "auth",
  "account",
  "agents",
  "agent-settings",
  "agent-create",
  "tasks",
  "usage",
  "skills",
  "integrations",
  "agent-setup",
  "onboarding-v2",
  "im",
] as const;
const localeCodes = ["en", "zh"] as const;
const allowedUntranslatedValues = new Set([
  "OpenTag",
  "Codex",
  "Claude Code",
  "Google",
  "Slack",
  "Feishu",
  "Lark",
  "Token",
  "Tokens",
]);

function messageTexts(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(messageTexts);
  if (value && typeof value === "object") return Object.values(value).flatMap(messageTexts);
  return [];
}

function placeholders(value: unknown): Set<string> {
  return new Set(
    messageTexts(value)
      .flatMap((text) => [...text.matchAll(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g)].map((match) => match[1]))
      .filter((name): name is string => name !== undefined),
  );
}

function sourceText(): string {
  return readdirSync(sourceRoot, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(?:ts|tsx)$/.test(entry.name) && !entry.name.endsWith(".js"))
    .map((entry) => readFileSync(resolve(entry.parentPath, entry.name), "utf8"))
    .join("\n");
}

describe("i18n catalog", () => {
  it("keeps every configured area present for both locales", () => {
    for (const area of areas) {
      for (const locale of localeCodes) {
        expect(existsSync(resolve(messagesRoot, area, `${locale}.json`))).toBe(true);
      }
    }
  });

  it("keeps locale keys, placeholders, prefixes, and ordering aligned", () => {
    const allKeys = new Map<string, string>();
    const source = sourceText();

    for (const area of areas) {
      const values = Object.fromEntries(
        localeCodes.map((locale) => [
          locale,
          JSON.parse(readFileSync(resolve(messagesRoot, area, `${locale}.json`), "utf8")),
        ]),
      ) as Record<(typeof localeCodes)[number], Record<string, unknown>>;
      const enKeys = Object.keys(values.en).filter((key) => key !== "$schema");
      const zhKeys = Object.keys(values.zh).filter((key) => key !== "$schema");
      expect(zhKeys).toEqual(enKeys);
      expect(enKeys).toEqual([...enKeys].sort());

      for (const key of enKeys) {
        expect(key).toMatch(/^[a-z][a-z0-9_]*$/);
        expect(key.startsWith(`${area.replaceAll("-", "_")}_`)).toBe(true);
        expect(placeholders(values.en[key])).toEqual(placeholders(values.zh[key]));

        const previousArea = allKeys.get(key);
        expect(previousArea).toBeUndefined();
        allKeys.set(key, area);

        const enValue = values.en[key];
        const zhValue = values.zh[key];
        expect(messageTexts(zhValue).every((text) => text.trim().length > 0)).toBe(true);
        if (JSON.stringify(enValue) === JSON.stringify(zhValue)) {
          expect(messageTexts(enValue).every((text) => allowedUntranslatedValues.has(text))).toBe(true);
        }
        if (area !== "common") {
          expect(source).toContain(`m.${key}`);
        }
      }
    }
  });

  it("uses the generated English base locale and locale list", () => {
    expect(baseLocale).toBe("en");
    expect([...locales]).toEqual(["en", "zh"]);
  });
});
