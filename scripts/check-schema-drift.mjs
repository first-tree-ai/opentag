#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.error) throw result.error;
  return result;
}

function gitStatus(cwd) {
  const result = run("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd });
  if (result.status !== 0) throw new Error(result.stderr || "Unable to read Git status");
  return result.stdout;
}

function displayStatus(status) {
  return status
    .split("\0")
    .filter(Boolean)
    .map((entry) => entry.replaceAll("\n", " "))
    .join("\n");
}

export function checkSchemaDrift({ cwd = process.cwd(), packageFilter = "@opentag/server" } = {}) {
  const before = gitStatus(cwd);
  const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const generation = run(pnpm, ["--filter", packageFilter, "db:generate"], { cwd, stdio: "inherit" });
  if (generation.status !== 0) {
    throw new Error(`Drizzle generation failed with exit code ${generation.status ?? "unknown"}`);
  }

  const after = gitStatus(cwd);
  if (after !== before) {
    const changed = displayStatus(after) || "(working tree is clean after generation, but status bytes changed)";
    throw new Error(
      `Schema drift detected: Drizzle generation changed the working tree. Commit the generated migration and metadata before running this check.\n${changed}`,
    );
  }
  return { clean: true };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    checkSchemaDrift();
    console.log("Schema drift check passed: Drizzle generation left the working tree unchanged.");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
