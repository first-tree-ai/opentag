/**
 * The Chinese catalogue speaks the glossary in `docs/system/web/i18n.md`, not the code's vocabulary.
 *
 * Untranslated product nouns ("Computer", "Connector", "Context Tree") and internal concepts
 * ("Soul", "Session", "Turn") kept reaching Chinese readers one string at a time, next to the
 * translated word for the same thing, and each was only found by someone reading the page. The
 * catalogue is plain data, so the check reads every `zh.json` value directly.
 *
 * Exemptions are per message key and say why. The internal Agent Setup lab is a development tool
 * rather than product copy, so its keys are skipped as a group.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const messagesRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../messages");

/** Each term maps to the word Chinese copy uses instead, as listed in the glossary. */
const DISALLOWED: ReadonlyArray<{ readonly pattern: RegExp; readonly use: string }> = [
  { pattern: /智能体|编程助手|AI ?助手/u, use: "Agent" },
  { pattern: /\bAgents\b/u, use: "Agent" },
  { pattern: /计算机|\bComputers?\b/u, use: "电脑" },
  { pattern: /\bAccounts?\b/u, use: "账户" },
  { pattern: /账号/u, use: "账户" },
  { pattern: /\bConnectors?\b/u, use: "连接器" },
  { pattern: /Context Tree/u, use: "知识树" },
  { pattern: /\bSkills?\b/u, use: "技能" },
  { pattern: /\bServers?\b/u, use: "服务器" },
  { pattern: /\bSoul\b/u, use: "指令" },
  { pattern: /\bSessions?\b|\bTurns?\b/u, use: "任务 or 任务记录" },
  { pattern: /\bProviders?\b/u, use: "Agent or 模型服务" },
  { pattern: /\bTokens\b/u, use: "Token" },
];

const SKIPPED_KEY_PREFIXES = ["onboarding_v2_lab_", "common_agent_setup_lab"];

const ALLOWED_KEYS = new Map<string, string>([]);

function zhCatalogue(): Array<{ area: string; key: string; value: string }> {
  return readdirSync(messagesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const messages = JSON.parse(readFileSync(resolve(messagesRoot, entry.name, "zh.json"), "utf8")) as Record<
        string,
        unknown
      >;
      return Object.entries(messages)
        .filter((pair): pair is [string, string] => pair[0] !== "$schema" && typeof pair[1] === "string")
        .map(([key, value]) => ({ area: entry.name, key, value }));
    });
}

describe("Chinese terminology", () => {
  const catalogue = zhCatalogue();

  it("reads every message area", () => {
    expect(new Set(catalogue.map((message) => message.area)).size).toBeGreaterThan(10);
  });

  it("uses glossary terms instead of English product nouns and internal concepts", () => {
    const violations = catalogue.flatMap(({ area, key, value }) => {
      if (SKIPPED_KEY_PREFIXES.some((prefix) => key.startsWith(prefix)) || ALLOWED_KEYS.has(key)) return [];
      // Placeholder names are code, not copy.
      const copy = value.replaceAll(/\{[^}]*\}/gu, "");
      return DISALLOWED.filter(({ pattern }) => pattern.test(copy)).map(
        ({ pattern, use }) => `${area}/${key}: ${pattern.source} → ${use}`,
      );
    });
    expect(violations).toEqual([]);
  });

  it("keeps every exemption pointed at a message that still exists", () => {
    const keys = new Set(catalogue.map((message) => message.key));
    expect([...ALLOWED_KEYS.keys()].filter((key) => !keys.has(key))).toEqual([]);
  });
});
