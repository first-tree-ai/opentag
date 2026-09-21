/**
 * Bounded E1-upgrade helper for cloud-identities-fixture.mjs.
 *
 * Materializes drizzle files through idx 41 from a git commit via `git show`
 * (no tracked-file writes) and applies them with production `migrateDatabase`.
 *
 * Usage:
 *   OPENTAG_DATABASE_URL=<url> tsx cloud-identities-migrations.ts \
 *     --repository-root <repo> --output <dir> \
 *     --commit 440dfed53c3bb22a8527cd731f82e9b9006bd9b5 --through-idx 41
 *
 * Prints one JSON object `{ count, tags }` and never prints the database URL.
 */
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const E1_BASELINE_COMMIT = "440dfed53c3bb22a8527cd731f82e9b9006bd9b5";
export const E1_THROUGH_IDX = 41;

interface JournalEntry {
  idx: number;
  tag: string;
}

interface Journal {
  version: string;
  dialect: string;
  entries: JournalEntry[];
}

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  return process.argv[index + 1];
}

async function gitShow(repositoryRoot: string, commit: string, path: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", repositoryRoot, "show", `${commit}:${path}`], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    timeout: 30_000,
  });
  return stdout;
}

export async function materializeBaselineMigrations(options: {
  repositoryRoot: string;
  commit: string;
  throughIdx: number;
  output: string;
}): Promise<string[]> {
  await mkdir(join(options.output, "meta"), { recursive: true, mode: 0o700 });
  const journal = JSON.parse(
    await gitShow(options.repositoryRoot, options.commit, "packages/server/drizzle/meta/_journal.json"),
  ) as Journal;
  const entries = journal.entries.filter((entry) => entry.idx <= options.throughIdx);
  if (entries.at(-1)?.idx !== options.throughIdx) {
    throw new Error(`Commit ${options.commit} does not include migration idx ${options.throughIdx}`);
  }
  for (const entry of entries) {
    const sql = await gitShow(options.repositoryRoot, options.commit, `packages/server/drizzle/${entry.tag}.sql`);
    await writeFile(join(options.output, `${entry.tag}.sql`), sql);
  }
  await writeFile(join(options.output, "meta/_journal.json"), `${JSON.stringify({ ...journal, entries }, null, 2)}\n`);
  return entries.map((entry) => entry.tag);
}

async function migrateFolder(repositoryRoot: string, databaseUrl: string, folder: string): Promise<void> {
  const modulePath = resolve(repositoryRoot, "packages/server/src/db/migrate.ts");
  const { migrateDatabase } = (await import(pathToFileURL(modulePath).href)) as {
    migrateDatabase: (databaseUrl: string, migrationsFolder: string) => Promise<void>;
  };
  await migrateDatabase(databaseUrl, folder);
}

async function main(): Promise<void> {
  const databaseUrl = process.env.OPENTAG_DATABASE_URL;
  const repositoryRoot = argValue("--repository-root");
  const output = argValue("--output");
  const commit = argValue("--commit") ?? E1_BASELINE_COMMIT;
  const throughIdx = Number(argValue("--through-idx") ?? String(E1_THROUGH_IDX));
  if (!databaseUrl || !repositoryRoot || !output || !Number.isInteger(throughIdx) || throughIdx < 0) {
    process.stderr.write(
      [
        "usage: OPENTAG_DATABASE_URL=<url> tsx cloud-identities-migrations.ts",
        "--repository-root <repo> --output <dir> [--commit <sha>] [--through-idx 41]\n",
      ].join(" "),
    );
    process.exitCode = 2;
    return;
  }
  const tags = await materializeBaselineMigrations({ repositoryRoot, commit, throughIdx, output });
  await migrateFolder(repositoryRoot, databaseUrl, output);
  process.stdout.write(`${JSON.stringify({ count: tags.length, tags })}\n`);
}

const invokedDirectly =
  process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) await main();
