import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";

const assetsDirectory = process.argv[2] ?? "apps/web/dist/assets";
const entries = await readdir(assetsDirectory, { withFileTypes: true });
const chunks = [];

for (const entry of entries) {
  if (!entry.isFile() || !entry.name.endsWith(".js")) continue;

  const file = join(assetsDirectory, entry.name);
  const bytes = (await stat(file)).size;
  chunks.push({
    bytes,
    file: relative(process.cwd(), file),
    kibibytes: Number((bytes / 1024).toFixed(2)),
    name: entry.name.replace(/-[A-Za-z0-9_-]{8}\.js$/, ""),
  });
}

chunks.sort((left, right) => left.file.localeCompare(right.file));

const report = {
  version: 1,
  directory: relative(process.cwd(), assetsDirectory),
  chunks,
  totalBytes: chunks.reduce((total, chunk) => total + chunk.bytes, 0),
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
