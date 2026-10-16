import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const sharedSource = (file: string) => fileURLToPath(new URL(`../shared/src/${file}`, import.meta.url));

/**
 * `@opentag/shared` resolves to its built `dist` by default. The catalog:add CLI imports it at
 * runtime, so tests map it to source and run on a fresh checkout without building shared first.
 * Each public export gets an exact alias: a plain string key would also prefix-match
 * `@opentag/shared/browser` and resolve it inside `index.ts`.
 */
export default defineConfig({
  resolve: {
    alias: [
      { find: /^@opentag\/shared$/, replacement: sharedSource("index.ts") },
      { find: /^@opentag\/shared\/browser$/, replacement: sharedSource("browser.ts") },
    ],
  },
});
