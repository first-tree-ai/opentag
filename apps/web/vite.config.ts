import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin, type Rollup } from "vite";

const ENTRY_CHUNK_BUDGET_BYTES = 600 * 1024;
const ECHARTS_CHUNK_BUDGET_BYTES = 600 * 1024;

/**
 * Keep the entry budget close to the measured baseline while making growth fail loudly.
 * The ECharts chunk has its own budget so chart changes do not hide in the application entry.
 */
const bundleBudgetPlugin: Plugin = {
  name: "opentag-bundle-budget",
  apply: "build",
  generateBundle(_options: Rollup.OutputOptions, bundle: Rollup.OutputBundle) {
    const breaches = Object.values(bundle)
      .filter((output): output is Rollup.OutputChunk => output.type === "chunk")
      .flatMap((chunk) => {
        const budget =
          chunk.name === "echarts" ? ECHARTS_CHUNK_BUDGET_BYTES : chunk.isEntry ? ENTRY_CHUNK_BUDGET_BYTES : undefined;
        if (budget === undefined) return [];

        const size = Buffer.byteLength(chunk.code);
        return size > budget ? [{ budget, chunk, size }] : [];
      });

    if (breaches.length > 0) {
      const details = breaches
        .map(
          ({ budget, chunk, size }) =>
            `${chunk.fileName} is ${(size / 1024).toFixed(2)} KiB (budget ${(budget / 1024).toFixed(2)} KiB)`,
        )
        .join("; ");
      this.error(`[bundle-budget] FAIL: ${details}`);
    }
  },
};

/**
 * Regenerating the route tree, and splitting each route's component out of the entry, is only useful
 * while serving or building; a test run imports the committed `src/routeTree.gen.ts`, which the
 * splitter never rewrites — it transforms the route modules themselves, in memory.
 */
const generateRoutes = !process.env.VITEST;

export default defineConfig({
  base: "/",
  // The route generator must run before the React plugin so the generated tree is transformed too.
  plugins: [
    ...(generateRoutes ? [tanstackRouter({ autoCodeSplitting: true, target: "react" })] : []),
    tailwindcss(),
    react(),
    bundleBudgetPlugin,
  ],
  server: {
    proxy: {
      "/api": "http://localhost:8000",
      "/healthz": "http://localhost:8000",
      "/readyz": "http://localhost:8000",
    },
  },
  test: {
    environment: "jsdom",
    name: "web",
    sequence: { groupOrder: 2 },
    setupFiles: ["./src/__tests__/setup.ts"],
  },
  build: {
    rollupOptions: {
      output: {
        // Keep ECharts and its renderer attributable to one independently budgeted chunk.
        manualChunks(id) {
          const normalizedId = id.replaceAll("\\\\", "/");
          if (normalizedId.includes("/node_modules/echarts/") || normalizedId.includes("/node_modules/zrender/")) {
            return "echarts";
          }
          return undefined;
        },
      },
    },
  },
});
