/**
 * The app's stylesheets may not give a text role a line box shorter than the font's ink.
 *
 * Manrope, the Latin face this app ships, draws from yMin -510 to yMax 1995 inside its 2000-unit em, so its glyphs
 * span 1.2525em. A line box below that ratio puts ascenders and descenders outside the element's own box, where
 * `truncate`, `overflow-hidden`, or an adjacent rule then clips or touches them (issue #831). PingFang SC, the
 * Chinese fallback, lays out on a 1.4em content box, which is why the display roles in `primitives.css` and
 * `onboarding-v2.css` sit above the floor instead of on it.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postcss from "postcss";
import { describe, expect, it } from "vitest";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** Manrope: (yMax 1995 - yMin -510) / unitsPerEm 2000. */
const MANROPE_INK_RATIO = 1.2525;
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
      if (ratio !== undefined && ratio < MANROPE_INK_RATIO) {
        found.push(`${path} :: ${site} :: ratio ${ratio.toFixed(4)}`);
      }
    });
  }
  return found;
}

describe("text metrics", () => {
  it("keeps every line box at least as tall as the font's ink", () => {
    expect(violations()).toEqual([]);
  });

  it("scans the stylesheets that carry application typography", () => {
    const paths = stylesheets.map((file) => relative(sourceRoot, file).replaceAll("\\", "/"));
    expect(paths).toContain("app.css");
    expect(paths).toContain("ui/primitives.css");
    expect(paths.length).toBeGreaterThan(5);
  });
});
