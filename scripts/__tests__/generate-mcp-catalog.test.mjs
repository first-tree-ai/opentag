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
    schema_version: 1,
    id: "mcp/notion",
    kind: "mcp",
    name: { en: "Notion", zh: "Notion" },
    summary: { en: "Docs and wikis.", zh: "文档与知识库。" },
    when_to_use: { en: "Use for docs.", zh: "用于文档。" },
    capabilities: ["search-docs"],
    status: "active",
    auth: { methods: ["oauth"], default_kind: "oauth", oauth: {} },
    risk: { side_effects: "write", data_access: "private" },
    remotes: [{ type: "streamable-http", url: "https://mcp.notion.com/mcp" }],
    catalog: { category: "general", order: 10, icon: "notion.svg", icon_is_official: false },
    homepage: "https://www.notion.com",
    ...overrides,
  };
}

/** An entry with the given nested fields merged over its defaults. */
function nested(key, patch) {
  return entry({ [key]: { ...entry()[key], ...patch } });
}

/** A fixture repository holding only what the generator reads. */
function fixtureDirectory(t, { categories = [category()], entries = [entry()], icons = ["notion.svg"] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "opentag-mcp-catalog-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const catalogDirectory = join(root, "packages/mcp-presets");
  const iconDirectory = join(catalogDirectory, "icons");
  mkdirSync(join(catalogDirectory, "src"), { recursive: true });
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
    target: join(catalogDirectory, "src/mcp-catalog.gen.ts"),
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
    entries: [
      entry(),
      entry({
        id: "mcp/linear",
        catalog: { category: "engineering", order: 10, icon: "linear.svg", icon_is_official: false },
      }),
    ],
    icons: ["notion.svg", "linear.svg"],
  });
  const result = runGenerator(fixture.root);
  assert.equal(result.status, 0, result.stderr);
  const generated = readFileSync(fixture.target, "utf8");
  assert.match(generated, /export const MCP_CATALOG_ENTRIES/);
  assert.match(generated, /id: "notion"/);
  assert.match(generated, /id: "linear"/);
  assert.match(generated, /export type McpCatalogLocale = "en" \| "zh";/);
  assert.match(generated, /iconUrl: MCP_CATALOG_ICON_URLS\["notion\.svg"\]/);
  assert.doesNotMatch(generated, /import .*\.svg/);
});

test("exposes the registry identity and the derived flat fields", (t) => {
  const fixture = fixtureDirectory(t);
  assert.equal(runGenerator(fixture.root).status, 0);
  const generated = readFileSync(fixture.target, "utf8");
  assert.match(generated, /id: "notion"/);
  assert.match(generated, /registryId: "mcp\/notion"/);
  assert.match(generated, /url: "https:\/\/mcp\.notion\.com\/mcp"/);
  assert.match(generated, /defaultAuthKind: "oauth"/);
  assert.match(generated, /export const MCP_CATALOG_ENTRY_SCHEMA/);
});

test("rejects an endpoint the outbound policy refuses", (t) => {
  assertRejected(t, /remotes\[0\]\.url: .*non-public address/, {
    entries: [entry({ remotes: [{ type: "streamable-http", url: "https://10.0.0.1/mcp" }] })],
  });
});

test("rejects a plain HTTP remote", (t) => {
  assertRejected(t, /remotes\[0\]\.url: must match pattern/, {
    entries: [entry({ remotes: [{ type: "streamable-http", url: "http://mcp.example.com/mcp" }] })],
  });
});

/** A self-hosted package a catalog may record as data. */
function stdioPackage(overrides = {}) {
  return {
    registry_type: "npm",
    identifier: "@scope/server",
    version: "1.2.3",
    runtime_hint: "npx",
    transport: "stdio",
    ...overrides,
  };
}

/** An entry with packages and no remote. */
function packagesOnly(overrides = {}) {
  const { remotes: _remotes, ...rest } = entry({ auth: { methods: ["none"], default_kind: "none" } });
  return { ...rest, packages: [stdioPackage()], ...overrides };
}

test("accepts a packages-only entry as data and marks it not installable", (t) => {
  const fixture = fixtureDirectory(t, {
    entries: [
      packagesOnly({
        prerequisites: ["Node.js 22"],
        platforms: ["linux", "macos"],
        packages: [
          stdioPackage({
            package_arguments: [
              { type: "named", name: "--port", value: "8080" },
              { type: "positional", value: "serve" },
            ],
            environment_variables: [{ name: "SERVER_API_KEY", is_secret: true, is_required: true }],
          }),
        ],
      }),
    ],
  });
  const result = runGenerator(fixture.root);
  assert.equal(result.status, 0, result.stderr);
  const generated = readFileSync(fixture.target, "utf8");
  assert.match(generated, /installable: false/);
  assert.match(generated, /registryType: "npm"/);
  assert.match(generated, /platforms: \["linux", "macos"\]/);
  const entryBlock = generated.slice(generated.indexOf("export const MCP_CATALOG_ENTRIES"));
  assert.doesNotMatch(entryBlock, /^\s{4}url:/m);
  assert.doesNotMatch(entryBlock, /^\s{4}defaultAuthKind:/m);
});

