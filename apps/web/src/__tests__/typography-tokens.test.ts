import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import postcss, { type Container, type Declaration, type Document, type Rule } from "postcss";
import { describe, expect, it } from "vitest";

/**
 * The stylesheet once carried 35 distinct font sizes and 19 font weights as
 * literals written at the point of use, most of them within a pixel of each
 * other. These tests keep type flowing through the token layer so the scale
 * cannot drift back apart one component at a time.
 *
 * Surfaces that own a density, and the only selectors allowed to retune a
 * role. Anywhere else, a rebinding is component-local drift: the thing this
 * PR removed.
 */
const READING_SURFACES = new Set([".settings-page", ".onboarding-shell", ".decorative-page", ".dialog-card"]);

/*
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

/** The selectors a declaration applies under, or none when it sits outside a rule. */
function selectorsOf(declaration: Declaration): string[] {
  const parent = declaration.parent;
  if (parent === undefined || parent.type !== "rule") return [];
  return (parent as Rule).selector.split(",").map((selector) => selector.trim());
}

/** A declaration wrapped in any at-rule applies only when that condition holds. */
function unconditional(declaration: Declaration): boolean {
  let node: Container | Document | undefined = declaration.parent;
  while (node !== undefined) {
    if (node.type === "atrule") return false;
    node = node.parent;
  }
  return true;
}

/**
 * A custom property exists only where its selector matches and its conditions
 * hold. A step parked under another rule -- or under a media query that a normal
 * viewport never satisfies -- is invisible to a :root role, so the baseline
 * scale has to be declared at an unconditional :root to count as declared.
 */
function atRoot(declaration: Declaration): boolean {
  const selectors = selectorsOf(declaration);
  return unconditional(declaration) && selectors.length > 0 && selectors.every((selector) => selector === ":root");
}

/**
 * The browser decodes identifier escapes before it matches a property name;
 * PostCSS hands them over as written. `f\6f nt-size` is `font-size` to the
 * page, so it has to be `font-size` here too -- and `--text\2d ui` is the
 * `--text-ui` role, not a name of its own.
 */
function decodeIdentifier(name: string): string {
  return name.replace(/\\(?:([0-9a-fA-F]{1,6})[ \t\n\r\f]?|(.))/gs, (_match, hex?: string, literal?: string) => {
    if (hex === undefined) return literal ?? "";
    const code = Number.parseInt(hex, 16);
    const unrepresentable = code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff);
    return unrepresentable ? "\uFFFD" : String.fromCodePoint(code);
  });
}

/** The name a declaration carries once decoded: what the browser matches against. */
function declaredName(declaration: Declaration): string {
  return decodeIdentifier(declaration.prop);
}

/**
 * A quoted run is content, not code: `content: "--fs-15: 0.9375rem"` declares
 * no token and references none, so strings drop out before a value is read.
 */
function withoutStrings(value: string): string {
  return value.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, "");
}

/** Strings go first, then escapes: decoding first could manufacture a quote. */
function readableValue(value: string): string {
  return decodeIdentifier(withoutStrings(value));
}

/** Ordinary property names are ASCII case-insensitive; custom property names are not. */
function propertyName(declaration: Declaration): string {
  const name = declaredName(declaration);
  return name.startsWith("--") ? name : name.toLowerCase();
}

/** Values of one property, matched by parsed name so `font` never collects `font-size`. */
function valuesOf(css: string, property: string): string[] {
  return declarations(css)
    .filter((declaration) => propertyName(declaration) === property)
    .map((declaration) => declaration.value.trim());
}

function definedTokens(css: string, prefix: string): Set<string> {
  const pattern = new RegExp(`^--(${prefix}-[a-z0-9-]+)$`);
  const names = new Set<string>();
  for (const declaration of declarations(css).filter(atRoot)) {
    const name = declaredName(declaration).match(pattern)?.[1];
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
    [...readableValue(declaration.value).matchAll(TOKEN_REFERENCE)]
      .map((match) => match[1])
      .filter((name): name is string => name !== undefined),
  );
  return [...new Set(referenced.filter((name) => !defined.has(name)))];
}

