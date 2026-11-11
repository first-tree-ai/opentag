import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const webRootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultAssetsDir = resolve(webRootDir, "dist/assets");

// `@tailwindcss/vite` scans the Vite root (`apps/web`) automatically for literal class tokens.
// Joining segmented token parts at runtime keeps the raw utility strings out of `apps/web` source
// files so Tailwind cannot satisfy this check by scanning the assertion script or its unit tests.
const REQUIRED_WEB_UTILITY_SPECS = [
  // Present in `@cloudflare/kumo/dist` and absent from `apps/web`.
  { parts: ["h", "9"], reason: "Kumo control sizing", source: "kumo" },
  { parts: ["bg", "kumo", "badge", "blue"], reason: "Kumo badge palette", source: "kumo" },
  { parts: ["bg", "kumo", "elevated"], reason: "Kumo surface token", source: "kumo" },
  { parts: ["px", "2.5"], reason: "Kumo control spacing", source: "kumo" },
  // Present in `apps/web/src` and absent from `@cloudflare/kumo/dist`.
  { parts: ["bg", "kumo", "canvas"], reason: "OpenTag shell canvas token", source: "web" },
  { parts: ["divide", "kumo", "line"], reason: "OpenTag list divider token", source: "web" },
  { parts: ["last:border", "b", "0"], reason: "OpenTag row divider reset", source: "web" },
  { parts: ["max", "md:min", "h", "11"], reason: "OpenTag touch target sizing", source: "web" },
];

export const REQUIRED_WEB_UTILITIES = Object.freeze(
  REQUIRED_WEB_UTILITY_SPECS.map(({ parts, reason, source }) =>
    Object.freeze({
      reason,
      source,
      utility: parts.join("-"),
    }),
  ),
);

/**
 * @param {string} utility
 * @returns {string}
 */
export function toCssClassSelectorBody(utility) {
  return utility.replace(/[^A-Za-z0-9_-]/g, "\\$&");
}

/**
 * @param {string} value
 * @returns {string}
 */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * @param {string} css
 * @param {string} utility
 * @returns {boolean}
 */
export function containsCssUtilitySelector(css, utility) {
  const escaped = escapeRegExp(toCssClassSelectorBody(utility));
  // Require a CSS selector boundary after the class name so `.w-4` cannot match `.w-40`
  // and `.size-8` cannot match `.size-8\.5`.
  const pattern = new RegExp(`\\.${escaped}[,{:\\s\\[>~+]`);
  return pattern.test(css);
}

/**
 * @param {{
 *   assetsDir?: string;
 *   requiredUtilities?: ReadonlyArray<{ reason: string; source: string; utility: string }>;
 * }} [options]
 * @returns {{ cssFiles: string[]; verifiedCount: number }}
 */
export function assertWebGeneratedUtilities({
  assetsDir = defaultAssetsDir,
  requiredUtilities = REQUIRED_WEB_UTILITIES,
} = {}) {
  if (!existsSync(assetsDir)) {
    throw new Error(
      `Missing web build assets directory: ${assetsDir}. Run \`pnpm --filter @opentag/web build\` first.`,
    );
  }

  const cssFiles = readdirSync(assetsDir)
    .filter((entry) => entry.endsWith(".css"))
    .sort();
  if (cssFiles.length === 0) {
    throw new Error(`No generated CSS assets found in ${assetsDir}.`);
  }

  const combinedCss = cssFiles.map((fileName) => readFileSync(resolve(assetsDir, fileName), "utf8")).join("\n");

  const missing = requiredUtilities.filter(({ utility }) => !containsCssUtilitySelector(combinedCss, utility));
  if (missing.length > 0) {
    const details = missing.map(({ reason, source, utility }) => `.${utility} [${source}] (${reason})`).join(", ");
    throw new Error(
      `Generated web stylesheet in ${assetsDir} (${cssFiles.join(", ")}) is missing required Tailwind utilities: ${details}. Verify apps/web/src/app.css @source and @import "tailwindcss" scanning.`,
    );
  }

  return {
    cssFiles,
    verifiedCount: requiredUtilities.length,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assertWebGeneratedUtilities();
}
