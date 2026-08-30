import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceFiles = readdirSync(root, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith(".tsx") && !entry.name.includes(".test."))
  .map((entry) => resolve(entry.parentPath, entry.name));
const source = sourceFiles.map((file) => readFileSync(resolve(root, file), "utf8")).join("\n");
const appCss = readFileSync(resolve(root, "app.css"), "utf8");
const main = readFileSync(resolve(root, "main.tsx"), "utf8");
const viteConfig = readFileSync(resolve(root, "..", "vite.config.ts"), "utf8");

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

  it("uses the semantic adapter and real Kumo controls", () => {
    const adapter = readFileSync(resolve(root, "ui/design-system.tsx"), "utf8");
    expect(adapter).toContain("@cloudflare/kumo");
    expect(adapter).toContain("KumoSelect.Option");
    expect(adapter).toContain("Dialog.Root");
    expect(adapter).toContain("onOpenChange");
    expect(adapter).toContain("@phosphor-icons/react");
    expect(source).not.toMatch(/data-kumo-component|kumo-select/);
  });

  it("uses the Kumo compound sidebar layout for the application shell", () => {
    const shell = readFileSync(resolve(root, "features/shell/app-shell.tsx"), "utf8");
    expect(shell).toContain("<Sidebar.Header>");
    expect(shell).toContain("<Sidebar.Content>");
    expect(shell).toContain("<Sidebar.Menu>");
    expect(shell).toContain("<Sidebar.MenuButton");
    expect(shell).toContain("<Sidebar.Footer>");
    expect(shell).toContain('<Sidebar.Trigger title="Toggle sidebar"');
    expect(shell).toContain('collapsible="icon"');
    expect(shell).toContain("group-data-[state=collapsed]/sidebar:hidden");
    expect(shell).toContain('className="app-mobile-header');
    expect(shell).toContain('className="h-full min-h-0 overflow-hidden"');
    expect(shell).toContain('className="flex h-full min-h-0 min-w-0 flex-1 bg-kumo-canvas"');
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
