/**
 * The app's stylesheets may not give a text role a line box that puts Manrope's ink outside it.
 *
 * The line box is not centred on the ink; it is centred on the font's content area, which for Manrope (hhea ascent
 * 2132, descent 600, unitsPerEm 2000) is 1.366em and lopsided. The box's bottom edge therefore sits
 * `L/2 - (2132 - 600) / 4000 = L/2 - 0.383em` below the baseline, while the `g` descender reaches 0.255em
 * (yMin -510). Leading under `2 * (0.383 + 0.255) = 1.276` leaves descenders outside their own box, where
 * `truncate`, `overflow-hidden`, or an adjacent rule then clips or touches them (issue #831), so the floor is 1.28.
 *
 * Two limits this gate does not cover:
 * - It reads authored `.css` only, so line heights written as utilities in TSX are invisible to it. The one known
 *   case below the floor is the billing balance (`text-4xl sm:text-5xl`, `cloud-billing-settings.tsx:50`), which
 *   sits in `p-6` padding with nothing clipping it.
 * - It models 400-weight ink. At 700 the accented `Å` reaches yMax 2066 (1.033em) and would need about 1.31.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postcss from "postcss";
import { describe, expect, it } from "vitest";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** Manrope: 2 * (descender 510 + (ascent 2132 - descent 600) / 2) / unitsPerEm 2000 = 1.276, rounded up. */
const MANROPE_LINE_BOX_FLOOR = 1.28;
/** The browser default; the app sets no root font-size. */
const ROOT_FONT_SIZE_PX = 16;

const stylesheets = readdirSync(sourceRoot, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith(".css"))
  .map((entry) => resolve(entry.parentPath, entry.name))
  .sort();

function lengthToPx(value: string): number | undefined {
  const match = /^(\d*\.?\d+)(px|rem)$/.exec(value.trim());
  if (!match) return undefined;
  const amount = Number(match[1]);
  return match[2] === "rem" ? amount * ROOT_FONT_SIZE_PX : amount;
}

/** The ratio of a rule's line box to its font size; undefined when it uses a token we cannot resolve here. */
function lineHeightRatio(selector: string, declarations: Map<string, string>): { ratio?: number; site: string } {
  const site = `${selector} { line-height: ${declarations.get("line-height")} }`;
  const lineHeight = declarations.get("line-height") ?? "";
  if (/^\d*\.?\d+$/.test(lineHeight.trim())) return { ratio: Number(lineHeight), site };
  const fontPx = lengthToPx(declarations.get("font-size") ?? "");
  const linePx = lengthToPx(lineHeight);
  return { ratio: fontPx && linePx ? linePx / fontPx : undefined, site };
}

function violations(): string[] {
  const found: string[] = [];
  for (const file of stylesheets) {
    const path = relative(sourceRoot, file).replaceAll("\\", "/");
    postcss.parse(readFileSync(file, "utf8"), { from: file }).walkRules((rule) => {
      const declarations = new Map<string, string>();
      rule.walkDecls((decl) => {
        declarations.set(decl.prop, decl.value);
      });
      if (!declarations.has("line-height")) return;
      const { ratio, site } = lineHeightRatio(rule.selector, declarations);
      if (ratio !== undefined && ratio < MANROPE_LINE_BOX_FLOOR) {
        found.push(`${path} :: ${site} :: ratio ${ratio.toFixed(4)}`);
      }
    });
  }
  return found;
}

describe("text metrics", () => {
  it("keeps every line box at or above Manrope's line-box floor", () => {
    expect(violations()).toEqual([]);
  });

  it("scans the stylesheets that carry application typography", () => {
    const paths = stylesheets.map((file) => relative(sourceRoot, file).replaceAll("\\", "/"));
    expect(paths).toContain("app.css");
    expect(paths).toContain("ui/primitives.css");
    expect(paths.length).toBeGreaterThan(5);
  });
});
