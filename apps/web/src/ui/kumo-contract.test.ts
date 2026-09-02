import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "@babel/parser";
import postcss from "postcss";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const moduleSourceFiles = readdirSync(root, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name) && !entry.name.includes(".test."))
  .map((entry) => resolve(entry.parentPath, entry.name));
const sourceFiles = moduleSourceFiles.filter((file) => file.endsWith(".tsx"));
const source = sourceFiles.map((file) => readFileSync(resolve(root, file), "utf8")).join("\n");
const appCss = readFileSync(resolve(root, "app.css"), "utf8");
const main = readFileSync(resolve(root, "main.tsx"), "utf8");
const viteConfig = readFileSync(resolve(root, "..", "vite.config.ts"), "utf8");
const productModules = moduleSourceFiles
  .map((file) => {
    const content = readFileSync(file, "utf8");
    const path = sourcePath(file);
    return { content, imports: moduleSpecifiers(content, path), path };
  })
  .filter((entry) => !entry.path.startsWith("__tests__/"));
const stylesheets = readdirSync(root, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith(".css"))
  .map((entry) => {
    const file = resolve(entry.parentPath, entry.name);
    return { content: readFileSync(file, "utf8"), path: sourcePath(file) };
  });

function sourcePath(file: string): string {
  return relative(root, file).replaceAll("\\", "/");
}

function moduleSpecifiers(content: string, path = "contract-fixture.tsx"): string[] {
  const syntax = parse(content, {
    createImportExpressions: true,
    plugins: ["typescript", "jsx"],
    sourceFilename: path,
    sourceType: "module",
  });
  const specifiers: string[] = [];

  walkSyntax(syntax, (node) => {
    if (
      node.type === "ImportDeclaration" ||
      node.type === "ExportNamedDeclaration" ||
      node.type === "ExportAllDeclaration" ||
      node.type === "ImportExpression"
    ) {
      const specifier = stringNodeValue(node.source);
      if (specifier) specifiers.push(specifier);
    }
  });

  return specifiers;
}

function walkSyntax(value: unknown, visit: (node: Record<string, unknown>) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) walkSyntax(item, visit);
    return;
  }
  if (!value || typeof value !== "object") return;

  const node = value as Record<string, unknown>;
  if (typeof node.type === "string") visit(node);
  for (const [key, child] of Object.entries(node)) {
    if (key === "loc" || key === "extra") continue;
    walkSyntax(child, visit);
  }
}

function stringNodeValue(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = (value as Record<string, unknown>).value;
  return typeof candidate === "string" ? candidate : undefined;
}

function stylesheetImportSpecifiers(content: string, path = "contract-fixture.css"): string[] {
  const specifiers: string[] = [];
  postcss.parse(content, { from: path }).walkAtRules("import", (atRule) => {
    const match = atRule.params.match(/^\s*(?:url\(\s*)?["']([^"']+)["']|^\s*url\(\s*([^\s)]+)\s*\)|^\s*([^\s;]+)/);
    const specifier = match?.[1] ?? match?.[2] ?? match?.[3];
    specifiers.push(specifier ?? `<unresolved: ${atRule.params}>`);
  });
  return specifiers;
}

