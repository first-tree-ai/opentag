/**
 * Only `provider-label.ts` may name a messaging channel to a reader.
 *
 * This invariant was maintained by reviewers noticing, and it did not hold: three separate rounds
 * on #311 each found a brand name reaching a reader from outside the helper, and each was found by
 * eye. Two of the three could not have been found by searching for a provider id, because they
 * convert no identifier — the words were simply correct, hand-written somewhere that is not the
 * naming point. An assertion about rendered text cannot close the gap either: reintroduce the same
 * literal spelled correctly and every output test stays green, because rendered text carries no
 * evidence of where it came from.
 *
 * So the check is structural. It reads string literals, template chunks, and JSX text rather than
 * grepping, because most brand-shaped words in this tree are identifiers — `FeishuSetup`,
 * `slackInstallUrl`, the `"feishu"` provider id — and none of those reach a reader.
 *
 * The allowlist is deliberately short and each entry names why it is there. Adding to it should
 * feel like a decision, because that is the moment this guard is being weakened.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "@babel/parser";
import { describe, expect, it } from "vitest";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sourceRoot = resolve(webRoot, "src");
const messagesRoot = resolve(webRoot, "messages");

/** Every brand this product may ever show for a messaging channel, in either script. */
const BRANDS = /Feishu|Lark|Slack|飞书/;

/**
 * Files that may spell a brand, and the reason each is exempt. A path leaves this list by having
 * its copy moved behind the helper, not by being deleted from here.
 */
const ALLOWED = new Map<string, string>([
  ["im/provider-label.ts", "the naming point itself: this is where a provider becomes a name"],
  ["setup/copy.ts", "pre-i18n copy that never moved into a catalogue; tracked by #241"],
  [
    "features/agents/agent-presentation.ts",
    "three recovery sentences that no longer render at all; deletion tracked by #336",
  ],
  ["mock/task-data.ts", "demo fixtures, not product copy"],
  ["onboarding-v2/mock-backend.ts", "demo fixtures, not product copy"],
]);

interface Finding {
  readonly path: string;
  readonly line: number;
  readonly text: string;
}

function walk(node: unknown, visit: (node: Record<string, unknown>) => void): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  const record = node as Record<string, unknown>;
  if (typeof record.type === "string") visit(record);
  for (const [key, value] of Object.entries(record)) {
    if (key === "loc") continue;
    walk(value, visit);
  }
}

/** The three node kinds that can carry text a reader ends up seeing. Identifiers are not among them. */
function readerText(node: Record<string, unknown>): string | undefined {
  if (node.type === "StringLiteral" || node.type === "JSXText") return node.value as string;
  if (node.type === "TemplateElement") return (node.value as { cooked?: string }).cooked ?? "";
  return undefined;
}

function sourceFindings(): Finding[] {
  const findings: Finding[] = [];
  const files = readdirSync(sourceRoot, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name) && !entry.name.includes(".test."))
    .map((entry) => resolve(entry.parentPath, entry.name));

  for (const file of files) {
    const path = relative(sourceRoot, file).replaceAll("\\", "/");
    if (path.startsWith("__tests__/") || path.startsWith("paraglide/") || ALLOWED.has(path)) continue;
    const syntax = parse(readFileSync(file, "utf8"), { plugins: ["typescript", "jsx"], sourceType: "module" });

    walk(syntax, (node) => {
      const text = readerText(node);
      if (text === undefined || !BRANDS.test(text)) return;
      const loc = node.loc as { start: { line: number } } | undefined;
      findings.push({ line: loc?.start.line ?? 0, path, text: text.trim() });
    });
  }
  return findings;
}

function catalogueFindings(): Finding[] {
  const findings: Finding[] = [];
  for (const entry of readdirSync(messagesRoot, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const file = resolve(entry.parentPath, entry.name);
    const path = relative(messagesRoot, file).replaceAll("\\", "/");
    const catalogue = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    for (const [key, value] of Object.entries(catalogue)) {
      if (key === "$schema" || typeof value !== "string" || !BRANDS.test(value)) continue;
      findings.push({ line: 0, path: `messages/${path}`, text: `${key}: ${value}` });
    }
  }
  return findings;
}

function describeFindings(findings: readonly Finding[]): string {
  return findings.map((finding) => `${finding.path}:${finding.line} ${JSON.stringify(finding.text)}`).join("\n");
}

describe("only the label helper names a messaging channel", () => {
  it("finds no brand spelled in reader-facing source", () => {
    const findings = sourceFindings();
    expect(describeFindings(findings)).toBe("");
  });

  /*
   * Catalogues are the other half. A brand written into an entry renders identically today, so no
   * output test can see it — but it is the same defect: a sentence that cannot follow a rename, and
   * that a search for a provider id will never surface.
   */
  it("finds no brand spelled in a message catalogue", () => {
    const findings = catalogueFindings();
    expect(describeFindings(findings)).toBe("");
  });

  /** An exemption that no longer matches a real file is an exemption nobody is being asked about. */
  it("keeps every allowlist entry pointing at a file that still spells a brand", () => {
    const stale = [...ALLOWED.keys()].filter((path) => {
      const file = resolve(sourceRoot, path);
      return !BRANDS.test(readFileSync(file, "utf8"));
    });
    expect(stale).toEqual([]);
  });
});
