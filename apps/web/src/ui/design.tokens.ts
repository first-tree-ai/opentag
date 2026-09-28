/**
 * Canonical OpenTag application palette. Generate theme.css with pnpm theme:generate.
 * Action violet never substitutes for operational success, warning, or danger.
 */
export const designTokens = {
  light: {
    canvas: "#fffcf7",
    surface: "#ffffff",
    elevated: "#ffffff",
    recessed: "#f4f0e9",
    tint: "#faf7f2",
    hover: "#f5f1eb",
    foreground: "#171719",
    secondary: "#4c4d5c",
    muted: "#6b6674",
    border: "#e5e0db",
    controlBorder: "#8c8795",
    action: "#5638d8",
    actionText: "#5638d8",
    actionHover: "#452bb5",
    actionPressed: "#38218f",
    selected: "#f1ebff",
    inverse: "#ffffff",
    danger: "#b42318",
    dangerHover: "#88180f",
  },
  // Compatibility palette; light mode is the supported product theme.
  dark: {
    canvas: "#19171d",
    surface: "#232127",
    elevated: "#2b282f",
    recessed: "#17151b",
    tint: "#2a2730",
    hover: "#33303a",
    foreground: "#f7f4fa",
    secondary: "#d0cbd8",
    muted: "#b3aaba",
    border: "#413b49",
    controlBorder: "#8d839b",
    action: "#7052e5",
    actionText: "#c4b5ff",
    actionHover: "#6143d3",
    actionPressed: "#5236bd",
    selected: "#35294f",
    inverse: "#ffffff",
    danger: "#b42318",
    dangerHover: "#88180f",
  },
} as const;

export const designMetrics = {
  font: '"Manrope", "PingFang SC", "Microsoft YaHei", "Noto Sans SC", ui-sans-serif, system-ui, sans-serif',
  controlRadius: "0.5rem",
  surfaceRadius: "0.75rem",
  dialogRadius: "1rem",
  controlHeight: "2.5rem",
  compactControlHeight: "2rem",
  pageTitle: "1.75rem",
  compactPageTitle: "1.5rem",
  sectionTitle: "1.125rem",
  frameWidth: "64rem",
  navigationWidth: "15rem",
  railWidth: "4.5rem",
} as const;
