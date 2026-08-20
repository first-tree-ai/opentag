import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The stylesheet once carried 35 distinct font sizes and 19 font weights as
 * literals written at the point of use, most of them within a pixel of each
 * other. These tests keep type flowing through the token layer so the scale
 * cannot drift back apart one component at a time.
 *
 * The checks are pure functions over CSS text, so the suite below can also
 * prove that each one rejects the declaration it exists to catch.
 */

/** The suite runs from apps/web and, under the coverage config, from the repo root. */
function locateStylesheet(): string {
  for (const candidate of ["src/styles.css", "apps/web/src/styles.css"]) {
    const path = resolve(process.cwd(), candidate);
    if (existsSync(path)) return path;
  }
  throw new Error(`The Web stylesheet was not found from ${process.cwd()}`);
}

const stylesheet = readFileSync(locateStylesheet(), "utf8");

/** The token families typography flows through. Adding one here extends every check below. */
const FAMILIES = ["fs", "text", "fw", "track", "font", "lh"] as const;

/** Every typography token reference, wherever it appears — including one role pointing at another. */
const TOKEN_REFERENCE = new RegExp(`var\\(--((?:${FAMILIES.join("|")})-[a-z0-9-]+)\\)`, "g");

/**
 * Line heights that are box geometry rather than text rhythm: `1` centres a
 * single glyph in its own line box, and 38px matches the height of the badge
 * it labels. Any other literal belongs in a --lh-* token.
 */
const LINE_HEIGHT_LITERALS = new Set(["1", "38px"]);

/**
 * The `font` shorthand resets size, line height, weight, style and family at
 * once, so it can leave the token layer behind in a single declaration. Form
 * controls legitimately adopt the inherited font; nothing else may use it.
 */
const FONT_SHORTHAND_LITERALS = new Set(["inherit"]);

/**
 * A commented-out declaration is not a declaration. The browser never sees it,
 * so neither should any check below: a token defined only inside a comment
 * does not exist, and a rule parked inside one cannot violate anything.
 */
function withoutComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

function captures(css: string, pattern: RegExp, group = 1): string[] {
  return [...withoutComments(css).matchAll(pattern)]
    .map((match) => match[group])
    .filter((value): value is string => value !== undefined)
    .map((value) => value.trim());
}

/** Values of `property`, matched as a longhand so `font:` never picks up `font-size:`. */
function declarations(css: string, property: string): string[] {
  return captures(css, new RegExp(`(?<![\\w-])${property}:\\s*([^;]+);`, "g"));
}

function definedTokens(css: string, prefix: string): Set<string> {
  return new Set(captures(css, new RegExp(`--(${prefix}-[a-z0-9-]+):`, "g")));
}

function definedTypographyTokens(css: string): Set<string> {
  return new Set(FAMILIES.flatMap((prefix) => [...definedTokens(css, prefix)]));
}

function offTokenValues(css: string, property: string, allowed: RegExp, literals?: Set<string>): string[] {
  return declarations(css, property).filter((value) => !allowed.test(value) && !(literals?.has(value) ?? false));
}

function danglingReferences(css: string): string[] {
  const defined = definedTypographyTokens(css);
  return [...new Set(captures(css, TOKEN_REFERENCE).filter((name) => !defined.has(name)))];
}

function unresolvedRoles(css: string): string[] {
  const steps = definedTokens(css, "fs");
  return captures(css, /--text-[a-z]+:\s*var\(--(fs-[a-z0-9-]+)\);/g).filter((step) => !steps.has(step));
}

