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
import { ImProviderSchema } from "@opentag/shared/browser";
import { describe, expect, it } from "vitest";
import { locales, overwriteGetLocale } from "../paraglide/runtime.js";
import { messagingProviderAlternateBrand, messagingProviderLabel } from "./provider-label.js";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sourceRoot = resolve(webRoot, "src");
const messagesRoot = resolve(webRoot, "messages");

/**
 * The names to look for, asked of the helper rather than listed here.
 *
 * A written-out list would need somebody to remember to extend it, which is the failure this guard
 * exists to remove: the exhaustive `switch` forces a new provider to be given a name, but it cannot
 * force a separate list of spellings to learn about it. Adding a provider — or a second brand for
 * an existing one — therefore widens this set on its own, in every locale a reader can read.
 */
function guardedBrands(): string[] {
  const names = new Set<string>();
  const restore = () => overwriteGetLocale(() => "en");
  try {
    for (const locale of locales) {
      overwriteGetLocale(() => locale);
      for (const provider of ImProviderSchema.options) names.add(messagingProviderLabel(provider));
      names.add(messagingProviderAlternateBrand());
    }
  } finally {
    restore();
  }
  return [...names];
}

const BRANDS = new RegExp(
  guardedBrands()
    .map((name) => name.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|"),
);

/**
 * The one file where a brand may be written, because it is where a provider becomes a name.
 */
const NAMING_POINT = "im/provider-label.ts";

/**
 * Everywhere else, exemptions are exact strings rather than whole files.
 *
 * A file-level exemption hides the next literal somebody adds to that file, which is precisely the
 * accident this guard is for. Listing the text means a new brand-bearing string is caught even in a
 * module that already has one, and it makes each exemption a sentence somebody chose to keep.
 */
const ALLOWED_TEXT = new Map<string, { readonly reason: string; readonly text: ReadonlySet<string> }>([
  [
    "setup/copy.ts",
    {
      reason: "pre-i18n copy that never moved into a catalogue; migration tracked by #241",
      text: new Set([
        "Install OpenTag in your Slack workspace. We'll take you to Slack and bring you back.",
        "Add to Slack",
        "Waiting for you to finish in Slack\u2026",
      ]),
    },
  ],
  [
    "mock/task-data.ts",
    {
      reason: "demo fixtures standing in for real Task sources, not product copy",
      text: new Set([
        "Feishu \u00b7 Product Launch",
        "Feishu \u00b7 Customer Feedback",
        "Feishu \u00b7 Engineering onboarding",
        "Searched 12 Feishu messages",
        "Read 2 Feishu sources",
      ]),
    },
  ],
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
    if (path.startsWith("__tests__/") || path.startsWith("paraglide/") || path === NAMING_POINT) continue;
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
    const unexplained = sourceFindings().filter((finding) => !ALLOWED_TEXT.get(finding.path)?.text.has(finding.text));
    expect(describeFindings(unexplained)).toBe("");
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

  /*
   * Staleness is read from the same parsed reader text the guard itself uses, not from the file's
   * bytes. A brand left in a comment or an identifier would keep a byte-level check green forever,
   * so an exemption could outlive the literal it was granted for and leave the module unguarded —
   * the exact state this assertion claims to prevent.
   */
  it("keeps every exempted string matching a literal the guard still sees", () => {
    const seen = new Map<string, Set<string>>();
    for (const finding of sourceFindings()) {
      (seen.get(finding.path) ?? seen.set(finding.path, new Set()).get(finding.path))?.add(finding.text);
    }
    const stale: string[] = [];
    for (const [path, { text }] of ALLOWED_TEXT) {
      for (const exempt of text) {
        if (!seen.get(path)?.has(exempt)) stale.push(`${path}: ${JSON.stringify(exempt)}`);
      }
    }
    expect(stale).toEqual([]);
  });

  /** The set the guard looks for has to be the set the helper can produce, or it guards nothing. */
  it("looks for every name the label helper can return", () => {
    expect(guardedBrands().toSorted()).toEqual(["Feishu", "Lark", "Slack", "飞书"].toSorted());
    for (const brand of guardedBrands()) expect(BRANDS.test(brand)).toBe(true);
  });
});
