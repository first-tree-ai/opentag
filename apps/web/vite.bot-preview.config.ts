import { fileURLToPath } from "node:url";
import { paraglideVitePlugin } from "@inlang/paraglide-js";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Separate entry: no application router, API proxy, account shell, or telemetry bootstrap.
export default defineConfig({
  // Upstream's browser barrel includes an unused server hash export. Keep it fail-closed
  // in this preview instead of changing shared contracts or adding a crypto polyfill.
  resolve: {
    alias: { "node:crypto": fileURLToPath(new URL("./src/bot-preview/server-only-crypto.ts", import.meta.url)) },
  },
  plugins: [
    paraglideVitePlugin({
      project: "./project.inlang",
      outdir: "./src/paraglide",
      outputStructure: "message-modules",
      strategy: ["localStorage", "preferredLanguage", "baseLocale"],
    }),
    tailwindcss(),
    react(),
    {
      name: "bot-preview-isolation",
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url?.startsWith("/api/") || req.url === "/healthz" || req.url === "/readyz") {
            res.statusCode = 403;
            res.end("Bot preview has no backend");
            return;
          }
          if (req.url === "/") req.url = "/bot-connection.html";
          next();
        });
      },
    },
  ],
  server: { host: "127.0.0.1", port: 5178, strictPort: true },
  preview: { host: "127.0.0.1", port: 5179, strictPort: true },
  build: {
    outDir: "dist-bot-preview",
    assetsInlineLimit: (filePath) => (/\.woff2?$/i.test(filePath) ? false : undefined),
    rollupOptions: { input: "bot-connection.html" },
  },
});
