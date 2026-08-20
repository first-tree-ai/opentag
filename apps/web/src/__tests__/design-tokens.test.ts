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
 * carries a design decision resolves through a token of the family that owns
 * that decision, and the exceptions name where they apply.
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

/**
 * A property is owned by the family that answers for it. Ownership is matched
 * by shape rather than by a list of property names: every corner property ends
 * in `-radius`, physical and logical alike, and a longhand nobody has heard of
 * yet still fails closed instead of slipping past an enumeration.
 */
type Owner = { owns: (property: string) => boolean; families: string[]; inert: ReadonlySet<string> };

const RADIUS: Owner = {
  owns: (property) => /(^|-)radius$/.test(property),
  families: ["radius"],
  inert: new Set(["0"]),
};

const SHADOW: Owner = {
  owns: (property) => /(^|-)shadow$/.test(property),
  families: ["shadow"],
  inert: new Set(["none"]),
};

/**
 * `filter: drop-shadow(...)` draws an elevation that no --shadow-* token can
 * describe, because drop-shadow takes no spread and cannot accept a composed
 * token. Rather than teach the guard a second shadow grammar, the stylesheet
 * does not use it -- and may not start.
 *
 * The scan reads every declaration rather than the filter properties, because
 * `--depth: drop-shadow(...)` followed by `filter: var(--depth)` applies after
 * substitution while neither declaration alone looks like a filtered shadow.
 * Strings are dropped first: a quoted drop-shadow draws nothing.
 */
