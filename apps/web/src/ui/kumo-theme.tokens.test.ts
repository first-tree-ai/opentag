import { describe, expect, it } from "vitest";
import { kumoThemeTokens } from "./kumo-theme.tokens.js";

const WHITE = "#ffffff";
const DARK_INVERSE_TEXT = "#333333";
const DARK_CANVAS = "#1a1a1a";
const WCAG_AA_NORMAL_TEXT = 4.5;

describe("OpenTag Kumo theme contrast", () => {
  it("keeps light brand text and emphasis backgrounds above WCAG AA", () => {
    expect(contrast(kumoThemeTokens.light.brand, WHITE)).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
    expect(contrast(kumoThemeTokens.light.brandHover, WHITE)).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
    expect(contrast(kumoThemeTokens.light.brandText, WHITE)).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
  });

  it("keeps dark brand text and emphasis backgrounds above WCAG AA", () => {
    expect(contrast(kumoThemeTokens.dark.brand, DARK_INVERSE_TEXT)).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
    expect(contrast(kumoThemeTokens.dark.brandHover, DARK_INVERSE_TEXT)).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
    expect(contrast(kumoThemeTokens.dark.brandText, DARK_CANVAS)).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
  });
});

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
