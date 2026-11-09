import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  assertWebGeneratedUtilities,
  containsCssUtilitySelector,
  REQUIRED_WEB_UTILITIES,
  toCssClassSelectorBody,
} from "../assert-web-generated-utilities.mjs";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function withTempDir(run) {
  const dir = mkdtempSync(join(tmpdir(), "opentag-web-utilities-"));
  try {
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function readFilesWithExtensions(dir, extensions) {
  const chunks = [];
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (!extensions.some((ext) => entry.name.endsWith(ext))) continue;
    chunks.push(readFileSync(join(entry.parentPath, entry.name), "utf8"));
  }
  return chunks.join("\n");
}

describe("assertWebGeneratedUtilities", () => {
  it("matches exact CSS utility selectors and rejects prefix collisions", () => {
    assert.equal(containsCssUtilitySelector(".h-9{height:2.25rem}", "h-9"), true);
    assert.equal(containsCssUtilitySelector(".px-2\\.5{padding-inline:.625rem}", "px-2.5"), true);
    assert.equal(
      containsCssUtilitySelector(".last\\:border-b-0:last-child{border-bottom-width:0}", "last:border-b-0"),
      true,
    );
    assert.equal(
      containsCssUtilitySelector("@media (width<48rem){.max-md\\:min-h-11{min-height:2.75rem}}", "max-md:min-h-11"),
      true,
    );
    assert.equal(
      containsCssUtilitySelector(
        ".divide-kumo-line>:not(:last-child){border-color:var(--color-kumo-line)}",
        "divide-kumo-line",
      ),
      true,
    );

    assert.equal(containsCssUtilitySelector(".h-96{height:24rem}", "h-9"), false);
    assert.equal(containsCssUtilitySelector(".size-8\\.5{width:2.125rem}", "size-8"), false);
    assert.equal(containsCssUtilitySelector(".px-25{padding-inline:6.25rem}", "px-2.5"), false);
  });

  it("passes when all required utilities are present across generated CSS assets", () => {
    withTempDir((dir) => {
      const assetsDir = join(dir, "assets");
      mkdirSync(assetsDir, { recursive: true });
      const css = REQUIRED_WEB_UTILITIES.map(({ utility }) => `.${toCssClassSelectorBody(utility)}{content:""}`).join(
        "\n",
      );
      writeFileSync(join(assetsDir, "index-abc123.css"), css);

      const result = assertWebGeneratedUtilities({ assetsDir });
      assert.deepEqual(result, {
        cssFiles: ["index-abc123.css"],
        verifiedCount: REQUIRED_WEB_UTILITIES.length,
      });
    });
  });

  it("fails when the build assets directory is missing or contains no CSS files", () => {
    withTempDir((dir) => {
      const missingDir = join(dir, "missing-assets");
      assert.throws(() => assertWebGeneratedUtilities({ assetsDir: missingDir }), /Missing web build assets directory/);

      mkdirSync(missingDir, { recursive: true });
      writeFileSync(join(missingDir, "index-abc123.js"), "console.log('no css');");
      assert.throws(() => assertWebGeneratedUtilities({ assetsDir: missingDir }), /No generated CSS assets found/);
    });
  });

  it("reports missing Kumo or application utilities with source and reason", () => {
    withTempDir((dir) => {
      const assetsDir = join(dir, "assets");
      mkdirSync(assetsDir, { recursive: true });
      const onlyWebCss = REQUIRED_WEB_UTILITIES.filter(({ source }) => source === "web")
        .map(({ utility }) => `.${toCssClassSelectorBody(utility)}{content:""}`)
        .join("\n");
      writeFileSync(join(assetsDir, "index-web-only.css"), onlyWebCss);

      assert.throws(
        () => assertWebGeneratedUtilities({ assetsDir }),
        /missing required Tailwind utilities: .*\.bg-kumo-badge-blue \[kumo\] \(Kumo badge palette\)/,
      );
    });
  });

  it("keeps Kumo and web probe utilities mutually exclusive between scan sources", () => {
    const kumoProbes = REQUIRED_WEB_UTILITIES.filter(({ source }) => source === "kumo");
    const webProbes = REQUIRED_WEB_UTILITIES.filter(({ source }) => source === "web");
    assert.ok(kumoProbes.length > 0, "Expected at least one Kumo utility probe");
    assert.ok(webProbes.length > 0, "Expected at least one web utility probe");

    const kumoDistDir = resolve(rootDir, "apps/web/node_modules/@cloudflare/kumo/dist");
    const kumoJs = readFilesWithExtensions(kumoDistDir, [".js"]);
    const webSource = [
      readFilesWithExtensions(resolve(rootDir, "apps/web/src"), [".ts", ".tsx", ".css"]),
      readFileSync(resolve(rootDir, "apps/web/index.html"), "utf8"),
    ].join("\n");

    for (const { utility } of kumoProbes) {
      assert.equal(
        kumoJs.includes(utility),
        true,
        `Expected Kumo probe "${utility}" to appear in @cloudflare/kumo/dist`,
      );
      assert.equal(
        webSource.includes(utility),
        false,
        `Expected Kumo probe "${utility}" to stay absent from apps/web so a broken @source is not masked`,
      );
    }

    for (const { utility } of webProbes) {
      assert.equal(webSource.includes(utility), true, `Expected web probe "${utility}" to appear in apps/web/src`);
      assert.equal(
        kumoJs.includes(utility),
        false,
        `Expected web probe "${utility}" to stay absent from @cloudflare/kumo/dist so a broken app scan is not masked`,
      );
    }
  });
});