test("keeps a mixed entry installable through its streamable-http remote", (t) => {
  const fixture = fixtureDirectory(t, { entries: [entry({ packages: [stdioPackage()] })] });
  const result = runGenerator(fixture.root);
  assert.equal(result.status, 0, result.stderr);
  const generated = readFileSync(fixture.target, "utf8");
  assert.match(generated, /installable: true/);
  assert.match(generated, /url: "https:\/\/mcp\.notion\.com\/mcp"/);
  assert.match(generated, /registryType: "npm"/);
});

test("records an sse remote as data without making the entry installable", (t) => {
  const fixture = fixtureDirectory(t, {
    entries: [entry({ remotes: [{ type: "sse", url: "https://mcp.example.com/sse" }] })],
  });
  const result = runGenerator(fixture.root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(fixture.target, "utf8"), /installable: false/);
});

test("rejects an entry with neither packages nor remotes", (t) => {
  const { remotes: _remotes, ...rest } = entry();
  assertRejected(t, /must match a schema in anyOf/, { entries: [rest] });
});

test("rejects an unknown package registry type", (t) => {
  assertRejected(t, /packages\[0\]\.registry_type: must be one of npm, pypi, oci, nuget, mcpb/, {
    entries: [packagesOnly({ packages: [stdioPackage({ registry_type: "cargo" })] })],
  });
});

test("rejects a named package argument without a name", (t) => {
  assertRejected(t, /package_arguments\[0\]\.name: is required for a named argument/, {
    entries: [packagesOnly({ packages: [stdioPackage({ package_arguments: [{ type: "named", value: "1" }] })] })],
  });
});

test("rejects a secret that carries a default value", (t) => {
  assertRejected(t, /environment_variables\[0\]\.default: a secret must not carry a default/, {
    entries: [
      packagesOnly({
        packages: [stdioPackage({ environment_variables: [{ name: "SERVER_TOKEN", is_secret: true, default: "x" }] })],
      }),
    ],
  });
});

test("rejects a credential-looking secret variable that is not marked secret", (t) => {
  assertRejected(t, /environment_variables\[0\]\.is_secret: "SERVER_API_KEY" looks like a credential/, {
    entries: [packagesOnly({ packages: [stdioPackage({ environment_variables: [{ name: "SERVER_API_KEY" }] })] })],
  });
});

test("rejects a credential in a package value", (t) => {
  assertRejected(t, /environment_variables\[0\]\.value: looks like a credential/, {
    entries: [
      packagesOnly({
        packages: [
          stdioPackage({ environment_variables: [{ name: "REGION", value: "ghp_abcdefghijklmnopqrstuvwx" }] }),
        ],
      }),
    ],
  });
});

test("rejects a runtime hint that does not run the registry type", (t) => {
  assertRejected(t, /packages\[0\]\.runtime_hint: "uvx" does not run a npm package/, {
    entries: [packagesOnly({ packages: [stdioPackage({ runtime_hint: "uvx" })] })],
  });
});

test("rejects a fragment in an sse-only remote", (t) => {
  assertRejected(t, /remotes\[0\]\.url: .*fragment/i, {
    entries: [entry({ remotes: [{ type: "sse", url: "https://mcp.example.com/sse#frag" }] })],
  });
});

test("rejects credentials in a non-primary remote behind a valid primary", (t) => {
  assertRejected(t, /remotes\[1\]\.url: .*credentials/i, {
    entries: [
      entry({
        remotes: [
          { type: "streamable-http", url: "https://mcp.example.com/mcp" },
          { type: "sse", url: "https://demo:demo@mcp.example.com/sse" },
        ],
      }),
    ],
  });
});

test("rejects an oversized remote URL", (t) => {
  assertRejected(t, /remotes\[0\]\.url: /, {
    entries: [entry({ remotes: [{ type: "sse", url: `https://mcp.example.com/${"a".repeat(2100)}` }] })],
  });
});

test("rejects a loopback sse-only remote", (t) => {
  assertRejected(t, /remotes\[0\]\.url: /, {
    entries: [entry({ remotes: [{ type: "sse", url: "https://127.0.0.1:8443/sse" }] })],
  });
});

test("reports a bad primary remote URL once", (t) => {
  const result = assertRejected(t, /remotes\[0\]\.url: /, {
    entries: [entry({ remotes: [{ type: "streamable-http", url: "https://demo:demo@mcp.example.com/mcp" }] })],
  });
  assert.equal((result.stderr.match(/remotes\[0\]\.url: /g) ?? []).length, 1);
});

