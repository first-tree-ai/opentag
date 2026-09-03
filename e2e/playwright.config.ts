import { resolve } from "node:path";
import { defineConfig, devices } from "@playwright/test";

const repositoryRoot = resolve(import.meta.dirname, "..");
const port = Number(process.env.OPENTAG_E2E_PORT ?? 8123);
const baseURL = `http://127.0.0.1:${port}`;
const chromiumExecutable = process.env.OPENTAG_E2E_CHROMIUM;

export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*.spec.ts",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: true,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"], ["html", { outputFolder: "playwright-report", open: "never" }]],
  outputDir: "test-results",
  globalSetup: resolve(import.meta.dirname, "global-setup.ts"),
  globalTeardown: resolve(import.meta.dirname, "global-teardown.ts"),
  use: {
    ...devices["Desktop Chrome"],
    baseURL,
    viewport: { width: 1440, height: 900 },
    storageState: resolve(import.meta.dirname, ".auth/admin.json"),
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
    ...(chromiumExecutable ? { launchOptions: { executablePath: chromiumExecutable } } : {}),
  },
  webServer: {
    command: `node ${resolve(import.meta.dirname, "scripts/stack-server.mjs")}`,
    url: `${baseURL}/healthz`,
    timeout: 180_000,
    reuseExistingServer: false,
    stdout: "pipe",
    stderr: "pipe",
  },
  projects: [
    {
      name: "smoke",
      testMatch: "**/*smoke.spec.ts",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 900 },
        trace: "retain-on-failure",
        video: "retain-on-failure",
      },
    },
    {
      name: "journey",
      testIgnore: "**/*smoke.spec.ts",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
  ],
});

export { baseURL, port, repositoryRoot };
