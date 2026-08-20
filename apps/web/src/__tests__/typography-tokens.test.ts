import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The stylesheet once carried 35 distinct font sizes and 19 font weights as
 * literals written at the point of use, most of them within a pixel of each
 * other. These tests keep type flowing through the token layer so the scale
 * cannot drift back apart one component at a time.
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

/** Every typography token reference, wherever it appears — including one role pointing at another. */
const TOKEN_REFERENCE = /var\(--((?:fs|text|fw|track|font)-[a-z0-9-]+)\)/g;

function captures(pattern: RegExp, group = 1): string[] {
  return [...stylesheet.matchAll(pattern)]
    .map((match) => match[group])
    .filter((value): value is string => value !== undefined)
    .map((value) => value.trim());
}

function declarations(property: string): string[] {
  return captures(new RegExp(`(?<![\\w-])${property}:\\s*([^;]+);`, "g"));
}

function definedTokens(prefix: string): Set<string> {
  return new Set(captures(new RegExp(`--(${prefix}-[a-z0-9-]+):`, "g")));
}

function definedTypographyTokens(): Set<string> {
  return new Set(["fs", "text", "fw", "track", "font"].flatMap((prefix) => [...definedTokens(prefix)]));
}

describe("typography tokens", () => {
  it("declares every font size through a --text-* role", () => {
    const literals = declarations("font-size").filter((value) => !/^var\(--text-[a-z]+\)$/.test(value));
    expect(literals).toEqual([]);
  });

  it("declares every font weight through a --fw-* token", () => {
    const literals = declarations("font-weight").filter((value) => !/^var\(--fw-[a-z]+\)$/.test(value));
    expect(literals).toEqual([]);
  });

  it("declares every letter spacing through a --track-* token", () => {
    const literals = declarations("letter-spacing").filter((value) => !/^var\(--track-[a-z]+\)$/.test(value));
    expect(literals).toEqual([]);
  });

  it("references only tokens that exist, including one role pointing at a step", () => {
    const defined = definedTypographyTokens();
    const dangling = captures(TOKEN_REFERENCE).filter((name) => !defined.has(name));
    expect([...new Set(dangling)]).toEqual([]);
  });

  it("keeps every raw step on a whole pixel", () => {
    const steps = captures(/--fs-[0-9]+:\s*([0-9.]+)rem;/g).map((value) => Number(value) * 16);
    expect(steps.length).toBeGreaterThan(0);
    expect(steps.filter((px) => !Number.isInteger(px))).toEqual([]);
  });

  it("names each step after the pixel size it produces", () => {
    const named = captures(/--fs-([0-9]+):\s*([0-9.]+)rem;/g);
    const values = captures(/--fs-([0-9]+):\s*([0-9.]+)rem;/g, 2);
    const mismatched = named.filter((name, index) => Number(name) !== Number(values[index]) * 16);
    expect(mismatched).toEqual([]);
  });

  it("resolves each role to a step that is actually declared", () => {
    const steps = definedTokens("fs");
    const unresolved = captures(/--text-[a-z]+:\s*var\(--(fs-[a-z0-9-]+)\);/g).filter((step) => !steps.has(step));
    expect(unresolved).toEqual([]);
  });

  it("resolves each role to a raw step rather than a bare length", () => {
    const roles = captures(/--text-[a-z]+:\s*([^;]+);/g);
    expect(roles.length).toBeGreaterThan(0);
    expect(roles.filter((value) => !/^var\(--fs-[0-9]+\)$/.test(value))).toEqual([]);
  });
});