test("rejects an unknown key", (t) => {
  assertRejected(t, /\.surprise: unknown property/, { entries: [entry({ surprise: true })] });
});

test("rejects an invalid status", (t) => {
  assertRejected(t, /\.status: must be one of active, deprecated, archived, removed/, {
    entries: [entry({ status: "beta" })],
  });
});

test("rejects an id outside the registry namespace", (t) => {
  assertRejected(t, /\.id: must match pattern/, { entries: [entry({ id: "notion_srv" })] });
});

test("rejects an undeclared category", (t) => {
  assertRejected(t, /catalog\.category: "sales" is not declared in mcp-categories\.yaml/, {
    entries: [nested("catalog", { category: "sales" })],
  });
});

test("rejects a declared category no entry references", (t) => {
  assertRejected(t, /declared but no entry references it/, {
    categories: [category(), category({ id: "sales", label: { en: "Sales", zh: "销售" }, order: 20 })],
  });
});

test("rejects a duplicate entry id", (t) => {
  assertRejected(t, /duplicate entry id "mcp\/notion"/, { entries: [entry(), entry()] });
});

test("rejects a missing locale", (t) => {
  assertRejected(t, /\.name\.zh: is required/, { entries: [entry({ name: { en: "Notion" } })] });
});

test("rejects an unknown locale", (t) => {
  assertRejected(t, /\.summary\.fr: unknown property/, {
    entries: [entry({ summary: { en: "Docs.", zh: "文档。", fr: "Documents." } })],
  });
});

