import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** Check the artifact that will execute. API creation and live readiness verify Server and Client admission. */
export async function detectPiAdmission(repositoryRoot) {
  const packageRoot = join(repositoryRoot, "packages/shared");
  const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  const shared = await import(pathToFileURL(join(packageRoot, manifest.exports["."].import)).href);
  const admitted = shared.AGENT_RUNTIME_PROVIDERS.includes("pi");
  return {
    admitted,
    pending: admitted ? [] : ["The built Shared artifact does not admit Pi; run pnpm build"],
    note: "Server admission is tested by creating a Pi Agent; Client admission by live Pi readiness and execution.",
  };
}
