import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * Regenerating the route tree is only useful while serving or building; a test run imports the
 * committed `src/routeTree.gen.ts`. Keeping the generator out of the test transform also keeps its
 * Babel pass out of it, which matters because this repository pins @babel/parser and @babel/types
 * to 8.x while @babel/core stays on 7.x — a combination that crashes on TypeScript function types.
 */
const generateRoutes = !process.env.VITEST;

export default defineConfig({
  base: "/",
  // The route generator must run before the React plugin so the generated tree is transformed too.
  plugins: [...(generateRoutes ? [tanstackRouter({ autoCodeSplitting: false, target: "react" })] : []), react()],
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
