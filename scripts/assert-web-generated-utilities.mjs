import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultAssetsDir = resolve(rootDir, "apps/web/dist/assets");

// Keep this file outside `apps/web`: `@tailwindcss/vite` scans the Vite root automatically,
// so placing these probe strings under `apps/web` would cause Tailwind to emit them from the
// assertion file itself even when `@source` or application source scanning is broken.
export const REQUIRED_WEB_UTILITIES = Object.freeze([
  // Present in `@cloudflare/kumo/dist` and absent from `apps/web`.
  { reason: "Kumo control sizing", source: "kumo", utility: "h-9" },
  { reason: "Kumo badge palette", source: "kumo", utility: "bg-kumo-badge-blue" },
  { reason: "Kumo surface token", source: "kumo", utility: "bg-kumo-elevated" },
  { reason: "Kumo control spacing", source: "kumo", utility: "px-2.5" },
  // Present in `apps/web/src` and absent from `@cloudflare/kumo/dist`.
  { reason: "OpenTag shell canvas token", source: "web", utility: "bg-kumo-canvas" },
  { reason: "OpenTag list divider token", source: "web", utility: "divide-kumo-line" },
  { reason: "OpenTag row divider reset", source: "web", utility: "last:border-b-0" },
  { reason: "OpenTag touch target sizing", source: "web", utility: "max-md:min-h-11" },
]);

export function toCssClassSelectorBody(utility) {
  return utility.replace(/[^A-Za-z0-9_-]/g, "\\$&");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function containsCssUtilitySelector(css, utility) {
  const escaped = escapeRegExp(toCssClassSelectorBody(utility));
  // Require a CSS selector boundary after the class name so `.h-9` cannot match `.h-96`
  // and `.size-8` cannot match `.size-8\.5`.
  const pattern = new RegExp(`\\.${escaped}[,{:\\s\\[>~+]`);
  return pattern.test(css);
}

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
