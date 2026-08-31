import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const DIVERGENCE_MARKER = "<!-- doc-mirror: allow-divergence -->";

const ROOT_CANONICAL_EXCLUSIONS = new Set(["AGENTS.md"]);

function toPosix(path) {
  return path.split(sep).join("/");
}

function walkMarkdownFiles(directory, root = directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walkMarkdownFiles(path, root));
    else if (entry.isFile() && entry.name.endsWith(".md")) files.push(toPosix(relative(root, path)));
  }
  return files;
}

/** Return the canonical file and its expected mirror for every mirror candidate in the checkout. */
export function discoverMirrorPairs(repositoryRoot) {
  const root = resolve(repositoryRoot);
  const pairs = new Map();

  for (const path of walkMarkdownFiles(root)) {
    if (!path.endsWith(".zh-CN.md") || path.includes("/")) continue;
    const canonical = path.replace(/\.zh-CN\.md$/, ".md");
    pairs.set(canonical, path);
  }

  const docsMirrorRoot = join(root, "docs", "zh-CN");
  if (existsSync(docsMirrorRoot)) {
    for (const path of walkMarkdownFiles(docsMirrorRoot, docsMirrorRoot)) {
      const mirror = `docs/zh-CN/${path}`;
      pairs.set(`docs/${path}`, mirror);
    }
  }

  return pairs;
}

/** Return the mirror path for a canonical Markdown path, when this repository treats it as translatable. */
export function expectedMirrorPath(canonicalPath) {
  if (!canonicalPath.endsWith(".md")) return null;
  if (canonicalPath.endsWith(".zh-CN.md")) return null;
  if (canonicalPath.includes("/zh-CN/") || canonicalPath.startsWith("docs/zh-CN/")) return null;
  if (canonicalPath.startsWith("docs/design/")) return null;
  if (!canonicalPath.includes("/")) {
    if (ROOT_CANONICAL_EXCLUSIONS.has(canonicalPath)) return null;
    return canonicalPath.replace(/\.md$/, ".zh-CN.md");
  }
  if (canonicalPath.startsWith("docs/")) return `docs/zh-CN/${canonicalPath.slice("docs/".length)}`;
  return null;
}

function parseDiff(diff) {
  const files = new Map();
  let current = null;
  for (const line of diff.split("\n")) {
    const header = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
    if (header) {
      current = { oldPath: header[1], newPath: header[2], hunks: [] };
      files.set(current.newPath, current);
      continue;
    }
    if (!current) continue;
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      current.hunks.push({
        newStart: Number(hunk[3]),
        newCount: Number(hunk[4] ?? 1),
      });
    }
  }
  return files;
}

function changedLineRanges(file) {
  return file.hunks.map(({ newStart, newCount }) => {
    const start = newCount === 0 ? Math.max(1, newStart) : newStart;
    return { start, end: start + Math.max(newCount, 1) - 1 };
  });
}