describe("typography tokens", () => {
  it("declares every font size through a --text-* role", () => {
    expect(offTokenValues(stylesheet, "font-size", /^var\(--text-[a-z]+\)$/)).toEqual([]);
  });

  it("declares every font weight through a --fw-* token", () => {
    expect(offTokenValues(stylesheet, "font-weight", /^var\(--fw-[a-z]+\)$/)).toEqual([]);
  });

  it("declares every font family through a --font-* token", () => {
    expect(offTokenValues(stylesheet, "font-family", /^var\(--font-[a-z]+\)$/)).toEqual([]);
  });

  it("keeps the font shorthand to the controls that inherit it", () => {
    expect(offTokenValues(stylesheet, "font", /^$/, FONT_SHORTHAND_LITERALS)).toEqual([]);
  });

  it("declares every line height through a --lh-* token or a named geometry exception", () => {
    expect(offTokenValues(stylesheet, "line-height", /^var\(--lh-[a-z]+\)$/, LINE_HEIGHT_LITERALS)).toEqual([]);
  });

  it("declares every letter spacing through a --track-* token", () => {
    expect(offTokenValues(stylesheet, "letter-spacing", /^var\(--track-[a-z]+\)$/)).toEqual([]);
  });

  it("references only tokens that exist, including one role pointing at a step", () => {
    expect(danglingReferences(stylesheet)).toEqual([]);
  });

  it("resolves each role to a step that is actually declared", () => {
    expect(unresolvedRoles(stylesheet)).toEqual([]);
  });

  it("keeps every raw step on a whole pixel", () => {
    const steps = captures(stylesheet, /--fs-[0-9]+:\s*([0-9.]+)rem;/g).map((value) => Number(value) * 16);
    expect(steps.length).toBeGreaterThan(0);
    expect(steps.filter((px) => !Number.isInteger(px))).toEqual([]);
  });

  it("names each step after the pixel size it produces", () => {
    const named = captures(stylesheet, /--fs-([0-9]+):\s*([0-9.]+)rem;/g);
    const values = captures(stylesheet, /--fs-([0-9]+):\s*([0-9.]+)rem;/g, 2);
    expect(named.filter((name, index) => Number(name) !== Number(values[index]) * 16)).toEqual([]);
  });

  it("resolves each role to a raw step rather than a bare length", () => {
    const roles = captures(stylesheet, /--text-[a-z]+:\s*([^;]+);/g);
    expect(roles.length).toBeGreaterThan(0);
    expect(roles.filter((value) => !/^var\(--fs-[0-9]+\)$/.test(value))).toEqual([]);
  });
});

describe("the guard itself", () => {
  it("rejects the font shorthand, which escapes four token families at once", () => {
    const css = "body { font: 13px/1 Arial, sans-serif; }";
    expect(offTokenValues(css, "font", /^$/, FONT_SHORTHAND_LITERALS)).toEqual(["13px/1 Arial, sans-serif"]);
  });

  it("allows the font shorthand only where controls inherit it", () => {
    const css = "button { font: inherit; }";
    expect(offTokenValues(css, "font", /^$/, FONT_SHORTHAND_LITERALS)).toEqual([]);
  });

  it("rejects a literal font family", () => {
    const css = ".brand { font-family: Arial, sans-serif; }";
    expect(offTokenValues(css, "font-family", /^var\(--font-[a-z]+\)$/)).toEqual(["Arial, sans-serif"]);
  });

  it("rejects a literal font size, weight, tracking and line height", () => {
    const css = ".row { font-size: 0.83rem; font-weight: 615; letter-spacing: 0.03em; line-height: 1.42; }";
    expect(offTokenValues(css, "font-size", /^var\(--text-[a-z]+\)$/)).toEqual(["0.83rem"]);
    expect(offTokenValues(css, "font-weight", /^var\(--fw-[a-z]+\)$/)).toEqual(["615"]);
    expect(offTokenValues(css, "letter-spacing", /^var\(--track-[a-z]+\)$/)).toEqual(["0.03em"]);
    expect(offTokenValues(css, "line-height", /^var\(--lh-[a-z]+\)$/, LINE_HEIGHT_LITERALS)).toEqual(["1.42"]);
  });

  it("rejects a reference to a token that was never declared", () => {
    const css = ":root { --text-ui: var(--fs-15); }\n.row { line-height: var(--lh-prsoe); }";
    expect(danglingReferences(css)).toEqual(["fs-15", "lh-prsoe"]);
    expect(unresolvedRoles(css)).toEqual(["fs-15"]);
  });

  it("ignores a step that exists only inside a comment", () => {
    const css = ":root {\n  --text-ui: var(--fs-15);\n  /* --fs-15: 0.9375rem; */\n}";
    expect(unresolvedRoles(css)).toEqual(["fs-15"]);
    expect(danglingReferences(css)).toEqual(["fs-15"]);
  });

  it("does not read a commented-out declaration as a violation", () => {
    const css = ".row { /* font-size: 0.83rem; */ font-size: var(--text-ui); }";
    expect(offTokenValues(css, "font-size", /^var\(--text-[a-z]+\)$/)).toEqual([]);
  });

  it("does not mistake a longhand for the shorthand it starts with", () => {
    const css = "body { font-size: var(--text-ui); font-synthesis: none; }";
    expect(declarations(css, "font")).toEqual([]);
  });
});
