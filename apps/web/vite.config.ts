import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  base: "/",
  // The route generator must run before the React plugin so the generated tree is transformed too.
  plugins: [tanstackRouter({ autoCodeSplitting: false, target: "react" }), react()],
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
