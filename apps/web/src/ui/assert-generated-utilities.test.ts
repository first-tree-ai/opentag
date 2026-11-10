import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  assertWebGeneratedUtilities,
  containsCssUtilitySelector,
  REQUIRED_WEB_UTILITIES,
  toCssClassSelectorBody,
} from "../../scripts/assert-generated-utilities.mjs";

const testFilePath = fileURLToPath(import.meta.url);
const webRootDir = resolve(dirname(testFilePath), "../..");
const scriptFilePath = resolve(webRootDir, "scripts/assert-generated-utilities.mjs");

function withTempDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "opentag-web-utilities-"));
  try {
    run(dir);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}

function readFilesWithExtensions(dir: string, extensions: string[], excludePaths = new Set<string>()): string {
  const chunks: string[] = [];
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (!extensions.some((ext) => entry.name.endsWith(ext))) continue;
    const fullPath = resolve(entry.parentPath, entry.name);
    if (excludePaths.has(fullPath)) continue;
    chunks.push(readFileSync(fullPath, "utf8"));
  }
  return chunks.join("\n");
}

describe("assertWebGeneratedUtilities", () => {
  it("matches exact CSS utility selectors and rejects prefix collisions", () => {
    const h9 = ["h", "9"].join("-");
    const px25 = ["px", "2.5"].join("-");
    const lastBorderB0 = ["last:border", "b", "0"].join("-");
    const maxMdMinH11 = ["max", "md:min", "h", "11"].join("-");
    const divideKumoLine = ["divide", "kumo", "line"].join("-");
    const size8 = ["size", "8"].join("-");

    expect(containsCssUtilitySelector(`.${toCssClassSelectorBody(h9)}{height:2.25rem}`, h9)).toBe(true);
    expect(containsCssUtilitySelector(`.${toCssClassSelectorBody(px25)}{padding-inline:.625rem}`, px25)).toBe(true);
    expect(
      containsCssUtilitySelector(
        `.${toCssClassSelectorBody(lastBorderB0)}:last-child{border-bottom-width:0}`,
        lastBorderB0,
      ),
    ).toBe(true);
    expect(
      containsCssUtilitySelector(
        `@media (width<48rem){.${toCssClassSelectorBody(maxMdMinH11)}{min-height:2.75rem}}`,
        maxMdMinH11,
      ),
    ).toBe(true);
    expect(
      containsCssUtilitySelector(
        `.${toCssClassSelectorBody(divideKumoLine)}>:not(:last-child){border-color:var(--color-kumo-line)}`,
        divideKumoLine,
      ),
    ).toBe(true);

    expect(containsCssUtilitySelector(`.${toCssClassSelectorBody(h9)}6{height:24rem}`, h9)).toBe(false);
    expect(containsCssUtilitySelector(`.${toCssClassSelectorBody(size8)}\\.5{width:2.125rem}`, size8)).toBe(false);
    expect(containsCssUtilitySelector(".px-25{padding-inline:6.25rem}", px25)).toBe(false);
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
      expect(result).toEqual({
        cssFiles: ["index-abc123.css"],
        verifiedCount: REQUIRED_WEB_UTILITIES.length,
      });
    });
  });

  it("fails when the build assets directory is missing or contains no CSS files", () => {
    withTempDir((dir) => {
      const missingDir = join(dir, "missing-assets");
      expect(() => assertWebGeneratedUtilities({ assetsDir: missingDir })).toThrow(
        /Missing web build assets directory/,
      );

      mkdirSync(missingDir, { recursive: true });
      writeFileSync(join(missingDir, "index-abc123.js"), "console.log('no css');");
      expect(() => assertWebGeneratedUtilities({ assetsDir: missingDir })).toThrow(/No generated CSS assets found/);
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

      const expectedMissing = `${[".bg", "kumo", "badge", "blue"].join("-")} [kumo] (Kumo badge palette)`;
      expect(() => assertWebGeneratedUtilities({ assetsDir })).toThrow(expectedMissing);
    });
  });

  it("never embeds literal probe class tokens in the assertion script or its test file", () => {
    const scriptText = readFileSync(scriptFilePath, "utf8");
    const testText = readFileSync(testFilePath, "utf8");

    for (const { utility } of REQUIRED_WEB_UTILITIES) {
      expect(scriptText).not.toContain(utility);
      expect(testText).not.toContain(utility);
    }
  });

  it("keeps Kumo and web probe utilities mutually exclusive between scan sources", () => {
    const kumoProbes = REQUIRED_WEB_UTILITIES.filter(({ source }) => source === "kumo");
    const webProbes = REQUIRED_WEB_UTILITIES.filter(({ source }) => source === "web");
    expect(kumoProbes.length).toBeGreaterThan(0);
    expect(webProbes.length).toBeGreaterThan(0);

    const kumoDistDir = resolve(webRootDir, "node_modules/@cloudflare/kumo/dist");
    const kumoJs = readFilesWithExtensions(kumoDistDir, [".js"]);
    const webSource = [
      readFilesWithExtensions(resolve(webRootDir, "src"), [".ts", ".tsx", ".css"]),
      readFilesWithExtensions(resolve(webRootDir, "scripts"), [".mjs", ".js", ".ts"]),
      readFileSync(resolve(webRootDir, "index.html"), "utf8"),
    ].join("\n");

    for (const { utility } of kumoProbes) {
      expect(kumoJs.includes(utility)).toBe(true);
      expect(webSource.includes(utility)).toBe(false);
    }

    for (const { utility } of webProbes) {
      expect(webSource.includes(utility)).toBe(true);
      expect(kumoJs.includes(utility)).toBe(false);
    }
  });
});
