/**
 * OpenTag's Kumo semantic theme source.
 *
 * Keep brand values here so generated CSS and contrast reviews have one source
 * of truth. Status colours stay on Kumo's success, warning, info, and danger
 * tokens and are never aliased to the OpenTag brand.
 */
export const kumoThemeTokens = {
  light: {
    brand: "#385a04",
    brandHover: "#4e7a06",
    brandText: "#385a04",
    buttonRing: "#385a04",
  },
  dark: {
    brand: "#90de14",
    brandHover: "#a8ec45",
    brandText: "#90de14",
    buttonRing: "#90de14",
  },
} as const;

export type KumoThemeTokens = typeof kumoThemeTokens;
