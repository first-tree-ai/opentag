import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { stringify } from "yaml";

/**
 * The generator enforces every catalog invariant so an invalid entry cannot reach a user. These
 * tests drive it as a process, which is also how `pnpm check` runs it.
 *
 * No test reaches the network. The outbound check it applies (`checkOutboundUrl`) decides only what a
 * URL spells — scheme, credentials, fragment, IP-literal ranges, loopback spellings — and name
 * resolution happens at request time in the Server, never here.
 */

const repositoryRoot = join(import.meta.dirname, "..", "..");
const generator = join(import.meta.dirname, "..", "generate-mcp-catalog.mjs");
const tsx = join(repositoryRoot, "node_modules", ".bin", "tsx");

const LOCALES = ["en", "zh"];

function category(overrides = {}) {
  return { id: "general", label: { en: "General", zh: "通用" }, order: 10, ...overrides };
}

function entry(overrides = {}) {
  return {
    id: "notion",
    name: "notion",
    title: { en: "Notion", zh: "Notion" },
    description: { en: "Docs and wikis.", zh: "文档与知识库。" },
    url: "https://mcp.notion.com/mcp",
    defaultAuthKind: "oauth",
    category: "general",
    website: "https://www.notion.com",
    icon: "notion.svg",
    order: 10,
    ...overrides,
  };
}

/** A fixture repository holding only what the generator reads. */
function fixtureDirectory(t, { categories = [category()], entries = [entry()], icons = ["notion.svg"] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "opentag-mcp-catalog-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const catalogDirectory = join(root, "apps/web/src/features/mcp/catalog");
  const iconDirectory = join(root, "apps/web/src/assets/mcp");
  mkdirSync(catalogDirectory, { recursive: true });
  mkdirSync(iconDirectory, { recursive: true });
  mkdirSync(join(root, "apps/web/project.inlang"), { recursive: true });
  writeFileSync(
    join(root, "apps/web/project.inlang/settings.json"),
    JSON.stringify({ baseLocale: "en", locales: LOCALES }),
  );
  writeFileSync(join(catalogDirectory, "mcp-categories.yaml"), stringify(categories));
  writeFileSync(join(catalogDirectory, "mcp-catalog.yaml"), stringify(entries));
  for (const icon of icons) writeFileSync(join(iconDirectory, icon), "<svg/>");
  return {
    root,
    catalogDirectory,
    target: join(catalogDirectory, "mcp-catalog.gen.ts"),
    entriesPath: join(catalogDirectory, "mcp-catalog.yaml"),
  };
}

function runGenerator(root, ...args) {
  const result = spawnSync(tsx, [generator, "--root", root, ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Run the generator and assert it refused the catalog, naming the offending field. */
function assertRejected(t, expected, options) {
  const fixture = fixtureDirectory(t, options);
  const result = runGenerator(fixture.root);
  assert.notEqual(result.status, 0, `expected a failure, got:\n${result.stderr}`);
  assert.match(result.stderr, expected);
  return result;
}

test("writes a module carrying every entry", (t) => {
  const fixture = fixtureDirectory(t, {
    categories: [category(), category({ id: "engineering", label: { en: "Engineering", zh: "工程" }, order: 20 })],
    entries: [entry(), entry({ id: "linear", name: "linear", category: "engineering", icon: "linear.svg" })],
    icons: ["notion.svg", "linear.svg"],
  });
  const result = runGenerator(fixture.root);
  assert.equal(result.status, 0, result.stderr);
  const generated = readFileSync(fixture.target, "utf8");
  assert.match(generated, /export const MCP_CATALOG_ENTRIES/);
  assert.match(generated, /id: "notion"/);
  assert.match(generated, /id: "linear"/);
});

test("rejects an endpoint the outbound policy refuses", (t) => {
  assertRejected(t, /non-public address/, { entries: [entry({ url: "https://10.0.0.1/mcp" })] });
});

test("rejects plain HTTP to a non-loopback host", (t) => {
  assertRejected(t, /Plain HTTP is only allowed for a loopback host/, {
    entries: [entry({ url: "http://mcp.example.com/mcp" })],
  });
});

test("rejects an underscore in the Server name", (t) => {
  assertRejected(t, /name:/, { entries: [entry({ name: "notion_srv" })] });
});

test("rejects an undeclared category", (t) => {
  assertRejected(t, /is not declared in mcp-categories\.yaml/, { entries: [entry({ category: "sales" })] });
});

test("rejects a declared category no entry references", (t) => {
  assertRejected(t, /declared but no entry references it/, {
    categories: [category(), category({ id: "sales", label: { en: "Sales", zh: "销售" }, order: 20 })],
  });
});

test("rejects a duplicate entry id", (t) => {
  assertRejected(t, /duplicate entry id/, { entries: [entry(), entry({ name: "notion-two" })] });
});

test("rejects a missing locale", (t) => {
  assertRejected(t, /missing the "zh" locale/, { entries: [entry({ title: { en: "Notion" } })] });
});

test("rejects an unknown locale", (t) => {
  assertRejected(t, /unknown locale\(s\) fr/, {
    entries: [entry({ description: { en: "Docs.", zh: "文档。", fr: "Documents." } })],
  });
});

test("rejects a missing icon file", (t) => {
  assertRejected(t, /does not exist under apps\/web\/src\/assets\/mcp\//, { icons: [] });
});

test("rejects an unknown default authorization kind", (t) => {
  assertRejected(t, /defaultAuthKind/, { entries: [entry({ defaultAuthKind: "api-key" })] });
});

test("rejects drift between the sources and the generated module", (t) => {
  const fixture = fixtureDirectory(t);
  assert.equal(runGenerator(fixture.root).status, 0);
  assert.equal(runGenerator(fixture.root, "--check").status, 0);
  writeFileSync(fixture.entriesPath, stringify([entry({ description: { en: "Changed.", zh: "已更改。" } })]));
  const drifted = runGenerator(fixture.root, "--check");
  assert.notEqual(drifted.status, 0);
  assert.match(drifted.stderr, /out of date/);
});
