import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import postcss, { type Root } from "postcss";
import { describe, expect, it } from "vitest";

function locateStylesheet(relativePath: string): string {
  for (const candidate of [relativePath, `apps/web/${relativePath}`]) {
    const path = resolve(process.cwd(), candidate);
    if (existsSync(path)) return path;
  }
  throw new Error(`The Web stylesheet ${relativePath} was not found from ${process.cwd()}`);
}

function declarationValue(stylesheet: Root, selector: string, property: string): string {
  let value: string | undefined;
  stylesheet.walkRules((rule) => {
    if (!rule.selectors.includes(selector)) return;
    rule.walkDecls(property, (declaration) => {
      value = declaration.value;
    });
  });
  if (!value) throw new Error(`Missing ${property} declaration for ${selector}`);
  return value;
}

function topLevelDeclarationValue(stylesheet: Root, selector: string, property: string): string {
  let value: string | undefined;
  stylesheet.walkRules((rule) => {
    if (rule.parent?.type !== "root" || !rule.selectors.includes(selector)) return;
    rule.walkDecls(property, (declaration) => {
      value = declaration.value;
    });
  });
  if (!value) throw new Error(`Missing top-level ${property} declaration for ${selector}`);
  return value;
}

const appStyles = postcss.parse(readFileSync(locateStylesheet("src/styles.css"), "utf8"));
const designSystemStyles = postcss.parse(readFileSync(locateStylesheet("src/ui/design-system.css"), "utf8"));
const capabilityStyles = postcss.parse(readFileSync(locateStylesheet("src/mock-pages.css"), "utf8"));

describe("workspace page layout", () => {
  it("uses one 1024px frame with a 960px visible content contract", () => {
    expect(declarationValue(appStyles, ":root", "--workspace-page-frame")).toBe("1024px");
    expect(declarationValue(appStyles, ":root", "--workspace-page-gutter")).toBe("32px");
    expect(declarationValue(appStyles, ":root", "--workspace-page-width")).toBe("960px");
    expect(declarationValue(appStyles, ".page", "width")).toBe("min(100%, var(--workspace-page-frame))");
    expect(declarationValue(appStyles, ".object-page", "width")).toBe("min(100%, var(--workspace-page-frame))");
    expect(declarationValue(appStyles, ".settings-page", "width")).toBe("min(100%, var(--workspace-page-frame))");
    expect(declarationValue(capabilityStyles, ".capability-page", "width")).toBe(
      "min(100%, var(--workspace-page-frame, 1024px))",
    );
    expect(topLevelDeclarationValue(capabilityStyles, ".capability-page", "padding-inline")).toBe(
      "var(--workspace-page-gutter, 32px)",
    );
  });

  it("lets list-heavy Agent and Member sections use the shared page width", () => {
    expect(declarationValue(appStyles, ".agent-list-section", "width")).toBe("100%");
    expect(declarationValue(appStyles, ".settings-members-section", "width")).toBe("100%");
    expect(declarationValue(appStyles, ".settings-members-section .settings-invitation-panel", "width")).toBe("100%");
  });

  it("does not introduce nested page-level width contracts", () => {
    expect(declarationValue(appStyles, ".object-content", "width")).toBe("100%");
    expect(declarationValue(appStyles, ".settings-content", "width")).toBe("100%");
    expect(declarationValue(appStyles, ".overview-section", "width")).toBe("100%");
    expect(declarationValue(appStyles, ".settings-profile-form", "width")).toBe("100%");
    expect(declarationValue(appStyles, ".settings-list-section", "width")).toBe("100%");
  });

  it("centralizes tab and settings-row geometry in the design system", () => {
    expect(declarationValue(designSystemStyles, ".ds-tabs", "gap")).toBe("var(--space-8)");
    expect(declarationValue(designSystemStyles, ".ds-tabs", "border-bottom")).toBe(
      "1px solid var(--color-border-divider)",
    );
    expect(declarationValue(designSystemStyles, ".ds-settings-list", "border-radius")).toBe("var(--radius-panel)");
    expect(declarationValue(designSystemStyles, ".ds-settings-row", "padding")).toBe("var(--space-6)");
    expect(declarationValue(designSystemStyles, "select.ds-control--compact", "min-height")).toBe("36px");
  });
});
