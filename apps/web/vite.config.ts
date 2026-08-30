import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

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
});
