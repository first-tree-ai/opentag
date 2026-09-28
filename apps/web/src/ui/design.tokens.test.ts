import { describe, expect, it } from "vitest";
import { designTokens } from "./design.tokens.js";

describe("OpenTag palette accessibility", () => {
  it.each(["light", "dark"] as const)("keeps %s text and controls legible", (mode) => {
    const t = designTokens[mode];
    for (const surface of [t.canvas, t.surface, t.recessed, t.selected]) {
      for (const text of [t.foreground, t.secondary, t.muted]) {
        expect(contrast(text, surface), `${mode}: ${text} on ${surface}`).toBeGreaterThanOrEqual(4.5);
      }
    }
    for (const surface of [t.canvas, t.surface]) {
      expect(contrast(t.actionText, surface)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t.controlBorder, surface)).toBeGreaterThanOrEqual(3);
    }
    for (const fill of [t.action, t.actionHover, t.actionPressed, t.danger, t.dangerHover]) {
      expect(contrast(t.inverse, fill), `${mode}: action ${fill}`).toBeGreaterThanOrEqual(4.5);
    }
  });
});

function contrast(left: string, right: string): number {
  const values = [luminance(left), luminance(right)];
  return (Math.max(...values) + 0.05) / (Math.min(...values) + 0.05);
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
