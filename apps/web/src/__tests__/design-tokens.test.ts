import { describe, expect, it } from "vitest";
import {
  atRoot,
  type Declared,
  danglingReferences,
  declarations,
  type Exception,
  escapedValues,
  propertyName,
  readStylesheet,
  scopedDefinitions,
} from "./support/stylesheet";

/**
 * Radius, elevation and motion, held to the same rule as type: a value that
 * carries a design decision resolves through a token, and the exceptions name
 * where they apply.
 *
 * Before this, the stylesheet had 17 radius literals for what is five steps,
 * five shadows with five different formulations across three shadow hues, and
 * three transition durations 10ms apart.
 */

const stylesheet = readStylesheet();

/** Every family a design token may belong to. A reference outside this set is a typo. */
const FAMILIES = ["fs", "text", "fw", "track", "font", "lh", "radius", "shadow", "motion", "ease", "layer"] as const;

/**
 * The computer icon is drawn with two nested boxes rather than an asset, so its
 * corners are part of the drawing at that size -- not a step anyone should
 * reuse. Like the geometric line heights, the exception names where it applies.
 */
const EXCEPTIONS: Exception[] = [
  { property: "border-radius", value: "3px", selectors: new Set([".settings-computer-icon"]) },
  { property: "border-radius", value: "2px", selectors: new Set([".settings-computer-icon::after"]) },
];

function excepted(declaration: Declared, property: string): boolean {
  return EXCEPTIONS.some(
    (exception) =>
      exception.property === property &&
      exception.value === declaration.value &&
      declaration.selectors.length > 0 &&
      declaration.selectors.every((selector) => exception.selectors.has(selector)),
  );
}

const TOKEN_REFERENCE = /var\(\s*--[a-z0-9-]+\s*\)/g;

/**
 * What is left of a value once its token references are removed. A shorthand
 * composes several -- `var(--radius-md) 0 0 var(--radius-md)` is four corners --
 * so a value cannot be matched whole; what matters is that nothing carrying a
 * decision survives the removal.
 */
function residue(declaration: Declared): string[] {
  return declaration.value.replace(TOKEN_REFERENCE, " ").trim().split(/\s+/).filter(Boolean);
}

/** Values of one property that still carry something the token layer should own. */
function untokenized(css: string, property: string, inert: ReadonlySet<string>): string[] {
  return declarations(css)
    .filter((declaration) => propertyName(declaration) === property)
    .filter((declaration) => !excepted(declaration, property))
    .filter((declaration) => !residue(declaration).every((word) => inert.has(word)))
    .map((declaration) => `${declaration.name}: ${declaration.value}`);
}

/**
 * A duration or an easing written into a transition is a decision made twice.
 * Property names are ordinary words in these values, so the residue is read for
 * what a decision looks like rather than for what is left over.
 */
const TIME = /\d+(\.\d+)?\s*m?s\b/;
const EASING = /\b(ease|ease-in|ease-out|ease-in-out|linear|step-start|step-end|steps|cubic-bezier)\b/;

function untokenizedMotion(css: string, property: string): string[] {
  return declarations(css)
    .filter((declaration) => propertyName(declaration) === property)
    .filter((declaration) => {
      const rest = declaration.value.replace(TOKEN_REFERENCE, " ");
      return TIME.test(rest) || EASING.test(rest);
    })
    .map((declaration) => `${declaration.name}: ${declaration.value}`);
}

/** Baseline definitions of one family, by the name the browser resolves. */
function baselineTokens(css: string, family: string): string[] {
  return declarations(css)
    .filter((declaration) => atRoot(declaration) && declaration.name.startsWith(`--${family}-`))
    .map((declaration) => declaration.name);
}

