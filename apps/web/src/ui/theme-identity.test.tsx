import { readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { render, screen } from "@testing-library/react";
import postcss, { type Root } from "postcss";
import { afterEach, describe, expect, it } from "vitest";
import { Button, buttonClassName, Dialog } from "./design-system.js";
import { kumoThemeTokens } from "./kumo-theme.tokens.js";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, "..", "..");
const sourceRoot = resolve(webRoot, "src");
const indexHtml = readFileSync(resolve(webRoot, "index.html"), "utf8");
const kumoThemeCss = postcss.parse(readFileSync(resolve(here, "kumo-theme.css"), "utf8"));
const designSystemSource = readFileSync(resolve(here, "design-system.tsx"), "utf8");
const stylesheets = readdirSync(sourceRoot, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith(".css"))
  .map((entry) => ({
    path: relative(sourceRoot, resolve(entry.parentPath, entry.name)).replaceAll("\\", "/"),
    root: postcss.parse(readFileSync(resolve(entry.parentPath, entry.name), "utf8")),
  }));

const THEME_ATTRIBUTE = "data-opentag-theme";
const MODE_ATTRIBUTE = "data-opentag-mode";
const themedRootSelector = `[${THEME_ATTRIBUTE}="opentag"]`;

/** Applies the `<html>` attributes from the static index.html to the test document. */
function applyStaticThemeIdentity(): void {
  const attributes = indexHtml.match(/<html\b([^>]*)>/)?.[1] ?? "";
  for (const match of attributes.matchAll(/([\w-]+)="([^"]*)"/g)) {
    const name = match[1];
    const value = match[2];
    if (!name || value === undefined) continue;
    document.documentElement.setAttribute(name, value);
  }
}

/** Compound selectors only — the ones that can match the root element directly. */
function compoundSelectors(stylesheet: Root): string[] {
  const selectors: string[] = [];
  stylesheet.walkRules((rule) => {
    for (const selector of rule.selectors) {
      if (!selector.includes(" ")) selectors.push(selector);
    }
  });
  return selectors;
}

afterEach(() => {
  for (const name of [THEME_ATTRIBUTE, MODE_ATTRIBUTE, "data-theme", "data-mode", "lang"]) {
    document.documentElement.removeAttribute(name);
  }
});

