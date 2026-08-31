#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULTS = {
  journalPath: "packages/server/drizzle/meta/_journal.json",
  migrationsDir: "packages/server/drizzle",
  manifestPath: "packages/server/drizzle/migration-hashes.json",
};

export function sha256File(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function fail(message) {
  throw new Error(`Migration drift: ${message}`);
}

function readJson(filePath, description) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") fail(`${description} does not exist: ${filePath}`);
    if (error instanceof SyntaxError) fail(`${description} is not valid JSON: ${filePath}`);
    throw error;
  }
}

function validateJournal(journal, journalPath) {
  if (!journal || !Array.isArray(journal.entries)) fail(`journal entries must be an array (${journalPath})`);

  return journal.entries.map((entry, expectedIndex) => {
    if (!entry || typeof entry !== "object") fail(`journal entry ${expectedIndex} is not an object`);
    if (entry.idx !== expectedIndex) {
      fail(
        `journal entry ${entry.tag ?? expectedIndex} has idx ${entry.idx}; expected contiguous idx ${expectedIndex}`,
      );
    }
    if (typeof entry.tag !== "string" || entry.tag.length === 0) {
      fail(`journal entry ${expectedIndex} has no migration tag`);
    }
    const match = /^(\d{4})_.+/.exec(entry.tag);
    if (!match || Number(match[1]) !== expectedIndex) {
      fail(`journal entry ${entry.tag} is out of order for idx ${expectedIndex}`);
    }
    return { idx: expectedIndex, tag: entry.tag };
  });
}

function readSqlTags(migrationsDir) {
  let files;
  try {
    files = readdirSync(migrationsDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") fail(`migration directory does not exist: ${migrationsDir}`);
    throw error;
  }
  return files
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name.slice(0, -4))
    .sort();
}

function validateCorrespondence(entries, sqlTags) {
  const journalTags = new Set(entries.map(({ tag }) => tag));
  const sqlTagSet = new Set(sqlTags);
  for (const { tag } of entries) {
    if (!sqlTagSet.has(tag)) fail(`journal entry ${tag} has no SQL file (${tag}.sql)`);
  }
  for (const tag of sqlTags) {
    if (!journalTags.has(tag)) fail(`SQL file ${tag}.sql is absent from the journal`);
  }
}

function validateManifest(manifest, manifestPath) {
  if (!manifest || manifest.version !== 1 || !Array.isArray(manifest.entries)) {
    fail(`manifest must have version 1 and an entries array (${manifestPath})`);
  }
  return manifest.entries.map((entry, expectedIndex) => {
    if (!entry || typeof entry !== "object" || typeof entry.tag !== "string") {
      fail(`manifest entry ${expectedIndex} is invalid (${manifestPath})`);
    }
    if (entry.idx !== expectedIndex)
      fail(`manifest entry ${entry.tag} has idx ${entry.idx}; expected ${expectedIndex}`);
    if (!/^[a-f0-9]{64}$/.test(entry.sha256)) fail(`manifest entry ${entry.tag} has an invalid sha256 hash`);
    return { idx: expectedIndex, tag: entry.tag, sha256: entry.sha256 };
  });
}

function manifestJson(entries) {
  return `${JSON.stringify({ version: 1, entries }, null, 2)}\n`;
}

export function checkMigrationDrift({ journalPath, migrationsDir, manifestPath, update = false }) {
  const journal = readJson(journalPath, "journal");
  const entries = validateJournal(journal, journalPath);
  const sqlTags = readSqlTags(migrationsDir);
  validateCorrespondence(entries, sqlTags);

  const manifestExists = existsSync(manifestPath);
  const recorded = manifestExists ? validateManifest(readJson(manifestPath, "hash manifest"), manifestPath) : [];
  if (!manifestExists && !update) fail(`hash manifest does not exist: ${manifestPath}; run with --update to create it`);
  if (recorded.length > entries.length)
    fail(`manifest contains removed historical migration ${recorded[entries.length].tag}`);

  const current = entries.map(({ idx, tag }) => ({ idx, tag, sha256: sha256File(join(migrationsDir, `${tag}.sql`)) }));
  for (let index = 0; index < recorded.length; index += 1) {
    const expected = recorded[index];
    const actual = current[index];
    if (!actual || actual.idx !== expected.idx || actual.tag !== expected.tag) {
      fail(`historical migration order changed at ${expected.tag}`);
    }
    if (actual.sha256 !== expected.sha256) {
      fail(`historical migration content hash changed for ${actual.tag}`);
    }
  }

  if (current.length > recorded.length && !update) {
    fail(`new migration ${current[recorded.length].tag} is not recorded; rerun with --update to append it`);
  }
  if (update && current.length !== recorded.length) {
    writeFileSync(manifestPath, manifestJson(current), "utf8");
  }
  return { migrationCount: current.length, updated: update && current.length !== recorded.length };
}

function parseArgs(argv) {
  const options = { ...DEFAULTS, update: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--update") {
      options.update = true;
    } else if (arg === "--journal" || arg === "--migrations" || arg === "--manifest") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) fail(`${arg} requires a path`);
      const key = arg.slice(2) === "migrations" ? "migrationsDir" : `${arg.slice(2)}Path`;
      options[key] = value;
      index += 1;
    } else {
      fail(`unknown argument ${arg}`);
    }
  }
  return {
    ...options,
    journalPath: resolve(options.journalPath),
    migrationsDir: resolve(options.migrationsDir),
    manifestPath: resolve(options.manifestPath),
  };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const result = checkMigrationDrift(parseArgs(process.argv.slice(2)));
    const suffix = result.updated ? " (manifest updated)" : "";
    console.log(`Migration drift check passed: ${result.migrationCount} migrations${suffix}.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
