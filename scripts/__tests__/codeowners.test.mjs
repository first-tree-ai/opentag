import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CODEOWNERS_PATH = join(REPOSITORY_ROOT, ".github", "CODEOWNERS");

const REQUIRED_SEAMS = [
  { name: "shared contracts", pattern: "/packages/shared/**" },
  { name: "client runtime", pattern: "/packages/client/src/runtime/**" },
  { name: "server runtime", pattern: "/packages/server/src/runtime/**" },
  { name: "IM providers", pattern: "/packages/server/src/services/im-bindings/**" },
  { name: "Web", pattern: "/apps/web/**" },
  { name: "CLI", pattern: "/apps/cli/**" },
  { name: "migrations", pattern: "/packages/server/drizzle/**" },
  { name: "CI and release", pattern: "/.github/**" },
  { name: "CI and release", pattern: "/scripts/**" },
  { name: "CI and release", pattern: "/turbo.json" },
  { name: "CI and release", pattern: "/Dockerfile" },
];

function readRules() {
  const lines = readFileSync(CODEOWNERS_PATH, "utf8").split(/\r?\n/);
  return lines.flatMap((line, index) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return [];

    const fields = trimmed.split(/\s+/);
    assert.ok(fields.length >= 2, `CODEOWNERS line ${index + 1} has no owner: ${line}`);
    return [{ line: index + 1, pattern: fields[0], owners: fields.slice(1) }];
  });
}

function patternToRegExp(pattern) {
  const source = pattern.startsWith("/") ? pattern.slice(1) : pattern;
  let expression = "";
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === "*" && source[index + 1] === "*") {
      expression += ".*";
      index += 1;
    } else if (character === "*") {
      expression += "[^/]*";
    } else if (character === "?") {
      expression += "[^/]";
    } else {
      expression += character.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
    }
  }
  return new RegExp(`^${expression}$`);
}

function repositoryPaths() {
  return execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
  })
    .split(/\r?\n/)
    .filter(Boolean);
}

test("CODEOWNERS parses with an owner on every rule", () => {
  const rules = readRules();
  assert.ok(rules.length > 0, "CODEOWNERS must contain at least one rule");
  for (const rule of rules) {
    assert.deepEqual(rule.owners, ["@bestony"], `CODEOWNERS line ${rule.line} must use @bestony only`);
  }
});

test("every CODEOWNERS pattern matches an existing repository path", () => {
  const paths = repositoryPaths();
  for (const rule of readRules()) {
    const matcher = patternToRegExp(rule.pattern);
    assert.ok(
      paths.some((path) => matcher.test(path)),
      `CODEOWNERS pattern has no matching path: ${rule.pattern}`,
    );
  }
});

test("CODEOWNERS covers each approved high-risk seam", () => {
  const patterns = new Set(readRules().map((rule) => rule.pattern));
  for (const seam of REQUIRED_SEAMS) {
    assert.ok(patterns.has(seam.pattern), `${seam.name} is missing ${seam.pattern}`);
  }
});
