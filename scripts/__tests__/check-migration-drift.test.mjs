import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const SCRIPT = join(import.meta.dirname, "..", "check-migration-drift.mjs");

function fixture(entries, sqlByTag, manifestEntries = entries) {
  const root = mkdtempSync(join(tmpdir(), "opentag-migration-drift-"));
  const migrations = join(root, "drizzle");
  const meta = join(migrations, "meta");
  const journalPath = join(meta, "_journal.json");
  const manifestPath = join(meta, "migration-hashes.json");
  execFileSync(process.execPath, [
    "-e",
    "const fs=require('node:fs'); fs.mkdirSync(process.argv[1], {recursive:true})",
    meta,
  ]);
  for (const [tag, sql] of Object.entries(sqlByTag)) writeFileSync(join(migrations, `${tag}.sql`), sql);
  writeFileSync(journalPath, `${JSON.stringify({ version: "7", dialect: "postgresql", entries }, null, 2)}\n`);
  writeFileSync(
    manifestPath,
    `${JSON.stringify({ version: 1, entries: manifestEntries.map(({ idx, tag }) => ({ idx, tag, sha256: hash(sqlByTag[tag]) })) }, null, 2)}\n`,
  );
  return { root, migrations, journalPath, manifestPath };
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function run(paths, ...args) {
  return spawnSync(
    process.execPath,
    [
      SCRIPT,
      "--journal",
      paths.journalPath,
      "--migrations",
      paths.migrations,
      "--manifest",
      paths.manifestPath,
      ...args,
    ],
    { encoding: "utf8" },
  );
}

function close(paths) {
  rmSync(paths.root, { recursive: true, force: true });
}

test("fails when a journal entry has no SQL file", () => {
  const paths = fixture([{ idx: 0, version: "7", when: 1, tag: "0000_first", breakpoints: true }], {}, []);
  try {
    const result = run(paths);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /0000_first/);
  } finally {
    close(paths);
  }
});

test("fails when a SQL file is absent from the journal", () => {
  const paths = fixture([], { "0000_first": "create table first;" }, []);
  try {
    const result = run(paths);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /0000_first/);
  } finally {
    close(paths);
  }
});

test("fails when journal indexes are reordered or non-contiguous", () => {
  const entries = [
    { idx: 0, version: "7", when: 1, tag: "0000_first", breakpoints: true },
    { idx: 2, version: "7", when: 2, tag: "0002_third", breakpoints: true },
  ];
  const paths = fixture(entries, { "0000_first": "first;", "0002_third": "third;" });
  try {
    const result = run(paths);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /idx|contiguous|order/i);
  } finally {
    close(paths);
  }
});

test("fails when historical migration content changes", () => {
  const paths = fixture([{ idx: 0, version: "7", when: 1, tag: "0000_first", breakpoints: true }], {
    "0000_first": "original;",
  });
  try {
    writeFileSync(join(paths.migrations, "0000_first.sql"), "edited history;");
    const result = run(paths);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /hash|content|0000_first/i);
  } finally {
    close(paths);
  }
});

test("passes for a clean journal, SQL set, and manifest", () => {
  const paths = fixture([{ idx: 0, version: "7", when: 1, tag: "0000_first", breakpoints: true }], {
    "0000_first": "original;",
  });
  try {
    const result = run(paths);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  } finally {
    close(paths);
  }
});

test("--update records a newly appended migration", () => {
  const initial = [{ idx: 0, version: "7", when: 1, tag: "0000_first", breakpoints: true }];
  const sql = { "0000_first": "original;", "0001_second": "second;" };
  const paths = fixture(initial, sql);
  try {
    const entries = [...initial, { idx: 1, version: "7", when: 2, tag: "0001_second", breakpoints: true }];
    writeFileSync(paths.journalPath, `${JSON.stringify({ version: "7", dialect: "postgresql", entries }, null, 2)}\n`);
    const result = run(paths, "--update");
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    const manifest = JSON.parse(readFileSync(paths.manifestPath, "utf8"));
    assert.deepEqual(
      manifest.entries.map((entry) => entry.tag),
      ["0000_first", "0001_second"],
    );
    assert.equal(manifest.entries[1].sha256, hash(sql["0001_second"]));
  } finally {
    close(paths);
  }
});