function isStylesheetSpecifier(specifier: string): boolean {
  return (specifier.split(/[?#]/, 1)[0] ?? "").endsWith(".css");
}

function hasRawColorLiteral(content: string): boolean {
  const hex = /#(?:[\da-f]{8}|[\da-f]{6}|[\da-f]{4}|[\da-f]{3})(?![\da-f])/i;
  const functional = /(?:^|[^\w-])(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(\s*[^)]/i;
  return hex.test(content) || functional.test(content);
}

describe("Kumo integration contract", () => {
  it("compiles application and Kumo utilities through Tailwind", () => {
    expect(source).not.toContain("@cloudflare/kumo/styles/standalone");
    expect(main).toContain('import "./app.css"');
    expect(appCss).toContain('@import "@cloudflare/kumo/styles/tailwind"');
    expect(appCss).toContain('@import "tailwindcss"');
    expect(appCss).toContain('@source "../node_modules/@cloudflare/kumo/dist/**/*.{js,jsx,ts,tsx}"');
    expect(viteConfig).toContain('from "@tailwindcss/vite"');
    expect(viteConfig).toContain("tailwindcss()");
    expect(source).not.toMatch(/(?:styles|mock-pages|tasks-page|agent-usage)\.css/);
    expect(existsSync(resolve(root, "styles.css"))).toBe(false);
    expect(existsSync(resolve(root, "ui/design-system.css"))).toBe(false);
  });

  it("does not carry the retired token or typography skin", () => {
    expect(source).not.toMatch(/var\(--(?:background|surface|foreground|brand|border|warning|success|error)\)/);
    expect(source).not.toMatch(/\btracking-[a-z-]+\b|\bfont-bold\b/);
    expect(source).not.toMatch(
      /className=(?:"[^"]*|\{`[^`]*)(?:login-|agent-card-|onboarding-|tasks-|ds-|skills-|integrations-|agent-usage-|agent-create-|agent-runtime-|agent-settings-|im-)/,
    );
  });

  it("keeps generic Kumo surfaces neutral and reserves brand soft for selection", () => {
    expect(appCss).toContain("--color-kumo-recessed: var(--surface-recessed)");
    expect(appCss).toContain("--color-kumo-tint: var(--surface-tint)");
    expect(appCss).toContain("--color-kumo-fill-hover: var(--surface-hover)");
    expect(appCss).not.toMatch(/--color-kumo-(?:recessed|tint|fill-hover): var\(--brand-soft\)/);
  });

  it("uses the semantic adapter and real Kumo controls", () => {
    const adapter = readFileSync(resolve(root, "ui/design-system.tsx"), "utf8");
    expect(adapter).toContain("@cloudflare/kumo");
    expect(adapter).toContain("KumoSelect.Option");
    expect(adapter).toContain("Dialog.Root");
    expect(adapter).toContain("onOpenChange");
    expect(adapter).toContain("@phosphor-icons/react");
    expect(source).not.toMatch(/data-kumo-component|kumo-select/);
  });

  it("keeps direct Kumo imports behind the approved product seams", () => {
    const violations = productModules
      .filter(({ imports }) => imports.some((specifier) => /^@cloudflare\/kumo(?:\/|$)/.test(specifier)))
      .map(({ path }) => path)
      .filter((path) => path !== "app.tsx" && path !== "ui/design-system.tsx" && !path.startsWith("components/kumo/"));

    expect(violations).toEqual([]);
  });

  it("keeps module-owned stylesheet imports at reviewed seams", () => {
    const allowedImports = new Set([
      "main.tsx -> ./app.css",
      "onboarding-v2/agent-setup-page.tsx -> ./onboarding-v2.css",
      "onboarding-v2/page.tsx -> ./onboarding-v2.css",
      "setup/command-block.tsx -> ./setup.css",
      "setup/components.tsx -> ./setup.css",
      "app.css -> @fontsource/dm-sans/400.css",
      "app.css -> @fontsource/dm-sans/500.css",
      "app.css -> @fontsource/dm-sans/600.css",
      "app.css -> @fontsource/sora/600.css",
      "app.css -> @fontsource/sora/700.css",
      "app.css -> @cloudflare/kumo/styles/tailwind",
      "app.css -> tailwindcss",
      "app.css -> ./ui/kumo-theme.css",
      "app.css -> ./ui/typography.css",
    ]);
    const moduleImports = productModules.flatMap(({ imports, path }) =>
      imports.filter(isStylesheetSpecifier).map((specifier) => `${path} -> ${specifier}`),
    );
    const cssImports = stylesheets.flatMap(({ content, path }) =>
      stylesheetImportSpecifiers(content, path).map((specifier) => `${path} -> ${specifier}`),
    );
    const violations = [...moduleImports, ...cssImports].filter((entry) => !allowedImports.has(entry));

    expect(violations).toEqual([]);
  });

  it("keeps raw colors at the theme seam or an explicitly reviewed module stylesheet", () => {
    const allowedFiles = new Set(["app.css", "setup/setup.css", "ui/kumo-theme.css", "ui/kumo-theme.tokens.ts"]);
    const violations = [...productModules, ...stylesheets]
      .filter(({ content }) => hasRawColorLiteral(content))
      .map(({ path }) => path)
      .filter((path) => !allowedFiles.has(path));

    expect(violations).toEqual([]);
  });

  it("recognizes alternate module, stylesheet, and color syntax before enforcing seams", () => {
    expect(
      moduleSpecifiers(`
        export type { ButtonProps } from "@cloudflare/kumo";
        const loadKumo = () => import("@cloudflare/kumo");
        import styles from "./feature.css?inline";
      `),
    ).toEqual(["@cloudflare/kumo", "@cloudflare/kumo", "./feature.css?inline"]);
    expect(stylesheetImportSpecifiers('@import url("./feature.css") layer(feature);')).toEqual(["./feature.css"]);
    expect(isStylesheetSpecifier("./feature.css?inline")).toBe(true);
    expect(hasRawColorLiteral("color: rgb(1 2 3)")).toBe(true);
    expect(hasRawColorLiteral("color: oklch(50% .2 120)")).toBe(true);
    expect(hasRawColorLiteral("color: var(--text-color); background: color-mix(in srgb, var(--a), var(--b))")).toBe(
      false,
    );
  });

  it("uses the Kumo compound sidebar layout for the application shell", () => {
    const shell = ["app-shell.tsx", "agent-shell.tsx", "shell-main.tsx"]
      .map((file) => readFileSync(resolve(root, "features/shell", file), "utf8"))
      .join("\n");
    expect(shell).toContain('<Sidebar.Header className="border-b-0">');
    expect(shell).toMatch(/<Sidebar\.Content(?:\s|>)/);
    expect(shell).toContain("<Sidebar.Menu>");
    expect(shell).toContain("<Sidebar.MenuButton");
    expect(shell).toContain("<Sidebar.Footer>");
    expect(shell).toContain("<DropdownMenu.LinkItem");
    expect(shell).toContain("<DropdownMenu.Separator />");
    expect(shell).toContain("selected={candidate.id === agent?.id}");
    expect(shell).toContain('className="flex w-8 shrink-0 items-center justify-center"');
    expect(shell).not.toContain("accountMenuRef");
    expect(shell).not.toContain("<Sidebar.Rail />");
    expect(shell).toContain('collapsible={isMobileAgentShell ? "icon" : "none"}');
    expect(shell).toContain('variant="floating"');
    expect(shell).toContain('<Sidebar.Close className="sm:hidden" />');
    expect(shell).toContain('className="app-mobile-header');
    expect(shell).toContain('className="h-full min-h-0 overflow-hidden bg-kumo-canvas"');
    expect(shell).toContain('className="flex h-full min-h-0 min-w-0 flex-1 bg-kumo-canvas"');
    expect(shell).toContain(
      'className="bg-kumo-canvas md:m-2 md:mr-0 md:h-[calc(100%-1rem)] md:rounded-lg md:shadow-xs"',
    );
    expect(shell).toContain('className="flex min-h-0 min-w-0 flex-1 flex-col bg-kumo-canvas md:ml-2"');
    expect(shell).toContain("min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto");
    expect(shell).toContain(
      'className="@container/content mx-auto w-full min-w-0 max-w-5xl" data-ui="content-page-frame"',
    );
    expect(shell).not.toContain('data-ui="sidebar-content"');
  });

  it("uses the owned Kumo PageHeader block and semantic Text variants", () => {
    const pageHeader = readFileSync(resolve(root, "components/kumo/page-header/page-header.tsx"), "utf8");
    // Pages import the block from their own depth, so the contract is on the specifier's tail.
    expect(source).toContain("components/kumo/page-header/page-header.js");
    expect(pageHeader).toContain('from "@cloudflare/kumo"');
    expect(pageHeader).toContain('<Text as="h1" id={titleId} size="lg" variant="heading">');
    expect(pageHeader).toContain('<Text as="p" variant="secondary">');
    expect(source).not.toMatch(/<h[1-6]\b/);
  });

  it("keeps native interactive controls limited to browser file and hidden inputs", () => {
    expect(source).not.toMatch(/<(?:button|select|textarea|details)\b/);
    const nativeInputs = source.match(/<input\b[^>]*>/gs) ?? [];
    expect(nativeInputs.every((input) => /type=(?:"(?:file|hidden)"|\{["'](?:file|hidden)["']\})/.test(input))).toBe(
      true,
    );
  });

  it("keeps application CSS to the root and accessibility boundary", () => {
    expect(appCss).not.toMatch(/\[data-ui=|\b(?:button|input|textarea|select|h1|h2|h3)\b/);
  });
});