/** Steps named by a role, paired with the role, so a broken edge names both ends. */
function roleEdges(css: string): { role: string; step: string }[] {
  return declarations(css)
    .filter((declaration) => /^--text-[a-z]+$/.test(declaredName(declaration)))
    .flatMap((declaration) => {
      const step = readableValue(declaration.value).match(/^var\(\s*--(fs-[a-z0-9-]+)\s*\)$/)?.[1];
      return step === undefined ? [] : [{ role: declaredName(declaration), step }];
    });
}

function unresolvedRoles(css: string): string[] {
  const steps = definedTokens(css, "fs");
  return roleEdges(css)
    .filter((edge) => !steps.has(edge.step))
    .map((edge) => edge.step);
}

/** Every baseline step declaration, well-formed or not, so none is skipped silently. */
function rootStepDeclarations(css: string): Declaration[] {
  return declarations(css).filter(
    (declaration) => atRoot(declaration) && declaredName(declaration).startsWith("--fs-"),
  );
}

/** A step is a numeric name and a rem value; anything else does not describe one. */
function stepOf(declaration: Declaration): { name: number; px: number } | undefined {
  const name = declaredName(declaration).match(/^--fs-([0-9]+)$/)?.[1];
  const rem = readableValue(declaration.value).match(/^([0-9.]+)rem$/)?.[1];
  if (name === undefined || rem === undefined) return undefined;
  return { name: Number(name), px: Number(rem) * 16 };
}

function rawSteps(css: string): { name: number; px: number }[] {
  return rootStepDeclarations(css).flatMap((declaration) => {
    const step = stepOf(declaration);
    return step === undefined ? [] : [step];
  });
}

function malformedSteps(css: string): string[] {
  return rootStepDeclarations(css)
    .filter((declaration) => stepOf(declaration) === undefined)
    .map((declaration) => `${declaredName(declaration)}: ${declaration.value}`);
}

/**
 * Typography tokens declared somewhere other than :root. A surface may retune a
 * role it inherits; it may not invent a token, because nothing outside that
 * surface could resolve it.
 */
