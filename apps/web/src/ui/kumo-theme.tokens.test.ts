import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postcss, { type Root } from "postcss";
import { describe, expect, it } from "vitest";
import { kumoThemeTokens } from "./kumo-theme.tokens.js";

const WHITE = "#ffffff";
const DARK_INVERSE_TEXT = "#333333";
const DARK_CANVAS = "#1a1a1a";
const WCAG_AA_NORMAL_TEXT = 4.5;
const stylesheet: Root = postcss.parse(
  readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "kumo-theme.css"), "utf8"),
);

type ThemeMode = keyof typeof kumoThemeTokens;
type ThemeTokenName = keyof (typeof kumoThemeTokens)[ThemeMode];
type RuntimeThemeTokens = Record<ThemeTokenName, string>;

const runtimeVariableByToken = {
  brand: "--color-kumo-brand",
  brandHover: "--color-kumo-brand-hover",
  brandText: "--text-color-kumo-brand",
  buttonBackground: "--opentag-button-primary-bg",
  buttonGradientEnd: "--opentag-button-primary-gradient-end",
  buttonGradientStart: "--opentag-button-primary-gradient-start",
  buttonRing: "--opentag-button-primary-ring",
  dangerButtonBackground: "--opentag-button-danger-bg",
  dangerButtonGradientEnd: "--opentag-button-danger-gradient-end",
  dangerButtonGradientStart: "--opentag-button-danger-gradient-start",
  dangerButtonRing: "--opentag-button-danger-ring",
} satisfies Record<ThemeTokenName, string>;

describe("OpenTag Kumo theme contrast", () => {
  it("keeps the light runtime CSS synced and above WCAG AA", () => {
    const runtime = runtimeThemeTokens("light");
    expect(runtime).toEqual(kumoThemeTokens.light);
    expect(contrast(runtime.brand, WHITE)).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
    expect(contrast(runtime.brandHover, WHITE)).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
    expect(contrast(runtime.brandText, WHITE)).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
    expectButtonSurfacesToPass(runtime);
  });

  it("keeps the dark runtime CSS synced and above WCAG AA", () => {
    const runtime = runtimeThemeTokens("dark");
    expect(runtime).toEqual(kumoThemeTokens.dark);
    expect(contrast(runtime.brand, DARK_INVERSE_TEXT)).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
    expect(contrast(runtime.brandHover, DARK_INVERSE_TEXT)).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
    expect(contrast(runtime.brandText, DARK_CANVAS)).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
    expectButtonSurfacesToPass(runtime);
  });
});

function runtimeThemeTokens(mode: ThemeMode): RuntimeThemeTokens {
  const declarations = new Map<string, string>();
  stylesheet.walkRules((rule) => {
    if (!rule.selectors.some((selector) => selector.includes('[data-theme="opentag"]'))) return;
    const darkRule = rule.selectors.some((selector) => selector.includes('[data-mode="dark"]'));
    if (darkRule !== (mode === "dark")) return;
    rule.walkDecls((declaration) => {
      declarations.set(declaration.prop, declaration.value);
    });
  });
  return Object.fromEntries(
    Object.entries(runtimeVariableByToken).map(([token, variable]) => {
      const value = declarations.get(variable);
      if (!value) throw new Error(`Missing ${variable} for ${mode} mode`);
      return [token, value];
    }),
  ) as RuntimeThemeTokens;
}

function expectButtonSurfacesToPass(tokens: RuntimeThemeTokens): void {
  for (const color of [
    tokens.buttonBackground,
    tokens.buttonGradientStart,
    tokens.buttonGradientEnd,
    tokens.dangerButtonBackground,
    tokens.dangerButtonGradientStart,
    tokens.dangerButtonGradientEnd,
  ]) {
    expect(contrast(color, WHITE)).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
  }
}

function contrast(left: string, right: string): number {
  const brighter = Math.max(luminance(left), luminance(right));
  const darker = Math.min(luminance(left), luminance(right));
  return (brighter + 0.05) / (darker + 0.05);
}

function luminance(hex: string): number {
  const channels = hex
    .slice(1)
    .match(/.{2}/g)
    ?.map((channel) => Number.parseInt(channel, 16) / 255)
    .map((channel) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
  if (channels?.length !== 3) throw new Error(`Invalid color: ${hex}`);
  const [red, green, blue] = channels as [number, number, number];
  return red * 0.2126 + green * 0.7152 + blue * 0.0722;
}
