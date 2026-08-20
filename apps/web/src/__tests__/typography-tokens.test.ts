import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import postcss, { type Declaration } from "postcss";
import { describe, expect, it } from "vitest";

/**
 * The stylesheet once carried 35 distinct font sizes and 19 font weights as
 * literals written at the point of use, most of them within a pixel of each
 * other. These tests keep type flowing through the token layer so the scale
 * cannot drift back apart one component at a time.
 *
 * Every check reads parsed declarations rather than raw text. Matching CSS
 * with regular expressions cost this guard three separate holes in review —
 * the `font` shorthand read as a longhand, a token defined only inside a
 * comment, and one quoted inside a value — so the parser draws those
 * boundaries now, and the suite below proves each one holds.
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

const TOKEN_REFERENCE = new RegExp(`var\\(\\s*--((?:${FAMILIES.join("|")})-[a-z0-9-]+)`, "g");

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

/** Comments parse as their own nodes, so only declarations the browser applies reach any check. */
function declarations(css: string): Declaration[] {
  const found: Declaration[] = [];
  postcss.parse(css).walkDecls((declaration) => {
    found.push(declaration);
  });
  return found;
}

/**
 * A quoted run is content, not code: `content: "--fs-15: 0.9375rem"` declares
 * no token and references none, so strings drop out before a value is read.
 */
function withoutStrings(value: string): string {
  return value.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, "");
}

/** Values of one property, matched by parsed name so `font` never collects `font-size`. */
function valuesOf(css: string, property: string): string[] {
  return declarations(css)
    .filter((declaration) => declaration.prop === property)
    .map((declaration) => declaration.value.trim());
}

function definedTokens(css: string, prefix: string): Set<string> {
  const pattern = new RegExp(`^--(${prefix}-[a-z0-9-]+)$`);
  const names = new Set<string>();
  for (const declaration of declarations(css)) {
    const name = declaration.prop.match(pattern)?.[1];
    if (name !== undefined) names.add(name);
  }
  return names;
}

function definedTypographyTokens(css: string): Set<string> {
  return new Set(FAMILIES.flatMap((prefix) => [...definedTokens(css, prefix)]));
}

function offTokenValues(css: string, property: string, allowed: RegExp, literals?: Set<string>): string[] {
  return valuesOf(css, property).filter((value) => !allowed.test(value) && !(literals?.has(value) ?? false));
}

function danglingReferences(css: string): string[] {
  const defined = definedTypographyTokens(css);
  const referenced = declarations(css).flatMap((declaration) =>
    [...withoutStrings(declaration.value).matchAll(TOKEN_REFERENCE)]
      .map((match) => match[1])
      .filter((name): name is string => name !== undefined),
  );
  return [...new Set(referenced.filter((name) => !defined.has(name)))];
}

/** Steps named by a role, paired with the role, so a broken edge names both ends. */
function roleEdges(css: string): { role: string; step: string }[] {
  return declarations(css)
    .filter((declaration) => /^--text-[a-z]+$/.test(declaration.prop))
    .flatMap((declaration) => {
      const step = withoutStrings(declaration.value).match(/^var\(\s*--(fs-[a-z0-9-]+)\s*\)$/)?.[1];
      return step === undefined ? [] : [{ role: declaration.prop, step }];
    });
}

function unresolvedRoles(css: string): string[] {
  const steps = definedTokens(css, "fs");
  return roleEdges(css)
    .filter((edge) => !steps.has(edge.step))
    .map((edge) => edge.step);
}

/** Raw steps as declared: the number in the name, and the pixel value it resolves to. */
function rawSteps(css: string): { name: number; px: number }[] {
  return declarations(css).flatMap((declaration) => {
    const name = declaration.prop.match(/^--fs-([0-9]+)$/)?.[1];
    const rem = withoutStrings(declaration.value).match(/^([0-9.]+)rem$/)?.[1];
    if (name === undefined || rem === undefined) return [];
    return [{ name: Number(name), px: Number(rem) * 16 }];
  });
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

  it("resolves every role to a raw step rather than a bare length", () => {
    const roles = declarations(stylesheet).filter((declaration) => /^--text-[a-z]+$/.test(declaration.prop));
    expect(roles.length).toBeGreaterThan(0);
    expect(roleEdges(stylesheet).length).toBe(roles.length);
  });

  it("keeps every raw step on a whole pixel, named after the size it produces", () => {
    const steps = rawSteps(stylesheet);
    expect(steps.length).toBeGreaterThan(0);
    expect(steps.filter((step) => !Number.isInteger(step.px) || step.name !== step.px)).toEqual([]);
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
    expect(rawSteps(css)).toEqual([]);
  });

  it("ignores a step that exists only inside a string", () => {
    const css = ':root { --text-ui: var(--fs-15); }\n.row::after { content: "--fs-15: 0.9375rem;"; }';
    expect(unresolvedRoles(css)).toEqual(["fs-15"]);
    expect(danglingReferences(css)).toEqual(["fs-15"]);
    expect(rawSteps(css)).toEqual([]);
  });

  it("does not read a token reference quoted inside a value", () => {
    const css = ':root { --fs-13: 0.8125rem; }\n.row::after { content: "var(--fs-99)"; }';
    expect(danglingReferences(css)).toEqual([]);
  });

  it("does not read a commented-out declaration as a violation", () => {
    const css = ".row { /* font-size: 0.83rem; */ font-size: var(--text-ui); }";
    expect(offTokenValues(css, "font-size", /^var\(--text-[a-z]+\)$/)).toEqual([]);
  });

  it("does not mistake a longhand for the shorthand it starts with", () => {
    const css = "body { font-size: var(--text-ui); font-synthesis: none; }";
    expect(valuesOf(css, "font")).toEqual([]);
  });
});