describe("OpenTag theme identity", () => {
  it("initializes the namespaced theme identity statically in index.html", () => {
    const htmlTag = indexHtml.match(/<html\b[^>]*>/)?.[0] ?? "";
    expect(htmlTag).toContain(`${THEME_ATTRIBUTE}="opentag"`);
    expect(htmlTag).toContain(`${MODE_ATTRIBUTE}="light"`);
    // The generic attributes stay unset: they belong to outside code, never to the app theme.
    expect(htmlTag).not.toMatch(/\sdata-theme[=\s]/);
    expect(htmlTag).not.toMatch(/\sdata-mode[=\s]/);
  });

  it("keys theme state only on the namespaced attributes across application stylesheets", () => {
    expect(stylesheets.length).toBeGreaterThan(0);
    for (const { path, root } of stylesheets) {
      root.walkRules((rule) => {
        for (const selector of rule.selectors) {
          expect(selector, `${path} keys on a generic attribute: ${selector}`).not.toMatch(
            /\[data-(?:theme|mode)[\]=~|^$*]/,
          );
        }
      });
    }
    // The supported scoped dark override keeps its nested form under the namespaced attributes.
    expect(kumoThemeCss.toString()).toContain(`${themedRootSelector} [${MODE_ATTRIBUTE}="dark"]`);
  });

  it("scopes every palette token declaration to the namespaced theme attribute", () => {
    let checked = 0;
    for (const { path, root } of stylesheets) {
      root.walkRules((rule) => {
        let declaresPalette = false;
        rule.walkDecls((declaration) => {
          // The OpenTag palette is the button surfaces; --opentag-logo-*-display flags are layout
          // switches with light defaults on :root, not colors, so they stay out of this scope.
          if (
            declaration.prop === "--brand" ||
            declaration.prop === "--color-kumo-canvas" ||
            declaration.prop.startsWith("--opentag-button-")
          ) {
            declaresPalette = true;
          }
        });
        if (!declaresPalette) return;
        checked += 1;
        for (const selector of rule.selectors) {
          expect(selector, `${path} declares palette tokens outside the theme scope: ${selector}`).toContain(
            themedRootSelector,
          );
        }
      });
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("keeps OpenTag selectors matching the root when the generic theme attributes change", () => {
    applyStaticThemeIdentity();
    const root = document.documentElement;
    const lightSelectors = compoundSelectors(kumoThemeCss).filter(
      (selector) => !selector.includes(`[${MODE_ATTRIBUTE}="dark"]`),
    );
    const darkSelectors = compoundSelectors(kumoThemeCss).filter((selector) =>
      selector.includes(`[${MODE_ATTRIBUTE}="dark"]`),
    );
    expect(lightSelectors.length).toBeGreaterThan(0);
    expect(darkSelectors.length).toBeGreaterThan(0);

    for (const selector of lightSelectors) expect(root.matches(selector), selector).toBe(true);
    for (const selector of darkSelectors) expect(root.matches(selector), selector).toBe(false);

    // Outside code rewriting the generic attributes must not detach or re-mode the app theme.
    root.setAttribute("data-theme", "light");
    root.setAttribute("data-mode", "dark");
    for (const selector of lightSelectors) expect(root.matches(selector), selector).toBe(true);
    for (const selector of darkSelectors) expect(root.matches(selector), selector).toBe(false);
  });

  it("lets body-mounted portals inherit the root theme scope", () => {
    applyStaticThemeIdentity();
    // Even with the generic attributes overwritten, the themed root stays the token ancestor.
    document.documentElement.setAttribute("data-theme", "light");
    render(
      <Dialog title="Theme probe" onClose={() => undefined}>
        <Button>Continue</Button>
      </Dialog>,
    );
    const dialog = screen.getByRole("dialog");
    // jsdom does not compute styles; this asserts the DOM contract that custom-property
    // inheritance relies on: a portal mounted on body still descends from the themed root.
    expect(document.body.contains(dialog)).toBe(true);
    expect(dialog.closest(themedRootSelector)).toBe(document.documentElement);
  });
});

describe("emphasis button fallbacks", () => {
  const emphasisContracts = [
    {
      intent: "primary",
      tokens: [
        ["bg", "buttonBackground"],
        ["gradient-start", "buttonGradientStart"],
        ["gradient-end", "buttonGradientEnd"],
        ["ring", "buttonRing"],
      ],
    },
    {
      intent: "danger",
      tokens: [
        ["bg", "dangerButtonBackground"],
        ["gradient-start", "dangerButtonGradientStart"],
        ["gradient-end", "dangerButtonGradientEnd"],
        ["ring", "dangerButtonRing"],
      ],
    },
  ] as const;

  it("resolves every emphasis custom property with a canonical light-palette fallback", () => {
    render(
      <>
        <Button variant="primary">Create</Button>
        <Button variant="danger">Delete</Button>
      </>,
    );
    const buttons = {
      danger: screen.getByRole("button", { name: "Delete" }),
      primary: screen.getByRole("button", { name: "Create" }),
    } as const;
    for (const { intent, tokens } of emphasisContracts) {
      for (const [slot, tokenName] of tokens) {
        const token = `--opentag-button-${intent}-${slot}`;
        const fallback: string = kumoThemeTokens.light[tokenName];
        // Button sets the override inline; links receive it through buttonClassName instead.
        expect(buttons[intent].style.getPropertyValue(`--kumo-button-emphasis-${slot}`)).toBe(
          `var(${token}, ${fallback})`,
        );
        expect(buttonClassName({ variant: intent })).toContain(
          `[--kumo-button-emphasis-${slot}:var(${token},${fallback})]`,
        );
      }
    }
  });

  it("pins every raw color literal in the adapter to the canonical light palette", () => {
    // Tailwind only scans static class strings, so the buttonClassName fallbacks repeat palette
    // literals; any other raw color in the adapter is a contract breach. The fallback set is
    // exactly the WCAG-verified light button surfaces from the contrast test.
    const paletteValues = new Set<string>(Object.values(kumoThemeTokens.light));
    const literals = designSystemSource.match(/#[\da-f]{6}\b/gi) ?? [];
    expect(literals.length).toBeGreaterThan(0);
    for (const literal of literals) {
      expect(paletteValues.has(literal.toLowerCase()), literal).toBe(true);
    }
  });
});
