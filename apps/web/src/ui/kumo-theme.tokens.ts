/**
 * OpenTag's Kumo semantic theme source.
 *
 * Keep brand values here so generated CSS and contrast reviews have one source
 * of truth. Status colours stay on Kumo's success, warning, info, and danger
 * tokens and are never aliased to the OpenTag brand.
 */
export const kumoThemeTokens = {
  light: {
    brand: "#3a5c04",
    // Keep normal-size brand text comfortably above WCAG AA on a light surface. The display green
    // is intentionally reserved for headings at 24px and above, so it is not used here.
    brandHover: "#2f4a03",
    brandText: "#3a5c04",
    buttonRing: "#3a5c04",
  },
  dark: {
    brand: "#8fdd14",
    brandHover: "#a8ec45",
    brandText: "#8fdd14",
    buttonRing: "#8fdd14",
  },
} as const;

export type KumoThemeTokens = typeof kumoThemeTokens;