function scopedDefinitions(css: string): { token: string; selectors: string[] }[] {
  const pattern = new RegExp(`^--((?:${FAMILIES.join("|")})-[a-z0-9-]+)$`);
  return declarations(css)
    .filter((declaration) => !atRoot(declaration))
    .flatMap((declaration) => {
      const token = declaredName(declaration).match(pattern)?.[1];
      if (token === undefined) return [];
      return [{ token, selectors: selectorsOf(declaration) }];
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

  it("retunes roles only on the reading surfaces, and never a raw step", () => {
    const roles = definedTokens(stylesheet, "text");
    const stray = scopedDefinitions(stylesheet).filter(
      (definition) =>
        !definition.token.startsWith("text-") ||
        !roles.has(definition.token) ||
        !definition.selectors.every((selector) => READING_SURFACES.has(selector)),
    );
    expect(stray).toEqual([]);
  });

  it("declares every baseline step as a whole-pixel rem, with none skipped", () => {
    expect(malformedSteps(stylesheet)).toEqual([]);
    expect(rawSteps(stylesheet).length).toBe(rootStepDeclarations(stylesheet).length);
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

  it("ignores a step declared under some other selector", () => {
    const css = ":root { --text-ui: var(--fs-13); }\n.dead { --fs-13: 0.8125rem; }";
    expect(unresolvedRoles(css)).toEqual(["fs-13"]);
    expect(danglingReferences(css)).toEqual(["fs-13"]);
    expect(rawSteps(css)).toEqual([]);
    expect(scopedDefinitions(css)).toEqual([{ token: "fs-13", selectors: [".dead"] }]);
  });

  it("accepts a surface that retunes a role :root already declares", () => {
    const css =
      ":root { --fs-13: 0.8125rem; --fs-14: 0.875rem; --text-ui: var(--fs-13); }\n.settings-page { --text-ui: var(--fs-14); }";
    expect(danglingReferences(css)).toEqual([]);
    expect(scopedDefinitions(css)).toEqual([{ token: "text-ui", selectors: [".settings-page"] }]);
  });

  it("reads an upper-case property name, which the browser applies all the same", () => {
    const css = "body { FONT-SIZE: 13px; FONT-FAMILY: Arial; }\n.row { Font: 12px Arial; }";
    expect(offTokenValues(css, "font-size", /^var\(--text-[a-z]+\)$/)).toEqual(["13px"]);
    expect(offTokenValues(css, "font-family", /^var\(--font-[a-z]+\)$/)).toEqual(["Arial"]);
    expect(offTokenValues(css, "font", /^$/, FONT_SHORTHAND_LITERALS)).toEqual(["12px Arial"]);
  });

  it("reports a step that does not describe a step, rather than skipping it", () => {
    const css = ":root { --fs-13: 13.5px; --fs-small: 0.8125rem; --fs-14: 0.875rem; }";
    expect(malformedSteps(css)).toEqual(["--fs-13: 13.5px", "--fs-small: 0.8125rem"]);
    expect(rawSteps(css)).toEqual([{ name: 14, px: 14 }]);
  });

  it("ignores a step declared under a condition a normal viewport never meets", () => {
    const css = ":root { --text-ui: var(--fs-13); }\n@media (width: 0px) { :root { --fs-13: 0.8125rem; } }";
    expect(unresolvedRoles(css)).toEqual(["fs-13"]);
    expect(danglingReferences(css)).toEqual(["fs-13"]);
    expect(rawSteps(css)).toEqual([]);
    expect(scopedDefinitions(css)).toEqual([{ token: "fs-13", selectors: [":root"] }]);
  });

  it("rejects a component that retunes a role it does not own", () => {
    const css =
      ":root { --fs-30: 1.875rem; --text-ui: var(--fs-13); --fs-13: 0.8125rem; }\n.row { --text-ui: var(--fs-30); }";
    const roles = definedTokens(css, "text");
    const stray = scopedDefinitions(css).filter(
      (definition) =>
        !definition.token.startsWith("text-") ||
        !roles.has(definition.token) ||
        !definition.selectors.every((selector) => READING_SURFACES.has(selector)),
    );
    expect(stray).toEqual([{ token: "text-ui", selectors: [".row"] }]);
  });

  it("decodes an escaped ordinary property name the way the browser does", () => {
    const css = String.raw`body { f\6f nt-size: 23px; }`;
    expect(offTokenValues(css, "font-size", /^var\(--text-[a-z]+\)$/)).toEqual(["23px"]);
  });

  it("decodes an escaped custom property name, which names an existing role", () => {
    const css = String.raw`.row { --text\2d ui: var(--fs-30); }`;
    expect(scopedDefinitions(css)).toEqual([{ token: "text-ui", selectors: [".row"] }]);
  });

  it("keeps a decoded custom property name case-sensitive, as CSS defines it", () => {
    const css = String.raw`:root { --TEXT\2d UI: 13px; --text-ui: var(--fs-13); --fs-13: 0.8125rem; }`;
    expect([...definedTokens(css, "text")]).toEqual(["text-ui"]);
  });

  it("refuses a baseline that shares its rule with another selector", () => {
    const css =
      ":root { --fs-13: 0.8125rem; --text-ui: var(--fs-14); --fs-14: 0.875rem; }\n:root, .row { --text-ui: var(--fs-13); }";
    expect(scopedDefinitions(css)).toEqual([{ token: "text-ui", selectors: [":root", ".row"] }]);
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