describe("radius, elevation and motion tokens", () => {
  it("resolves every corner through a --radius-* token", () => {
    expect(untokenized(stylesheet, "border-radius", new Set(["0"]))).toEqual([]);
  });

  it("resolves every shadow through a --shadow-* token", () => {
    expect(untokenized(stylesheet, "box-shadow", new Set(["none"]))).toEqual([]);
  });

  it("writes no duration or easing into a transition or an animation", () => {
    expect(untokenizedMotion(stylesheet, "transition")).toEqual([]);
    expect(untokenizedMotion(stylesheet, "animation")).toEqual([]);
  });

  it("declares the three scales at the baseline", () => {
    expect(baselineTokens(stylesheet, "radius").length).toBeGreaterThan(0);
    expect(baselineTokens(stylesheet, "shadow").length).toBeGreaterThan(0);
    expect(baselineTokens(stylesheet, "motion").length).toBeGreaterThan(0);
  });

  it("draws every shadow in one colour, so elevation reads as one system", () => {
    const shadows = declarations(stylesheet).filter(
      (declaration) =>
        atRoot(declaration) && declaration.name.startsWith("--shadow-") && declaration.name !== "--shadow-color",
    );
    expect(shadows.length).toBeGreaterThan(0);
    expect(shadows.filter((declaration) => !declaration.value.includes("var(--shadow-color)"))).toEqual([]);
  });

  it("keeps radius, elevation and motion out of surface rebindings", () => {
    const scoped = scopedDefinitions(stylesheet, ["radius", "shadow", "motion", "ease"]);
    expect(scoped).toEqual([]);
  });
});

describe("every design token", () => {
  it("is referenced only where it exists", () => {
    expect(danglingReferences(stylesheet, FAMILIES)).toEqual([]);
  });

  it("is spelled without escapes outside a string", () => {
    expect(escapedValues(stylesheet)).toEqual([]);
  });
});

describe("the guard itself", () => {
  it("rejects a literal corner", () => {
    const css = ".row { border-radius: 11px; }";
    expect(untokenized(css, "border-radius", new Set(["0"]))).toEqual(["border-radius: 11px"]);
  });

  it("accepts a corner composed of tokens, and a plain reset", () => {
    const css = ".row { border-radius: var(--radius-md) 0 0 var(--radius-md); }\n.flat { border-radius: 0; }";
    expect(untokenized(css, "border-radius", new Set(["0"]))).toEqual([]);
  });

  it("rejects a literal hiding among tokens in a shorthand", () => {
    const css = ".row { border-radius: var(--radius-md) 11px 0 var(--radius-md); }";
    expect(untokenized(css, "border-radius", new Set(["0"]))).toEqual([
      "border-radius: var(--radius-md) 11px 0 var(--radius-md)",
    ]);
  });

  it("holds the icon exception to the selectors that earn it", () => {
    const granted = ".settings-computer-icon { border-radius: 3px; }";
    expect(untokenized(granted, "border-radius", new Set(["0"]))).toEqual([]);

    const elsewhere = ".card { border-radius: 3px; }";
    expect(untokenized(elsewhere, "border-radius", new Set(["0"]))).toEqual(["border-radius: 3px"]);

    const widened = ".settings-computer-icon, .card { border-radius: 3px; }";
    expect(untokenized(widened, "border-radius", new Set(["0"]))).toEqual(["border-radius: 3px"]);
  });

  it("rejects a literal shadow, and accepts none", () => {
    const literal = ".card { box-shadow: 0 1px 4px rgb(22 33 27 / 8%); }";
    expect(untokenized(literal, "box-shadow", new Set(["none"]))).toEqual(["box-shadow: 0 1px 4px rgb(22 33 27 / 8%)"]);
    expect(untokenized(".card { box-shadow: none; }", "box-shadow", new Set(["none"]))).toEqual([]);
  });

  it("rejects a duration or an easing written by hand", () => {
    const duration = ".row { transition: background-color 130ms var(--ease-standard); }";
    expect(untokenizedMotion(duration, "transition")).toEqual([
      "transition: background-color 130ms var(--ease-standard)",
    ]);

    const easing = ".row { transition: background-color var(--motion-fast) ease-in-out; }";
    expect(untokenizedMotion(easing, "transition")).toEqual([
      "transition: background-color var(--motion-fast) ease-in-out",
    ]);
  });

  it("accepts a fully tokenized transition, and the reduced-motion reset", () => {
    const css =
      ".row { transition: background-color var(--motion-fast) var(--ease-standard); }\n.still { transition: none; }";
    expect(untokenizedMotion(css, "transition")).toEqual([]);
  });

  it("does not mistake a property name for an easing keyword", () => {
    const css = ".row { transition: border-color var(--motion-fast) var(--ease-standard); }";
    expect(untokenizedMotion(css, "transition")).toEqual([]);
  });

  it("reports a reference to a token no baseline declares", () => {
    const css = ":root { --radius-md: 9px; }\n.row { border-radius: var(--radius-lg); }";
    expect(danglingReferences(css, FAMILIES)).toEqual(["radius-lg"]);
  });
});
