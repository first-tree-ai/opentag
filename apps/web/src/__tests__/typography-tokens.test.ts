import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The stylesheet once carried 35 distinct font sizes and 19 font weights as
 * literals written at the point of use, most of them within a pixel of each
 * other. These tests keep type flowing through the token layer so the scale
 * cannot drift back apart one component at a time.
 */

const stylesheet = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");

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

function referencedTokens(property: string): string[] {
  return declarations(property)
    .map((value) => /^var\(--([a-z0-9-]+)\)$/.exec(value)?.[1])
    .filter((name): name is string => name !== undefined);
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

  it("references only tokens that exist", () => {
    const defined = new Set([
      ...definedTokens("text"),
      ...definedTokens("fw"),
      ...definedTokens("track"),
      ...definedTokens("font"),
    ]);
    const referenced = [
      ...referencedTokens("font-size"),
      ...referencedTokens("font-weight"),
      ...referencedTokens("letter-spacing"),
      ...referencedTokens("font-family"),
    ];
    expect(referenced.filter((name) => !defined.has(name))).toEqual([]);
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

  it("resolves each role to a raw step rather than a bare length", () => {
    const roles = captures(/--text-[a-z]+:\s*([^;]+);/g);
    expect(roles.length).toBeGreaterThan(0);
    expect(roles.filter((value) => !/^var\(--fs-[0-9]+\)$/.test(value))).toEqual([]);
  });
});