function droppedShadows(css: string): string[] {
  return declarations(css)
    .filter((declaration) => /drop-shadow\s*\(/i.test(declaration.references))
    .map((declaration) => `${declaration.name}: ${declaration.value}`);
}

/**
 * A longhand names one grammar, so it answers to one family: the browser
 * cannot read a duration as an easing or the reverse. Only the shorthands,
 * which carry both, accept both.
 */
const MOTION_SHORTHAND: Owner = {
  owns: (property) => property === "transition" || property === "animation",
  families: ["motion", "ease"],
  inert: new Set(),
};

const MOTION_TIME: Owner = {
  owns: (property) => /^(transition|animation)-(duration|delay)$/.test(property),
  families: ["motion"],
  inert: new Set(),
};

const MOTION_EASING: Owner = {
  owns: (property) => /^(transition|animation)-timing-function$/.test(property),
  families: ["ease"],
  inert: new Set(),
};

const MOTION_OWNERS = [MOTION_SHORTHAND, MOTION_TIME, MOTION_EASING];

/**
 * References to the families that own this property. Erasing every `var(--...)`
 * instead would accept `--corner: 11px; border-radius: var(--corner)`, which is
 * the component-local source of truth this whole change removes.
 */
function ownedReferences(owner: Owner): RegExp {
  return new RegExp(`var\\(\\s*--(?:${owner.families.join("|")})-[a-z0-9-]+\\s*\\)`, "g");
}

/** Values of an owned property still carrying something the token layer should own. */
function untokenized(css: string, owner: Owner): string[] {
  return declarations(css)
    .filter((declaration) => owner.owns(propertyName(declaration)))
    .filter((declaration) => !excepted(declaration, propertyName(declaration)))
    .filter((declaration) => {
      const residue = declaration.value.replace(ownedReferences(owner), " ").trim().split(/\s+/).filter(Boolean);
      return !residue.every((word) => owner.inert.has(word));
    })
    .map((declaration) => `${declaration.name}: ${declaration.value}`);
}

/**
 * What a motion value may still say once its own tokens are removed: the
 * property or animation it applies to, and plain keywords like `infinite` or
 * `none`. Bare identifiers, in other words, and the commas between them.
 *
 * Radius and elevation are checked by listing what may remain; motion used to
 * be checked by listing what may not, and that asymmetry was the hole --
 * `calc(var(--motion-fast) * 2)` leaves `calc( * 2)`, which is not a literal
 * time, an easing keyword or a foreign variable, and derives a duration
 * outside the scale anyway. Naming what is allowed also covers the arithmetic,
 * the units and the functions nobody thought to forbid.
 *
 * Function names and keywords are ASCII case-insensitive to the browser, so
 * `EASE-IN-OUT` eases exactly like its lower-case spelling. Custom property
 * names are not, which is why the reference patterns stay case-sensitive:
 * `--RADIUS-MD` really is a different token.
 */
const IDENTIFIER = /^([a-z-]+,?|,)$/i;
const EASING = /\b(ease|ease-in|ease-out|ease-in-out|linear|step-start|step-end|steps|cubic-bezier)\b/i;

function untokenizedMotion(css: string): string[] {
  return declarations(css).flatMap((declaration) => {
    const owner = MOTION_OWNERS.find((candidate) => candidate.owns(propertyName(declaration)));
    if (owner === undefined) return [];
    const residue = declaration.value.replace(ownedReferences(owner), " ");
    const words = residue.trim().split(/\s+/).filter(Boolean);
    const derived = words.some((word) => !IDENTIFIER.test(word));
    if (!derived && !EASING.test(residue)) return [];
    return [`${declaration.name}: ${declaration.value}`];
  });
}

/**
 * One elevation layer: offsets and blur as lengths, and its colour drawn from
 * the single shadow hue. Checking that a token merely mentions --shadow-color
 * would accept a second hue sitting beside it.
 */
const SHADOW_LAYER = /^(inset\s+)?((-?[0-9.]+px|0)\s+){2,4}rgb\(var\(--shadow-color\)\s*\/\s*[0-9.]+%\)$/;

function elevationTokens(css: string): Declared[] {
  return declarations(css).filter(
    (declaration) =>
      atRoot(declaration) && declaration.name.startsWith("--shadow-") && declaration.name !== "--shadow-color",
  );
}

function malformedElevations(css: string): string[] {
  return elevationTokens(css)
    .filter((declaration) =>
      declaration.value
        .split(",")
        .map((layer) => layer.trim())
        .some((layer) => !SHADOW_LAYER.test(layer)),
    )
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
    expect(untokenized(stylesheet, RADIUS)).toEqual([]);
  });

  it("resolves every shadow through a --shadow-* token", () => {
    expect(untokenized(stylesheet, SHADOW)).toEqual([]);
  });

  it("writes no duration, easing or foreign variable into a transition or an animation", () => {
    expect(untokenizedMotion(stylesheet)).toEqual([]);
  });

  it("declares the three scales at the baseline", () => {
    expect(baselineTokens(stylesheet, "radius").length).toBeGreaterThan(0);
    expect(baselineTokens(stylesheet, "shadow").length).toBeGreaterThan(0);
    expect(baselineTokens(stylesheet, "motion").length).toBeGreaterThan(0);
  });

  it("draws no elevation with a filter", () => {
    expect(droppedShadows(stylesheet)).toEqual([]);
  });

  it("draws every elevation layer in the one shadow colour", () => {
    expect(elevationTokens(stylesheet).length).toBeGreaterThan(0);
    expect(malformedElevations(stylesheet)).toEqual([]);
  });

  it("keeps radius, elevation and motion out of surface rebindings", () => {
    expect(scopedDefinitions(stylesheet, ["radius", "shadow", "motion", "ease"])).toEqual([]);
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
    expect(untokenized(".row { border-radius: 11px; }", RADIUS)).toEqual(["border-radius: 11px"]);
  });

  it("accepts a corner composed of tokens, and a plain reset", () => {
    const css = ".row { border-radius: var(--radius-md) 0 0 var(--radius-md); }\n.flat { border-radius: 0; }";
    expect(untokenized(css, RADIUS)).toEqual([]);
  });

  it("rejects a literal hiding among tokens in a shorthand", () => {
    const css = ".row { border-radius: var(--radius-md) 11px 0 var(--radius-md); }";
    expect(untokenized(css, RADIUS)).toEqual(["border-radius: var(--radius-md) 11px 0 var(--radius-md)"]);
  });

  it("rejects a component-local variable standing in for a token", () => {
    const corner = ".row { --corner: 11px; border-radius: var(--corner); }";
    expect(untokenized(corner, RADIUS)).toEqual(["border-radius: var(--corner)"]);

    const depth = ".deep { --depth: 0 1px 4px red; box-shadow: var(--depth); }";
    expect(untokenized(depth, SHADOW)).toEqual(["box-shadow: var(--depth)"]);

    const timing = ".slow { transition: opacity var(--pace) var(--curve); }";
    expect(untokenizedMotion(timing)).toEqual(["transition: opacity var(--pace) var(--curve)"]);
  });

  it("rejects a token borrowed from the wrong family", () => {
    const css = ".row { border-radius: var(--shadow-raised); }";
    expect(untokenized(css, RADIUS)).toEqual(["border-radius: var(--shadow-raised)"]);
  });

  it("reads the corner longhands, physical and logical alike", () => {
    const physical = ".row { border-top-left-radius: 11px; }";
    expect(untokenized(physical, RADIUS)).toEqual(["border-top-left-radius: 11px"]);

    const logical = ".row { border-start-start-radius: 11px; }";
    expect(untokenized(logical, RADIUS)).toEqual(["border-start-start-radius: 11px"]);
  });

  it("rejects a drop shadow reached through a variable", () => {
    const css = ".row { --depth: drop-shadow(0 1px 4px red); filter: var(--depth); }";
    expect(droppedShadows(css)).toEqual(["--depth: drop-shadow(0 1px 4px red)"]);
  });

  it("rejects a duration derived from a token", () => {
    const longhand = ".row { transition-duration: calc(var(--motion-fast) * 2); }";
    expect(untokenizedMotion(longhand)).toEqual(["transition-duration: calc(var(--motion-fast) * 2)"]);

    const shorthand = ".row { transition: opacity calc(var(--motion-fast) * 2) var(--ease-standard); }";
    expect(untokenizedMotion(shorthand)).toEqual([
      "transition: opacity calc(var(--motion-fast) * 2) var(--ease-standard)",
    ]);
  });

  it("reads a function name in any case, as the browser does", () => {
    expect(droppedShadows(".row { filter: DROP-SHADOW(0 1px 4px red); }")).toEqual([
      "filter: DROP-SHADOW(0 1px 4px red)",
    ]);
    expect(untokenizedMotion(".row { transition-duration: 130MS; }")).toEqual(["transition-duration: 130MS"]);
    expect(untokenizedMotion(".row { transition: opacity var(--motion-fast) EASE-IN-OUT; }")).toEqual([
      "transition: opacity var(--motion-fast) EASE-IN-OUT",
    ]);
  });

  it("leaves a quoted drop-shadow alone, since it draws nothing", () => {
    expect(droppedShadows('.row::after { content: "drop-shadow(0 1px 4px red)"; }')).toEqual([]);
  });

  it("holds each motion longhand to the one family its grammar accepts", () => {
    const asDuration = ".row { transition-duration: var(--ease-standard); }";
    expect(untokenizedMotion(asDuration)).toEqual(["transition-duration: var(--ease-standard)"]);

    const asEasing = ".row { transition-timing-function: var(--motion-fast); }";
    expect(untokenizedMotion(asEasing)).toEqual(["transition-timing-function: var(--motion-fast)"]);

    const correct =
      ".row { transition-duration: var(--motion-fast); transition-timing-function: var(--ease-standard); }";
    expect(untokenizedMotion(correct)).toEqual([]);
  });

  it("reads the motion longhands", () => {
    const css = ".row { transition-duration: 130ms; transition-timing-function: ease-in-out; transition-delay: 40ms; }";
    expect(untokenizedMotion(css)).toEqual([
      "transition-duration: 130ms",
      "transition-timing-function: ease-in-out",
      "transition-delay: 40ms",
    ]);
  });

  it("reads text-shadow as elevation too", () => {
    expect(untokenized(".row { text-shadow: 0 1px 2px red; }", SHADOW)).toEqual(["text-shadow: 0 1px 2px red"]);
  });

  it("holds the icon exception to the selectors that earn it", () => {
    expect(untokenized(".settings-computer-icon { border-radius: 3px; }", RADIUS)).toEqual([]);
    expect(untokenized(".card { border-radius: 3px; }", RADIUS)).toEqual(["border-radius: 3px"]);
    expect(untokenized(".settings-computer-icon, .card { border-radius: 3px; }", RADIUS)).toEqual([
      "border-radius: 3px",
    ]);
  });

  it("rejects a literal shadow, and accepts none", () => {
    const literal = ".card { box-shadow: 0 1px 4px rgb(22 33 27 / 8%); }";
    expect(untokenized(literal, SHADOW)).toEqual(["box-shadow: 0 1px 4px rgb(22 33 27 / 8%)"]);
    expect(untokenized(".card { box-shadow: none; }", SHADOW)).toEqual([]);
  });

  it("rejects an elevation drawn with a filter", () => {
    const css = ".row { filter: drop-shadow(0 1px 4px red); }";
    expect(droppedShadows(css)).toEqual(["filter: drop-shadow(0 1px 4px red)"]);

    const backdrop = ".row { backdrop-filter: blur(4px) drop-shadow(0 1px 4px red); }";
    expect(droppedShadows(backdrop)).toEqual(["backdrop-filter: blur(4px) drop-shadow(0 1px 4px red)"]);
  });

  it("leaves a filter that draws no elevation alone", () => {
    expect(droppedShadows(".row { filter: blur(4px); }")).toEqual([]);
  });

  it("rejects a second hue sitting beside the shadow colour", () => {
    const css = ":root { --shadow-raised: 0 1px 4px red, 0 1px 4px rgb(var(--shadow-color) / 8%); }";
    expect(malformedElevations(css)).toEqual([
      "--shadow-raised: 0 1px 4px red, 0 1px 4px rgb(var(--shadow-color) / 8%)",
    ]);
  });

  it("accepts a two-layer elevation drawn in one colour", () => {
    const css =
      ":root { --shadow-overlay: 0 1px 2px rgb(var(--shadow-color) / 6%), 0 12px 32px rgb(var(--shadow-color) / 10%); }";
    expect(malformedElevations(css)).toEqual([]);
  });

  it("accepts a fully tokenized transition, and the reduced-motion reset", () => {
    const css =
      ".row { transition: background-color var(--motion-fast) var(--ease-standard); }\n.still { transition: none; }";
    expect(untokenizedMotion(css)).toEqual([]);
  });

  it("does not mistake a property name for an easing keyword", () => {
    const css = ".row { transition: border-color var(--motion-fast) var(--ease-standard); }";
    expect(untokenizedMotion(css)).toEqual([]);
  });

  it("reports a reference to a token no baseline declares", () => {
    const css = ":root { --radius-md: 9px; }\n.row { border-radius: var(--radius-lg); }";
    expect(danglingReferences(css, FAMILIES)).toEqual(["radius-lg"]);
  });
});
