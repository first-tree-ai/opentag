#!/usr/bin/env node

/**
 * Host-side guard for the isolated Pi config directory injected into the Runner container.
 * Only a narrow real directory passes: whitelisted basenames, regular non-symlink files, no
 * HOME, no shell-command `!` credential indirections, and documents already scoped to the
 * selected provider. A filtered staging copy (0700/0600) is what actually reaches `docker cp`.
 */

import { chmodSync, lstatSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { registerTempDir } from "../../runner/cleanup.mjs";

export const PI_CONFIG_ALLOWED_FILES = Object.freeze(["auth.json", "models.json", "settings.json"]);
const SAFE_SETTINGS_KEYS = Object.freeze(["defaultProvider", "defaultModel", "defaultThinkingLevel"]);

function fail(message) {
  throw new Error(message);
}

function assertNoShellIndirection(name, value) {
  if (typeof value === "string") {
    if (value.startsWith("!")) fail(`${name} uses a shell-command credential indirection (!); refusing to stage`);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) assertNoShellIndirection(name, entry);
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const entry of Object.values(value)) assertNoShellIndirection(name, entry);
  }
}

function filterProviderKeys(name, value, provider) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(`${name} must be a JSON object`);
  const filtered = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key !== provider) fail(`${name} carries provider ${key} outside the selected provider ${provider}`);
    filtered[key] = entry;
  }
  return filtered;
}

function requireObject(name, value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(`${name} must be a JSON object`);
  return value;
}

function filterAuth(name, parsed, provider) {
  const filtered = filterProviderKeys(name, parsed, provider);
  if (Object.keys(filtered).length === 0) fail(`auth.json has no entry for the selected provider ${provider}`);
  return filtered;
}

function filterModels(name, parsed, provider) {
  const source = requireObject(name, parsed);
  // Construct output from recognized top-level fields only; unknown fields are dropped, never forwarded.
  const filtered = {};
  if (source.models !== undefined) {
    if (!Array.isArray(source.models)) fail(`${name} has a malformed models field`);
    for (const entry of source.models) {
      const entryProvider = typeof entry === "object" && entry !== null ? String(entry.provider ?? "") : "";
      if (entryProvider !== provider) fail(`${name} carries a model for provider ${entryProvider || "unknown"}`);
    }
    filtered.models = source.models;
  }
  if (source.providers !== undefined) filtered.providers = filterProviderKeys(name, source.providers, provider);
  return filtered;
}

function filterSettings(name, parsed, provider) {
  requireObject(name, parsed);
  const filtered = {};
  for (const key of SAFE_SETTINGS_KEYS) {
    if (parsed[key] !== undefined) filtered[key] = parsed[key];
  }
  if (filtered.defaultProvider !== undefined && filtered.defaultProvider !== provider) {
    fail(`settings defaultProvider ${filtered.defaultProvider} is outside the selected provider ${provider}`);
  }
  return filtered;
}

function filterDocument(name, raw, provider) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail(`${name} is not valid JSON`);
  }
  const filtered =
    name === "auth.json"
      ? filterAuth(name, parsed, provider)
      : name === "models.json"
        ? filterModels(name, parsed, provider)
        : filterSettings(name, parsed, provider);
  assertNoShellIndirection(name, filtered);
  return `${JSON.stringify(filtered, null, 2)}\n`;
}

/**
 * Validates the supplied directory and returns a fresh filtered staging copy. The staging dir is
 * registered for harness cleanup; the source directory itself is never copied.
 */
export function stageFilteredPiConfig({ source, provider }) {
  if (!source || !provider) fail("staging Pi config requires source and provider");
  if (!/^[a-z0-9][a-z0-9-]*$/.test(provider)) fail(`invalid provider name: ${provider}`);
  const stats = lstatSync(source);
  if (stats.isSymbolicLink() || !stats.isDirectory()) fail("Pi config source must be a real directory, not a symlink");
  const canonical = realpathSync(source);
  if (canonical === realpathSync(homedir())) fail("refusing to stage an entire HOME directory as Pi config");
  const entries = readdirSync(canonical, { withFileTypes: true });
  const names = new Set(entries.map((entry) => entry.name));
  for (const name of names) {
    if (!PI_CONFIG_ALLOWED_FILES.includes(name)) fail(`unexpected entry in Pi config directory: ${name}`);
  }
  if (!names.has("auth.json")) fail("Pi config directory is missing auth.json");
  const staging = mkdtempSync(join(tmpdir(), "opentag-runner-pi-stage-"));
  chmodSync(staging, 0o700);
  registerTempDir(staging);
  for (const entry of entries) {
    if (entry.isSymbolicLink() || !entry.isFile()) fail(`Pi config entry is not a regular file: ${entry.name}`);
    const raw = readFileSync(join(canonical, entry.name), "utf8");
    writeFileSync(join(staging, entry.name), filterDocument(entry.name, raw, provider), { mode: 0o600 });
    chmodSync(join(staging, entry.name), 0o600);
  }
  return staging;
}
