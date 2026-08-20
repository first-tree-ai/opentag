import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import postcss, { type Container, type Declaration, type Document, type Rule } from "postcss";

/**
 * The parse layer the stylesheet guards share.
 *
 * Every check reads parsed declarations rather than raw text. Matching CSS with
 * regular expressions cost the typography guard several holes in review -- the
 * `font` shorthand read as a longhand, a token defined only inside a comment,
 * one quoted inside a value, an escaped identifier read as written -- so the
 * parser draws those boundaries here, once, for every dimension that follows.
 */

/** The suites run from apps/web and, under the coverage config, from the repo root. */
export function locateStylesheet(): string {
  for (const candidate of ["src/styles.css", "apps/web/src/styles.css"]) {
    const path = resolve(process.cwd(), candidate);
    if (existsSync(path)) return path;
  }
  throw new Error(`The Web stylesheet was not found from ${process.cwd()}`);
}

export function readStylesheet(): string {
  return readFileSync(locateStylesheet(), "utf8");
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
    return unrepresentable ? "�" : String.fromCodePoint(code);
  });
}

/**
 * A quoted run is content, not code: `content: "--fs-15: 0.9375rem"` declares
 * no token and references none, so strings drop out before a value is read.
 * Strings are ignorable when looking for token references, and only then: to
 * the browser a quoted run is still part of the value it validates.
 */
function referenceProjection(value: string): string {
  return value.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, "");
}

/**
 * What the browser sees: the decoded name, the value exactly as the browser
 * validates it, where it applies, and whether it applies unconditionally.
 *
 * `references` is that value with quoted runs dropped, and is for finding
 * var() references and nothing else. Validating against it would accept
 * `font-size: "poison" var(--text-ui)`, which the browser throws out.
 *
 * Values are recorded as written. A name is one identifier, so decoding it is
 * exact; a value is a sequence of tokens, and CSS resolves escapes inside the
 * token being consumed rather than across it -- `var\28--text-ui\29` is a
 * single identifier, not a call. Rather than reimplement value tokenization to
 * tell those apart, `escapedValues` refuses escapes outright.
 *
 * PostCSS nodes stop here on purpose -- twice, a check reached past the decoder
 * to the name as written and let an escaped declaration through, so the
 * spelling is no longer reachable from any guard.
 */
export type Declared = {
  name: string;
  value: string;
  references: string;
  selectors: string[];
  unconditional: boolean;
};

/** Comments parse as their own nodes, so only declarations the browser applies reach any check. */
export function declarations(css: string): Declared[] {
  const found: Declared[] = [];
  postcss.parse(css).walkDecls((declaration) => {
    found.push({
      name: decodeIdentifier(declaration.prop),
      value: declaration.value.trim(),
      references: referenceProjection(declaration.value),
      selectors: selectorsOf(declaration),
      unconditional: unconditional(declaration),
    });
  });
  return found;
}

/** A baseline definition applies everywhere: unconditional, and :root alone. */
export function atRoot(declaration: Declared): boolean {
  return (
    declaration.unconditional &&
    declaration.selectors.length > 0 &&
    declaration.selectors.every((selector) => selector === ":root")
  );
}

/** Ordinary property names are ASCII case-insensitive; custom property names are not. */
export function propertyName(declaration: Declared): string {
  const name = declaration.name;
  return name.startsWith("--") ? name : name.toLowerCase();
}

/** Values of one property, matched by parsed name so `font` never collects `font-size`. */
export function valuesOf(css: string, property: string): string[] {
  return declarations(css)
    .filter((declaration) => propertyName(declaration) === property)
    .map((declaration) => declaration.value);
}

/** Tokens of one family declared at the baseline, by the name the browser resolves. */
export function definedTokens(css: string, prefix: string): Set<string> {
  const pattern = new RegExp(`^--(${prefix}-[a-z0-9-]+)$`);
  const names = new Set<string>();
  for (const declaration of declarations(css).filter(atRoot)) {
    const name = declaration.name.match(pattern)?.[1];
    if (name !== undefined) names.add(name);
  }
  return names;
}

/**
 * A declaration allowed to stand outside the token layer, pinned to the
 * selectors that earn it. A value alone is not the exception -- `line-height: 1`
 * centres a single glyph in its own line box, which is true of a chevron and
 * not of a paragraph -- so an exception names the property, the value, and
 * where it applies.
 */
export type Exception = { property: string; value: string; selectors: Set<string> };

/** An exception holds only where it was granted: same property, same value, and no other selector. */
function excepted(declaration: Declared, property: string, exceptions: readonly Exception[]): boolean {
  return exceptions.some(
    (exception) =>
      exception.property === property &&
      exception.value === declaration.value &&
      declaration.selectors.length > 0 &&
      declaration.selectors.every((selector) => exception.selectors.has(selector)),
  );
}

export function offTokenValues(
  css: string,
  property: string,
  allowed: RegExp,
  exceptions: readonly Exception[] = [],
): string[] {
  return declarations(css)
    .filter((declaration) => propertyName(declaration) === property)
    .filter((declaration) => !allowed.test(declaration.value) && !excepted(declaration, property, exceptions))
    .map((declaration) => declaration.value);
}

/**
 * An escape inside a value changes which tokens the browser consumes, so the
 * text stops meaning what it looks like. References are read from every
 * declaration, not only the ones a guard owns, so every declaration has to be
 * canonical for that scan to be worth anything -- outside strings, where a
 * backslash is ordinary content and no reference is read. The stylesheet has
 * never contained one.
 */
export function escapedValues(css: string): string[] {
  return declarations(css)
    .filter((declaration) => declaration.references.includes("\\"))
    .map((declaration) => `${declaration.name}: ${declaration.value}`);
}

/** Every reference to a token of the given families that no baseline declares. */
export function danglingReferences(css: string, families: readonly string[]): string[] {
  const defined = new Set(families.flatMap((family) => [...definedTokens(css, family)]));
  const pattern = new RegExp(`var\\(\\s*--((?:${families.join("|")})-[a-z0-9-]+)`, "g");
  const referenced = declarations(css).flatMap((declaration) =>
    [...declaration.references.matchAll(pattern)]
      .map((match) => match[1])
      .filter((name): name is string => name !== undefined),
  );
  return [...new Set(referenced.filter((name) => !defined.has(name)))];
}

/**
 * Tokens of the given families declared somewhere other than the baseline. A
 * surface may retune a role it inherits; it may not invent a token, because
 * nothing outside that surface could resolve it.
 */
export function scopedDefinitions(css: string, families: readonly string[]): { token: string; selectors: string[] }[] {
  const pattern = new RegExp(`^--((?:${families.join("|")})-[a-z0-9-]+)$`);
  return declarations(css)
    .filter((declaration) => !atRoot(declaration))
    .flatMap((declaration) => {
      const token = declaration.name.match(pattern)?.[1];
      if (token === undefined) return [];
      return [{ token, selectors: declaration.selectors }];
    });
}
