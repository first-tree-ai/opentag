import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * `@opentag/shared` resolves to its built `dist` by default. The catalog:add CLI imports it at
 * runtime, so tests map it to source and run on a fresh checkout without building shared first.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@opentag/shared": fileURLToPath(new URL("../shared/src/index.ts", import.meta.url)),
    },
  },
});