function markedSectionRanges(content) {
  const lines = content.split("\n");
  const headings = [];
  for (let index = 0; index < lines.length; index += 1) {
    const heading = /^(#{1,6})\s+/.exec(lines[index]);
    if (heading) headings.push({ level: heading[1].length, line: index + 1 });
  }

  const ranges = [];
  for (const heading of headings) {
    const next = headings.find((candidate) => candidate.line > heading.line && candidate.level <= heading.level);
    const end = (next?.line ?? lines.length + 1) - 1;
    const hasMarker = lines.slice(heading.line - 1, end).some((line) => line.trim() === DIVERGENCE_MARKER);
    if (hasMarker) ranges.push({ start: heading.line, end });
  }
  return ranges;
}

function rangesCoveredByMarkers(content, ranges) {
  const marked = markedSectionRanges(content);
  return ranges.every(({ start, end }) => marked.some((section) => start >= section.start && end <= section.end));
}

function gitDiff(repositoryRoot, base, head) {
  try {
    return execFileSync(
      "git",
      ["-C", repositoryRoot, "diff", "--unified=0", "--no-color", "--find-renames", `${base}...${head}`],
      { encoding: "utf8" },
    );
  } catch (error) {
    const detail = error.stderr?.toString().trim() || error.message;
    throw new Error(`Unable to read Git diff for ${base}...${head}: ${detail}`);
  }
}

function mirrorCandidates(changedFiles, pairs) {
  const candidates = new Map(pairs);
  for (const canonicalPath of changedFiles.keys()) {
    const mirrorPath = expectedMirrorPath(canonicalPath);
    if (mirrorPath) candidates.set(canonicalPath, mirrorPath);
  }
  return candidates;
}

function findChangedCanonicalWithoutMirror(root, changedFiles, candidates) {
  const missing = [];
  for (const [canonicalPath, mirrorFromDiscovery] of candidates) {
    const mirrorPath = mirrorFromDiscovery ?? expectedMirrorPath(canonicalPath);
    if (!mirrorPath) continue;
    const canonicalDiff = changedFiles.get(canonicalPath);
    if (!canonicalDiff) continue;
    const mirrorDiff = changedFiles.get(mirrorPath);
    if (mirrorDiff) continue;

    const canonicalAbsolutePath = join(root, canonicalPath);
    const canonicalExists = existsSync(canonicalAbsolutePath);
    const content = canonicalExists ? readFileSync(canonicalAbsolutePath, "utf8") : "";
    const changedRanges = changedLineRanges(canonicalDiff);
    if (canonicalExists && rangesCoveredByMarkers(content, changedRanges)) continue;
    missing.push({ canonical: canonicalPath, mirror: mirrorPath });
  }
  return missing;
}

function findOrphanMirrors(root, pairs) {
  const missing = [];
  for (const [canonicalPath, mirrorPath] of pairs) {
    if (!existsSync(join(root, canonicalPath))) {
      missing.push({ canonical: canonicalPath, mirror: mirrorPath, orphan: true });
    }
  }

  return missing;
}

export function checkDocMirrors({ repositoryRoot = process.cwd(), base, head = "HEAD" }) {
  if (!base) throw new Error("A base Git revision is required (pass --base <revision>)");
  const root = resolve(repositoryRoot);
  const changedFiles = parseDiff(gitDiff(root, base, head));
  const pairs = discoverMirrorPairs(root);
  const candidates = mirrorCandidates(changedFiles, pairs);
  const missing = [
    ...findChangedCanonicalWithoutMirror(root, changedFiles, candidates),
    ...findOrphanMirrors(root, pairs),
  ];
  return { checked: changedFiles.size, missing, pairs: pairs.size };
}

function applyArgument(argument, value, options, positional) {
  if (argument === "--root" || argument === "--base" || argument === "--head") {
    options[argument.slice(2)] = value;
    return;
  }
  if (argument === "--range") {
    const match = /^(.*?)\.\.\.(.*)$/.exec(value);
    if (!match) throw new Error("--range must use base...head syntax");
    options.base = match[1];
    options.head = match[2];
    return;
  }
  positional.push(argument);
}

const VALUE_ARGUMENTS = new Set(["--root", "--base", "--head", "--range"]);

function parseArgumentAt(argv, index, options, positional) {
  const argument = argv[index];
  if (argument === "--help" || argument === "-h") {
    options.help = true;
    return index;
  }
  if (VALUE_ARGUMENTS.has(argument)) {
    const value = argv[index + 1];
    if (!value) throw new Error(`${argument} requires a value`);
    applyArgument(argument, value, options, positional);
    return index + 1;
  }
  applyArgument(argument, undefined, options, positional);
  return index;
}

function parseArguments(argv) {
  const options = { root: process.cwd(), head: "HEAD" };
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    index = parseArgumentAt(argv, index, options, positional);
  }
  if (!options.base && positional[0]) options.base = positional[0];
  if (positional[1]) options.head = positional[1];
  return options;
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (options.help) {
    process.stdout.write(
      "Usage: node scripts/check-doc-mirrors.mjs --base <revision> [--head <revision>] [--root <path>]\n",
    );
    return 0;
  }
  const result = checkDocMirrors(options);
  if (result.missing.length > 0) {
    process.stderr.write("Documentation mirror check failed:\n");
    for (const item of result.missing) {
      if (item.orphan) process.stderr.write(`- mirror ${item.mirror} has no canonical file ${item.canonical}\n`);
      else process.stderr.write(`- canonical ${item.canonical} changed without mirror ${item.mirror}\n`);
    }
    return 1;
  }
  process.stdout.write(`Documentation mirror check passed (${result.pairs} pairs discovered).\n`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
