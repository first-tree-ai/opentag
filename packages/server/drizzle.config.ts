import { defineConfig } from "drizzle-kit";

if (!process.env.OPENTAG_DATABASE_URL) {
  throw new Error("OPENTAG_DATABASE_URL is required for Drizzle commands");
}

export default defineConfig({
  dialect: "postgresql",
  dbCredentials: { url: process.env.OPENTAG_DATABASE_URL },
  out: "./drizzle",
  schema: "./src/db/schema/index.ts",
  strict: true,
  verbose: true,
});
