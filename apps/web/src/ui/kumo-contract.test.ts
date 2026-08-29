import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceFiles = readdirSync(root, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith(".tsx") && !entry.name.includes(".test."))
  .map((entry) => resolve(entry.parentPath, entry.name));
const source = sourceFiles.map((file) => readFileSync(resolve(root, file), "utf8")).join("\n");

/*
 * Standalone Kumo ships a fixed stylesheet; nothing regenerates utilities from page source. A class
 * that is not in it does nothing at all, silently, which is how a 956px icon and a one-column grid
 * shipped past a green type-check and suite. These families are the ones whose absence rearranges a
 * page rather than tweaking it.
 */
const layoutUtility = /\b(?:(?:sm|md|lg|xl):)?(?:size|grid-cols|col-span|justify-self)-[a-z0-9.]+\b/g;
const kumoStylesheet = readFileSync(
  resolve(root, "..", "node_modules", "@cloudflare", "kumo", "dist", "styles", "kumo-standalone.css"),
  "utf8",
);

function classNameLiterals(text: string): string[] {
  return [...text.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)].flatMap((match) =>
    (match[1] ?? match[2] ?? "").split(/\s+/),
  );
}

describe("Kumo integration contract", () => {
  it("only uses layout utilities the shipped stylesheet defines", () => {
    const used = new Set(
      classNameLiterals(source).flatMap((token) => [...token.matchAll(layoutUtility)].map((match) => match[0])),
    );
    const missing = [...used].filter((utility) => !kumoStylesheet.includes(`.${utility.replace(/([:.])/g, "\\$1")}`));
    expect(missing).toEqual([]);
  });

  it("loads standalone styles once and keeps application styles local", () => {
    expect(source.match(/@cloudflare\/kumo\/styles\/standalone/g)?.length).toBe(1);
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
    const router = readFileSync(resolve(root, "router.tsx"), "utf8");
    expect(router).toContain("<Sidebar.Header>");
    expect(router).toContain("<Sidebar.Content>");
    expect(router).toContain("<Sidebar.Menu>");
    expect(router).toContain("<Sidebar.MenuButton");
    expect(router).toContain("<Sidebar.Footer>");
    expect(router).toContain('<Sidebar.Trigger title="Toggle sidebar"');
    expect(router).toContain('collapsible="icon"');
    expect(router).toContain("group-data-[state=collapsed]/sidebar:hidden");
    expect(router).toContain('className="app-mobile-header');
    expect(router).toContain('className="h-full min-h-0 overflow-hidden"');
    expect(router).toContain('className="flex h-full min-h-0 min-w-0 flex-1 bg-kumo-canvas"');
    expect(router).toContain("min-h-0 min-w-0 flex-1 overflow-x-auto overflow-y-auto");
    expect(router).not.toContain("max-w-6xl");
    expect(router).not.toContain('data-ui="sidebar-content"');
  });

  it("uses the owned Kumo PageHeader block and semantic Text variants", () => {
    const router = readFileSync(resolve(root, "router.tsx"), "utf8");
    const pageHeader = readFileSync(resolve(root, "components/kumo/page-header/page-header.tsx"), "utf8");
    expect(router).toContain('"./components/kumo/page-header/page-header.js"');
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
    const css = readFileSync(resolve(root, "app.css"), "utf8");
    expect(css).not.toMatch(/\[data-ui=|\b(?:button|input|textarea|select|h1|h2|h3)\b/);
  });
});
