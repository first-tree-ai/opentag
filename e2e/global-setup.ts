import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { type FullConfig, request } from "@playwright/test";
import { baseURL } from "./playwright.config.js";

const authStatePath = resolve(import.meta.dirname, ".auth/admin.json");

export default async function globalSetup(_config: FullConfig): Promise<void> {
  await mkdir(dirname(authStatePath), { recursive: true });
  const context = await request.newContext({ baseURL });
  try {
    const response = await context.get("/api/v1/auth/dev/callback?next=/onboarding", { maxRedirects: 5 });
    if (!response.ok()) {
      throw new Error(`Development sign-in failed with HTTP ${response.status()}: ${await response.text()}`);
    }
    const state = await context.storageState();
    await writeFile(authStatePath, JSON.stringify(state, null, 2));
    await readFile(authStatePath, "utf8");
  } finally {
    await context.dispose();
  }

  // Create an isolated credential account so the sign-in spec can prove that a wrong password is rejected.
  const passwordContext = await request.newContext({ baseURL, extraHTTPHeaders: { Origin: baseURL } });
  try {
    const response = await passwordContext.post("/api/v1/auth/email/sign-up", {
      data: {
        email: "password-e2e@opentag.local",
        displayName: "Password E2E",
        password: "correct-password-e2e",
      },
    });
    if (![204, 409].includes(response.status())) {
      throw new Error(`Password fixture setup failed with HTTP ${response.status()}: ${await response.text()}`);
    }
  } finally {
    await passwordContext.dispose();
  }
}