test("rejects a missing icon file", (t) => {
  assertRejected(t, /does not exist under packages\/mcp-presets\/icons\//, { icons: [] });
});

test("rejects an unknown default authorization kind", (t) => {
  assertRejected(t, /auth\.default_kind: must be one of none, bearer, oauth/, {
    entries: [nested("auth", { default_kind: "api-key" })],
  });
});

test("rejects a default kind outside the listed methods", (t) => {
  assertRejected(t, /auth\.default_kind: "none" is not listed in auth\.methods/, {
    entries: [nested("auth", { default_kind: "none" })],
  });
});

test("rejects the oauth method without an oauth block", (t) => {
  assertRejected(t, /auth\.oauth: is required when auth\.methods lists "oauth"/, {
    entries: [entry({ auth: { methods: ["oauth"], default_kind: "oauth" } })],
  });
});

test("rejects an oauth block without the oauth method", (t) => {
  assertRejected(t, /auth\.oauth: is only allowed when auth\.methods lists "oauth"/, {
    entries: [entry({ auth: { methods: ["none"], default_kind: "none", oauth: {} } })],
  });
});

test("rejects a risk weaker than a destructive tool", (t) => {
  assertRejected(t, /risk\.side_effects: "write" is weaker than the strongest tool side effect/, {
    entries: [entry({ tools: [{ name: "delete_page", side_effect: "destructive" }] })],
  });
});

test("rejects a duplicate tool name", (t) => {
  assertRejected(t, /tools\[1\]\.name: duplicate tool "search"/, {
    entries: [
      entry({
        tools: [
          { name: "search", side_effect: "none" },
          { name: "search", side_effect: "none" },
        ],
      }),
    ],
  });
});

test("carries an entry's OAuth scopes into the generated module", (t) => {
  const fixture = fixtureDirectory(t, {
    entries: [
      nested("auth", {
        oauth: {
          scopes: ["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.compose"],
        },
      }),
    ],
  });
  const result = runGenerator(fixture.root);
  assert.equal(result.status, 0, result.stderr);
  const generated = readFileSync(fixture.target, "utf8");
  assert.match(generated, /oauthScopes\?: string\[\];/);
  assert.match(generated, /"https:\/\/www\.googleapis\.com\/auth\/gmail\.readonly"/);
  assert.match(generated, /"https:\/\/www\.googleapis\.com\/auth\/gmail\.compose"/);
});

test("omits oauthScopes for an entry that declares none", (t) => {
  const fixture = fixtureDirectory(t);
  assert.equal(runGenerator(fixture.root).status, 0);
  assert.doesNotMatch(readFileSync(fixture.target, "utf8"), /^\s+oauthScopes:/m);
});

test("rejects an empty scope string", (t) => {
  assertRejected(t, /oauth\.scopes\[1\]: must match pattern/, {
    entries: [nested("auth", { oauth: { scopes: ["mcp.read", "  "] } })],
  });
});

test("rejects an empty scope list", (t) => {
  assertRejected(t, /oauth\.scopes: must NOT have fewer than 1 items/, {
    entries: [nested("auth", { oauth: { scopes: [] } })],
  });
});

test("rejects more scopes than a start request accepts", (t) => {
  assertRejected(t, /oauth\.scopes: must NOT have more than 64 items/, {
    entries: [nested("auth", { oauth: { scopes: Array.from({ length: 65 }, (_, index) => `scope-${index}`) } })],
  });
});

test("rejects a scope longer than a start request accepts", (t) => {
  assertRejected(t, /oauth\.scopes\[0\]: must NOT have more than 255 characters/, {
    entries: [nested("auth", { oauth: { scopes: ["x".repeat(256)] } })],
  });
});

test("withholds a removed entry from the generated module", (t) => {
  const fixture = fixtureDirectory(t, {
    entries: [entry(), entry({ id: "mcp/gone", status: "removed" })],
  });
  assert.equal(runGenerator(fixture.root).status, 0);
  const generated = readFileSync(fixture.target, "utf8");
  assert.match(generated, /id: "notion"/);
  assert.doesNotMatch(generated, /id: "gone"/);
});

test("maps an auth header and an extra header into the create payload", (t) => {
  const fixture = fixtureDirectory(t, {
    entries: [
      entry({
        auth: { methods: ["bearer"], default_kind: "bearer" },
        remotes: [
          {
            type: "streamable-http",
            url: "https://mcp.example.com/mcp",
            headers: [
              { name: "X-Api-Key", role: "auth", scheme: "Token" },
              { name: "X-Region", role: "extra", value: "eu" },
            ],
          },
        ],
      }),
    ],
  });
  const result = runGenerator(fixture.root);
  assert.equal(result.status, 0, result.stderr);
  const generated = readFileSync(fixture.target, "utf8");
  assert.match(generated, /authHeader: "X-Api-Key"/);
  assert.match(generated, /authScheme: "Token"/);
  assert.match(generated, /"X-Region": "eu"/);
});

test("rejects drift between the sources and the generated module", (t) => {
  const fixture = fixtureDirectory(t);
  assert.equal(runGenerator(fixture.root).status, 0);
  assert.equal(runGenerator(fixture.root, "--check").status, 0);
  writeFileSync(fixture.entriesPath, stringify([entry({ summary: { en: "Changed.", zh: "已更改。" } })]));
  const drifted = runGenerator(fixture.root, "--check");
  assert.notEqual(drifted.status, 0);
  assert.match(drifted.stderr, /out of date/);
});

test("embeds a PNG provider asset with its correct media type", (t) => {
  const fixture = fixtureDirectory(t, {
    entries: [nested("catalog", { icon: "notion.png", icon_is_official: true })],
    icons: ["notion.png"],
  });
  const result = runGenerator(fixture.root);
  assert.equal(result.status, 0, result.stderr);
  const generated = readFileSync(fixture.target, "utf8");
  assert.match(generated, /data:image\/png;base64,/);
  assert.match(generated, /iconIsOfficial: true/);
});

test("keeps unverified assets unmarked and rejects invalid official-mark metadata", (t) => {
  const fixture = fixtureDirectory(t);
  assert.equal(runGenerator(fixture.root).status, 0);
  assert.doesNotMatch(readFileSync(fixture.target, "utf8"), /iconIsOfficial: true/);
  assertRejected(t, /catalog\.icon_is_official: must be boolean/, {
    entries: [nested("catalog", { icon_is_official: "yes" })],
  });
});

test("emits an alternate key endpoint with an empty prefix", (t) => {
  const fixture = fixtureDirectory(t, {
    entries: [
      nested("auth", {
        methods: ["oauth", "bearer"],
        bearer: { url: "https://api.example.com/mcp", auth_header: "x-api-key", auth_scheme: "" },
      }),
    ],
  });
  const result = runGenerator(fixture.root);
  assert.equal(result.status, 0, result.stderr);
  const generated = readFileSync(fixture.target, "utf8");
  assert.match(
    generated,
    /keyAuth: \{\s+url: "https:\/\/api.example.com\/mcp",\s+authHeader: "x-api-key",\s+authScheme: "",/,
  );
});
for (const bearer of [
  { url: "http://127.0.0.1/mcp" },
  { url: "https://api.example.com/mcp", auth_header: "Host" },
  { url: "https://api.example.com/mcp", defaultAuthKind: "none" },
  { url: "https://api.example.com/mcp", bearerKey: "secret" },
]) {
  test(`rejects invalid alternate key settings ${JSON.stringify(bearer)}`, (t) => {
    assertRejected(t, /auth\.bearer/, { entries: [nested("auth", { methods: ["oauth", "bearer"], bearer })] });
  });
}

test("rejects a key connection when bearer is not a supported method", (t) => {
  assertRejected(t, /auth\.bearer/, {
    entries: [nested("auth", { bearer: { url: "https://api.example.com/mcp" } })],
  });
});
