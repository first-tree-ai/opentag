import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { stageFilteredPiConfig } from "../runner-toolchain/pi-config-guard.mjs";

const FILES = ["auth.json", "models.json", "settings.json"];
async function hashes(source) {
  const result = {};
  for (const name of FILES) {
    const path = join(source, name);
    try {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Pi configuration must contain regular files");
      if (stat.size > 128 * 1024) throw new Error("Pi source configuration exceeds bounds");
      result[name] = createHash("sha256")
        .update(await readFile(path))
        .digest("hex");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return result;
}
export async function preparePiInput({ repositoryRoot, source, secrets }) {
  const canonical = resolve(source);
  const before = await hashes(canonical);
  const scratch = await mkdtemp(join(tmpdir(), "opentag-e3-pi-"));
  let staged;
  try {
    const { copyIsolatedPiConfig } = await import(
      pathToFileURL(join(repositoryRoot, "packages/client/dist/index.mjs")).href
    );
    const selected = await copyIsolatedPiConfig({
      source: canonical,
      destination: join(scratch, "selected"),
      providers: ["deepseek"],
    });
    // This harness owns asynchronous cloud cleanup, so it must not install the Docker harness's
    // synchronous process.exit signal handler when staging credentials.
    staged = stageFilteredPiConfig({ source: selected, provider: "deepseek", registerStaging: () => () => {} });
    const config = await readDocuments(staged, secrets);
    return { config, verifyUnchanged: async () => JSON.stringify(before) === JSON.stringify(await hashes(canonical)) };
  } finally {
    await rm(scratch, { recursive: true, force: true });
    if (staged) await rm(staged, { recursive: true, force: true });
  }
}

async function readDocuments(staged, secrets) {
  const config = {};
  const remember = (value) => {
    if (typeof value === "string" && value.length >= 8) secrets.push(value);
    else if (value && typeof value === "object") for (const entry of Object.values(value)) remember(entry);
  };
  for (const name of FILES) {
    let text;
    try {
      text = await readFile(join(staged, name), "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    if (Buffer.byteLength(text) > 32 * 1024) throw new Error("Filtered Pi document exceeds bounds");
    remember(JSON.parse(text));
    secrets.push(text);
    config[name === "auth.json" ? "authJson" : name === "models.json" ? "modelsJson" : "settingsJson"] = text;
  }
  if (!config.authJson) throw new Error("DeepSeek credentials are missing");

  return config;
}
